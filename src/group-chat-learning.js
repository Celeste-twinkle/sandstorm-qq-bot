const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { selectRecentGroupMessages } = require("./group-context");
const { DEFAULT_GROUP_CHAT_LEARNING_PROMPT, LEARNED_GROUP_STYLE_GUIDANCE } = require("./group-chat-learning-prompt");
const { validateSlang, parseSlangResult, SLANG_LEARNING_PROMPT } = require("./group-slang");

const SCHEMA_VERSION = 2;
const MAX_RULES = 12;
const MAX_RULE_CHARS = 180;
const MAX_PROFILE_CHARS = 1800;
const forbiddenHint = /(?:忽略|覆盖|绕过).{0,12}(?:规则|指令|人格|system)|\b(?:system|developer|api_key)\b|密钥|执行命令|读取文件|写入文件|自动关机|你叫|你是|\[CQ:/i;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (value, limit) => Array.from(String(value || "")).slice(0, limit).join("");

function resolveGroupChatLearningDir(configured = "") {
  const base = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
  return path.resolve(base, String(configured || "").trim() || "data/group-chat-learning");
}

function normalizeGroupId(value) {
  const groupId = String(value || "").trim();
  if (!/^\d{1,20}$/.test(groupId)) throw new Error("Invalid learning group ID");
  return groupId;
}

function prepareLearningRecords(context) {
  const speakers = new Map();
  return selectRecentGroupMessages(context, 50).map((message, index) => {
    const key = String(message.userId || message.senderName || "unknown");
    if (message.role !== "assistant" && !speakers.has(key)) speakers.set(key, `member${speakers.size + 1}`);
    return { id: `m${index + 1}`, role: message.role === "assistant" ? "assistant" : "user",
      speaker: message.role === "assistant" ? "bot" : speakers.get(key),
      text: clip(message.text || (message.images?.length ? "[图片，未读取画面]" : "[非文字消息]"), 600) };
  });
}

function validateRules(rules, allowPreviousEvidence = false) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error("Invalid learning rules");
  let characters = 0;
  return rules.map(rule => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        Object.keys(rule).sort().join(",") !== "evidence,text" || typeof rule.text !== "string") throw new Error("Invalid learning rule schema");
    const text = rule.text.trim();
    const count = Array.from(text).length;
    characters += count;
    if (!count || count > MAX_RULE_CHARS || characters > MAX_PROFILE_CHARS || forbiddenHint.test(text) ||
        !Array.isArray(rule.evidence) || !rule.evidence.length || rule.evidence.length > 8 ||
        !rule.evidence.every(id => typeof id === "string" && (/^m(?:[1-9]|[1-4]\d|50)$/.test(id) ||
          (allowPreviousEvidence && /^p(?:[1-9]|1[0-2])$/.test(id))))) throw new Error("Invalid learning rule content");
    return { text, evidence: [...new Set(rule.evidence)] };
  });
}

function parseLearningResult(text, context, previous = []) {
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || !Object.hasOwn(parsed, "rules") ||
      Object.keys(parsed).some(key => !["rules", "slang"].includes(key))) throw new Error("Invalid learning result schema");
  const records = new Map(prepareLearningRecords(context).map(record => [record.id, record]));
  const prior = new Map(validateRules(previous).map((rule, index) => [`p${index + 1}`, rule]));
  return validateRules(parsed.rules, true).map(rule => {
    const currentEvidence = rule.evidence.filter(id => id.startsWith("m"));
    const priorEvidence = rule.evidence.filter(id => id.startsWith("p"));
    if (!currentEvidence.every(id => records.has(id)) || !priorEvidence.every(id => prior.has(id))) {
      throw new Error("Learning rule cites unknown evidence");
    }
    if (currentEvidence.some(id => records.get(id).role === "user")) {
      // Persist current human evidence, never ephemeral references to prior rules.
      return { text: rule.text, evidence: currentEvidence };
    }
    const retained = priorEvidence.map(id => prior.get(id)).find(old => old.text === rule.text);
    if (!retained) throw new Error("New or revised learning rule lacks human evidence");
    return { text: retained.text, evidence: [...retained.evidence] };
  });
}

function buildGroupLearningMessages(context, previous = [], slang = null) {
  const prompt = slang === null ? DEFAULT_GROUP_CHAT_LEARNING_PROMPT
    : DEFAULT_GROUP_CHAT_LEARNING_PROMPT.replace("输出JSON，唯一字段rules", "输出JSON，rules字段");
  return [{ role: "system", content: [prompt, slang === null ? "" : SLANG_LEARNING_PROMPT].filter(Boolean).join("\n\n") }, { role: "user", content: JSON.stringify({
    learning_module: { rules: validateRules(previous).map((rule, index) => ({ id: `p${index + 1}`, text: rule.text })),
      ...(slang === null ? {} : { slang: validateSlang(slang).map(({ term, meaning, usage, avoid, status }) => ({ term, meaning, usage, avoid, status })) }) },
    records: prepareLearningRecords(context),
  }) }];
}

