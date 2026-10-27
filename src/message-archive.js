const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { conversationKey, clip } = require("./persistent-state");
const { scoreImportance, memoryStrength } = require("./memory-policy");

function searchTerms(text) {
  const terms = new Set();
  for (const word of String(text || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    terms.add(word);
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      for (let width = 1; width <= 3; width++) {
        for (let i = 0; i + width <= chars.length; i++) terms.add(chars.slice(i, i + width).join(""));
      }
    }
  }
  return [...terms].slice(0, 4096);
}

function normalizeVector(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error("Invalid embedding");
  const vector = Float32Array.from(value);
  if (!vector.length || vector.length > 8192 || !vector.every(Number.isFinite)) throw new Error("Invalid embedding");
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error("Empty embedding");
  return vector.map(x => x / norm);
}

function reciprocalRankFusion(lists, limit = 8) {
  const fused = new Map();
  for (const list of lists) list.forEach((row, index) => {
    const current = fused.get(row.id) || { ...row, score: 0 };
    current.score += 1 / (60 + index + 1);
    fused.set(row.id, current);
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, limit);
}

function createEmbeddingEncoder(config, fetchImpl = globalThis.fetch) {
  if (!config.memoryEmbeddingUrl) return null;
  const endpoint = new URL(config.memoryEmbeddingUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid embedding endpoint");
  return async (texts, { query = false } = {}) => {
    const response = await fetchImpl(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json",
        ...(config.memoryEmbeddingApiKey ? { Authorization: `Bearer ${config.memoryEmbeddingApiKey}` } : {}) },
      signal: AbortSignal.timeout(config.memoryEmbeddingTimeoutMs || 10000),
      body: JSON.stringify({ model: config.memoryEmbeddingModel || "bge-small-zh-v1.5",
        input: texts.map(text => query ? `为这个句子生成表示以用于检索相关文章：${text}` : text) }),
    });
    if (!response.ok) throw new Error("Embedding service unavailable");
    const payload = await response.json();
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error("Invalid embedding response");
    const data = [...payload.data].sort((a, b) => a.index - b.index);
    if (data.some((item, i) => item.index !== i)) throw new Error("Invalid embedding indices");
    return data.map(item => normalizeVector(item.embedding));
  };
}

class MessageArchive {
  constructor(file, options = {}) {
    this.logger = options.logger || console;
    this.encode = options.encode || null;
    this.model = options.model || "bge-small-zh-v1.5";
    this.closed = false;
    this.running = null;
    this.timer = null;
    this.retryAt = 0;
    this.now = options.now || Date.now;
    this.importantUsers = new Set(options.importantUserIds || []);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY, key TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
          message_id TEXT NOT NULL, sender TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
          is_self INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, search_text TEXT NOT NULL,
          ts INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(key, message_id));
        CREATE INDEX IF NOT EXISTS messages_scope_time ON messages(key, ts);
        CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(search_text, content='messages', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS messages_insert AFTER INSERT ON messages BEGIN
          INSERT INTO msg_fts(rowid, search_text) VALUES(new.id, new.search_text); END;
        CREATE TRIGGER IF NOT EXISTS messages_update AFTER UPDATE OF text ON messages BEGIN
          INSERT INTO msg_fts(msg_fts,rowid,search_text) VALUES('delete',old.id,old.search_text);
          INSERT INTO msg_fts(rowid,search_text) VALUES(new.id,new.search_text);
          DELETE FROM msg_vec WHERE msg_id=new.id; END;
        CREATE TABLE IF NOT EXISTS msg_vec (
          msg_id INTEGER PRIMARY KEY, key TEXT NOT NULL, dim INTEGER NOT NULL,
          model TEXT NOT NULL, vec BLOB NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_events (
          id INTEGER PRIMARY KEY, key TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL,
          search_text TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(key,user_id,text));`);
      const columns = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map(column => column.name));
      for (const [name, sql] of [["importance", "REAL DEFAULT -1"], ["strength", "REAL DEFAULT 0.35"],
        ["faded", "INTEGER DEFAULT 0"], ["recalls", "INTEGER DEFAULT 0"], ["last_recall_at", "INTEGER DEFAULT 0"]]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${sql}`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS messages_memory ON messages(key,faded,importance DESC)");
      this.backfillImportance();
    } catch (error) { this.db.close(); throw error; }
    this.scheduleIndex();
    this.decayTimer = setInterval(() => { try { this.decayTick(); } catch { this.logger.warn("[memory] decay deferred; archive unchanged"); } }, 86400000);
    this.decayTimer.unref?.();
    this.decayTick();
  }