function buildLearnedGroupStylePrompt(rules = []) {
  const validated = validateRules(rules);
  return validated.length ? `${LEARNED_GROUP_STYLE_GUIDANCE}\n${JSON.stringify({ learned_guidance: validated.map(rule => rule.text) })}` : "";
}

class GroupChatLearning {
  constructor(config = {}, options = {}) {
    this.enabled = config.groupChatLearningEnabled !== false;
    this.slangEnabled = config.groupSlangEnabled === true;
    this.directory = resolveGroupChatLearningDir(config.groupChatLearningDir);
    this.minimum = config.groupChatLearningMinMessages ?? 20;
    this.every = config.groupChatLearningEveryMessages ?? 30;
    this.intervalMs = config.groupChatLearningMinIntervalMs ?? 600000;
    this.learn = options.learn;
    this.now = options.now || Date.now;
    this.logger = options.logger || console;
    this.excludedUsers = options.excludedUsers || (() => []);
    this.states = new Map();
    this.queue = new Set();
    this.running = null;
    this.closed = false;
    this.sequence = 0;
  }

  state(group) {
    const groupId = normalizeGroupId(group);
    if (this.states.has(groupId)) return this.states.get(groupId);
    const file = path.join(this.directory, `${groupId}.json`);
    let record = { schemaVersion: SCHEMA_VERSION, groupId, revision: 0, learnedAt: null, rules: [], slang: [] };
    let blocked = false;
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      if (![1, SCHEMA_VERSION].includes(stored.schemaVersion) || stored.groupId !== groupId ||
          !Number.isInteger(stored.revision) || stored.revision < 0 ||
          (stored.learnedAt !== null && !Number.isFinite(Date.parse(stored.learnedAt)))) throw new Error("Invalid learning file");
      record = { ...stored, schemaVersion: SCHEMA_VERSION, rules: validateRules(stored.rules), slang: validateSlang(stored.slang || []) };
    } catch (error) {
      if (error.code !== "ENOENT") {
        blocked = true;
        this.logger.warn(`[learning] invalid file for group=${groupId}; using default style until reset`);
      }
    }
    const state = { groupId, file, record, blocked, seen: new Set(), pendingHumans: 0, snapshot: [], epoch: 0,
      lastAttemptAt: record.learnedAt ? Date.parse(record.learnedAt) : -Infinity, learning: false,
      writeChain: Promise.resolve(), initialized: fs.existsSync(file) };
    this.states.set(groupId, state);
    return state;
  }

  getRules(group) {
    if (!this.enabled) return [];
    return this.state(group).record.rules.map(rule => ({ text: rule.text, evidence: [...rule.evidence] }));
  }

  getStatus(group) {
    const state = this.state(group);
    return { enabled: this.enabled, revision: state.record.revision, rules: this.getRules(group),
      slang: this.getSlang(group), learnedAt: state.record.learnedAt, blocked: state.blocked, learning: state.learning };
  }

  getSlang(group) {
    if (!this.enabled || !this.slangEnabled) return [];
    const ignored = new Set(this.excludedUsers(String(group)).map(String));
    return structuredClone(this.state(group).record.slang || []).map(item => {
      item.sources = item.sources.filter(source => !ignored.has(source.userId));
      const explicit = item.sources.some(source => /意思是|是指|指的是|等于|这里叫|我们叫|学黑话|[=＝]/u.test(source.example));
      if (!explicit && new Set(item.sources.map(source => source.userId)).size < 2) item.status = "candidate";
      return item;
    }).filter(item => item.sources.length);
  }

  async teachSlang(group, entry, message) {
    if (!this.enabled || !this.slangEnabled) throw new Error("Slang learning disabled");
    const state = this.state(group);
    if (state.blocked) throw new Error("Learning file is read only");
    const slang = parseSlangResult([{ ...entry, confidence: 1, evidence: ["m1"] }],
      [{ ...message, role: "user", text: message.text || `学黑话 ${entry.term}=${entry.meaning}；${entry.usage}` }], state.record.slang, this.now());
    state.epoch++;
    this.queue.delete(state);
    const record = { ...state.record, schemaVersion: SCHEMA_VERSION, slang, revision: state.record.revision + 1, learnedAt: new Date(this.now()).toISOString() };
    await this.write(state, record);
    state.record = record;
  }

  observe(group, context) {
    if (!this.enabled || this.closed) return;
    const state = this.state(group);
    if (state.blocked) return;
    const selected = selectRecentGroupMessages(context, 50);
    state.snapshot = selected.map(message => ({ ...message }));
    for (const message of selected.filter(message => message.role === "user")) {
      const key = String(message.messageId || digest([message.timestamp, message.userId, message.text]));
      if (!state.seen.has(key)) { state.seen.add(key); state.pendingHumans++; }
    }
    while (state.seen.size > 150) state.seen.delete(state.seen.values().next().value);
    if (!state.initialized) {
      state.initialized = true;
      this.write(state, state.record).catch(() => this.logger.warn(`[learning] file creation failed group=${state.groupId}`));
    }
    this.enqueueIfDue(state);
    this.pump();
  }

  enqueueIfDue(state) {
    const threshold = state.record.revision ? this.every : this.minimum;
    if (!this.closed && !state.blocked && !state.learning && typeof this.learn === "function" &&
        state.pendingHumans >= threshold && state.snapshot.filter(message => message.role === "user").length >= this.minimum &&
        this.now() - state.lastAttemptAt >= this.intervalMs) this.queue.add(state);
  }

  pump() {
    if (this.running || this.closed || !this.queue.size) return;
    const state = this.queue.values().next().value;
    this.queue.delete(state);
    const context = state.snapshot.map(message => ({ ...message }));
    const previous = this.getRules(state.groupId);
    const previousSlang = structuredClone(state.record.slang || []);
    const epoch = state.epoch;
    state.pendingHumans = 0;
    state.lastAttemptAt = this.now();
    state.learning = true;
    this.running = Promise.resolve().then(() => this.closed || epoch !== state.epoch
      ? null : this.learn(context, previous, this.slangEnabled ? previousSlang : null)).then(async text => {
      if (this.closed || epoch !== state.epoch) return;
      const rules = parseLearningResult(text, context, previous);
      const slang = this.slangEnabled ? parseSlangResult(JSON.parse(text).slang, context, previousSlang, this.now()) : previousSlang;
      if (this.closed || epoch !== state.epoch) return;
      const record = { schemaVersion: SCHEMA_VERSION, groupId: state.groupId, revision: state.record.revision + 1,
        learnedAt: new Date(this.now()).toISOString(), rules, slang,
        source: { hash: digest(prepareLearningRecords(context)), messages: context.length,
          humanMessages: context.filter(message => message.role === "user").length } };
      // Publish only after the atomic write succeeds; failed learning keeps the old profile.
      await this.write(state, record);
      if (!this.closed && epoch === state.epoch) state.record = record;
      this.logger.info(`[learning] updated group=${state.groupId} revision=${record.revision} rules=${record.rules.length}`);
    }).catch(() => this.logger.warn(`[learning] update failed group=${state.groupId}; keeping previous style`)).finally(() => {
      state.learning = false;
      this.running = null;
      this.enqueueIfDue(state);
      this.pump();
    });
  }

  write(state, record) {
    const contents = JSON.stringify(record, null, 2) + "\n";
    const temporary = `${state.file}.${process.pid}.${++this.sequence}.tmp`;
    const operation = state.writeChain.catch(() => undefined).then(async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      try {
        await fs.promises.writeFile(temporary, contents, "utf8");
        await fs.promises.rename(temporary, state.file);
      } finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); }
    });
    state.writeChain = operation;
    return operation;
  }

  async reset(group) {
    const state = this.state(group);
    state.epoch++;
    state.blocked = false;
    state.pendingHumans = 0;
    state.lastAttemptAt = -Infinity;
    this.queue.delete(state);
    const record = { schemaVersion: SCHEMA_VERSION, groupId: state.groupId, revision: 0, learnedAt: null, rules: [], slang: [] };
    await this.write(state, record);
    state.record = record;
    state.initialized = true;
  }

  isBusy() { return Boolean(this.running || this.queue.size); }
  excludeMembers(group, userIds) {
    const state = this.states.get(String(group));
    if (!state) return;
    const ignored = new Set(userIds.map(String));
    state.epoch++;
    state.snapshot = state.snapshot.filter(message => message.role === "assistant" || !ignored.has(String(message.userId)));
    state.pendingHumans = 0;
    this.queue.delete(state);
  }
  async flush() {
    while (this.running) await this.running;
    await Promise.all([...this.states.values()].map(state => state.writeChain.catch(() => undefined)));
  }
  stop() { this.closed = true; this.queue.clear(); }
}

module.exports = { GroupChatLearning, resolveGroupChatLearningDir, prepareLearningRecords, parseLearningResult,
  buildGroupLearningMessages, buildLearnedGroupStylePrompt };