  upsert(key, message) {
    if (this.closed) return;
    conversationKey(key);
    const text = clip(message.text || (message.images?.length ? "[图片]" : "[非文字消息]"), 32000);
    const id = String(message.messageId || createHash("sha256").update(JSON.stringify([message.timestamp, message.userId, message.role, text])).digest("hex"));
    const importance = scoreImportance({ text, isSelf: message.role === "assistant", isImportantUser: this.importantUsers.has(String(message.userId)) });
    this.db.prepare(`INSERT INTO messages(key,seq,message_id,sender,user_id,is_self,text,search_text,ts,created_at,importance,strength)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key,message_id) DO UPDATE SET
      sender=excluded.sender,user_id=excluded.user_id,is_self=excluded.is_self,text=excluded.text,search_text=excluded.search_text,
      importance=excluded.importance,strength=MAX(messages.strength,excluded.strength)
      WHERE messages.text<>excluded.text OR messages.sender<>excluded.sender OR messages.user_id<>excluded.user_id OR messages.is_self<>excluded.is_self`)
      .run(key, message.seq || 0, id, clip(message.senderName, 80), String(message.userId || ""),
        message.role === "assistant" ? 1 : 0, text, searchTerms(text).join(" "), Math.trunc(message.timestamp ?? this.now()), this.now(), importance, importance);
    this.scheduleIndex();
  }

  scheduleIndex(delay = 25) {
    if (!this.encode || this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.indexBatch().catch(() => {
        this.retryAt = Date.now() + 60000;
        this.logger.warn("[memory] embedding failed; keyword search remains available");
      }).finally(() => {
        this.running = null;
        if (this.pendingCount()) this.scheduleIndex(Math.max(25, this.retryAt - Date.now()));
      });
    }, delay);
    this.timer.unref?.();
  }

  pendingCount() {
    if (this.closed || !this.encode) return 0;
    return this.db.prepare("SELECT count(*) AS n FROM messages m LEFT JOIN msg_vec v ON m.id=v.msg_id AND v.model=? WHERE v.msg_id IS NULL").get(this.model).n;
  }

  async indexBatch() {
    const rows = this.db.prepare("SELECT m.id,m.key,m.text FROM messages m LEFT JOIN msg_vec v ON m.id=v.msg_id AND v.model=? WHERE v.msg_id IS NULL ORDER BY m.id LIMIT 16").all(this.model);
    if (!rows.length) return;
    const vectors = await this.encode(rows.map(row => clip(row.text, 1000)));
    if (this.closed) return;
    if (vectors.length !== rows.length) throw new Error("Invalid embedding count");
    rows.forEach((row, i) => {
      const vector = normalizeVector(vectors[i]);
      // A reply may have been enriched while the asynchronous encoder ran.
      this.db.prepare(`INSERT OR REPLACE INTO msg_vec(msg_id,key,dim,model,vec,created_at)
        SELECT id,key,?,?,?,? FROM messages WHERE id=? AND text=?`)
        .run(vector.length, this.model, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), Date.now(), row.id, row.text);
    });
    this.retryAt = 0;
  }

  async search(key, query, options = {}) {
    conversationKey(key);
    if (this.closed) return [];
    const terms = searchTerms(clip(query, 200)).filter(term => Array.from(term).length >= 2).slice(0, 32);
    const ignored = options.excludedUserIds || [];
    const exclude = ignored.length ? ` AND (m.is_self=1 OR m.user_id NOT IN (${ignored.map(() => "?").join(",")}))` : "";
    let keyword = [];
    if (terms.length) {
      const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(" OR ");
      keyword = this.db.prepare(`SELECT m.* FROM msg_fts JOIN messages m ON m.id=msg_fts.rowid
        WHERE msg_fts MATCH ? AND m.key=?${exclude} ORDER BY bm25(msg_fts),m.ts DESC LIMIT 40`).all(match, key, ...ignored);
    }
    // LIKE also handles one-character queries, substrings, and literal FTS syntax.
    const literal = clip(query, 200).trim();
    if (literal) {
      const exact = this.db.prepare(`SELECT m.* FROM messages m WHERE m.key=? AND m.text LIKE ? ESCAPE '\\'${exclude} ORDER BY m.ts DESC LIMIT 40`)
        .all(key, `%${literal.replace(/[\\%_]/g, "\\$&")}%`, ...ignored);
      keyword = [...new Map([...exact, ...keyword].map(row => [row.id, row])).values()];
    }
    let semantic = [];
    if (this.encode && literal) {
      try {
        const [queryVector] = await this.encode([literal], { query: true });
        const normalized = normalizeVector(queryVector);
        const candidates = this.db.prepare(`SELECT m.*,v.dim,v.vec FROM msg_vec v JOIN messages m ON m.id=v.msg_id
          WHERE m.key=? AND v.model=? AND v.dim=?${exclude}`).iterate(key, this.model, normalized.length, ...ignored);
        // Stream the complete scoped index; retain only the best 40 vectors.
        for (const row of candidates) {
          const bytes = Buffer.from(row.vec);
          if (bytes.length !== row.dim * 4) continue;
          let similarity = 0;
          for (let i = 0; i < normalized.length; i++) similarity += normalized[i] * bytes.readFloatLE(i * 4);
          if (similarity < 0.45) continue;
          delete row.vec;
          semantic.push({ ...row, similarity });
          semantic.sort((a, b) => b.similarity - a.similarity);
          if (semantic.length > 40) semantic.pop();
        }
      } catch { this.logger.warn("[memory] semantic query failed; using keyword results"); }
    }
    const hits = reciprocalRankFusion([keyword, semantic], Math.max(1, Math.min(20, options.limit || 8)));
    this.markRecall(hits.map(row => row.id));
    const results = hits
      .map(row => ({ id: row.id, messageId: row.message_id, sender: row.sender, userId: row.user_id,
        role: row.is_self ? "assistant" : "user", text: clip(row.text, 800), timestamp: row.ts, score: row.score }));
    if (literal && results.length < (options.limit || 8)) {
      const events = this.db.prepare("SELECT * FROM memory_events WHERE key=? ORDER BY ts DESC").all(key)
        .filter(event => !ignored.includes(event.user_id) && (event.text.includes(literal) || searchTerms(event.text).some(term => term.length >= 2 && terms.includes(term))))
        .slice(0, (options.limit || 8) - results.length);
      results.push(...events.map(event => ({ id: `event-${event.id}`, type: "archived_impression", role: "memory",
        userId: event.user_id, text: clip(event.text, 800), timestamp: event.ts })));
    }
    return results;
  }

  backfillImportance() {
    const rows = this.db.prepare("SELECT id,text,is_self,user_id FROM messages WHERE importance=-1").all();
    if (!rows.length) return;
    this.db.exec("BEGIN");
    try {
      const update = this.db.prepare("UPDATE messages SET importance=?,strength=? WHERE id=?");
      for (const row of rows) {
        const score = scoreImportance({ text: row.text, isSelf: Boolean(row.is_self), isImportantUser: this.importantUsers.has(row.user_id) });
        update.run(score, score, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  decayTick() {
    const rows = this.db.prepare("SELECT id,ts,importance,recalls,last_recall_at FROM messages").all();
    this.db.exec("BEGIN");
    try {
      const update = this.db.prepare("UPDATE messages SET strength=?,faded=? WHERE id=?");
      for (const row of rows) {
        const state = memoryStrength(row, this.now());
        update.run(state.strength, state.faded, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  markRecall(ids) {
    const update = this.db.prepare(`UPDATE messages SET recalls=MIN(20,recalls+1),last_recall_at=?,strength=MIN(1,strength+0.12),faded=0
      WHERE id=? AND (last_recall_at=0 OR last_recall_at<=?)`);
    for (const id of new Set(ids)) update.run(this.now(), id, this.now() - 3600000);
  }

  topMemories(key, options = {}) {
    conversationKey(key);
    const ignored = options.excludedUserIds || [];
    const excludedIds = new Set(options.excludedMessageIds || []);
    return this.db.prepare(`SELECT id,message_id,sender,user_id,is_self,text,ts,importance,strength FROM messages
      WHERE key=? AND ts<? AND faded=0 AND importance>=? ORDER BY importance*strength DESC,ts DESC LIMIT 60`)
      .all(key, this.now() - 12 * 3600000, options.minImportance ?? 0.45)
      .filter(row => !ignored.includes(row.user_id) && !excludedIds.has(row.message_id)).slice(0, options.limit || 5)
      .map(row => ({ sender: row.sender, role: row.is_self ? "assistant" : "user", text: clip(row.text, 240), timestamp: row.ts }));
  }

  archiveImpression(key, userId, text) {
    conversationKey(key);
    this.db.prepare("INSERT OR IGNORE INTO memory_events(key,user_id,text,search_text,ts) VALUES(?,?,?,?,?)")
      .run(key, String(userId), clip(text, 600), searchTerms(text).join(" "), this.now());
  }

  async flush() { if (this.running) await this.running; }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.decayTimer);
    await this.flush();
    this.db.close();
  }
}

module.exports = { MessageArchive, createEmbeddingEncoder, searchTerms, normalizeVector, reciprocalRankFusion };
