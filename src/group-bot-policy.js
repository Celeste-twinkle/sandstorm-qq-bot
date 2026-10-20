const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const ACCOUNT_ID = /^\d{5,20}$/;
const IGNORE_WORDS = /忽略|忽视|无视|屏蔽|拉黑|(?:别|不要|不用|不再|不)[\s\S]{0,4}(?:回复|回应|回|搭理|理会|理)|不理|(?:加入|加进|添加到?)[\s\S]{0,8}黑名单/;
const ALLOW_WORDS = /允许|恢复|放行|解禁|(?:取消|解除|停止|别再|不要再|不再|不要|别)[\s\S]{0,16}(?:忽略|忽视|无视|屏蔽|拉黑)|(?:继续|重新|正常)[\s\S]{0,6}(?:回复|回应|搭理|理会)|(?:移出|移除)[\s\S]{0,8}黑名单|黑名单[\s\S]{0,8}(?:移出|移除)/;
const NEGATED_ALLOW = /(?:不要|别|不用)[\s\S]{0,6}(?:取消|解除|恢复|允许|放行|解禁)/;

function parseBotControlCommand(message) {
  const segments = Array.isArray(message.message) ? message.message : null;
  const raw = segments
    ? segments.filter(segment => segment?.type === "text").map(segment => segment.data?.text || "").join("")
    : String(message.message || message.raw_message || "");
  const mentions = segments
    ? segments.filter(segment => segment?.type === "at").map(segment => String(segment.data?.qq || ""))
    : Array.from(raw.matchAll(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/gi), match => match[1]);
  const selfId = String(message.self_id || "");
  if (!selfId || !mentions.includes(selfId)) return null;
  const text = raw.replace(/\[CQ:[^\]]*\]/gi, " ").trim();
  const targets = [...new Set([...mentions, ...(text.match(/\b\d{5,20}\b/g) || [])])]
    .filter(id => id !== selfId && ACCOUNT_ID.test(id));
  if (!targets.length && /(?:忽略|忽视|无视|屏蔽)(?:列表|名单)|黑名单|查看[\s\S]{0,8}(?:忽略|忽视|无视|屏蔽)/.test(text)) {
    return { action: "list", targets: [] };
  }
  const action = NEGATED_ALLOW.test(text) ? "ignore" : ALLOW_WORDS.test(text) ? "allow"
    : IGNORE_WORDS.test(text) ? "ignore" : "";
  if (!action) return null;
  // Natural sentences need an explicit target. Bare command aliases still show
  // usage, while ordinary questions about e.g. ignoring an error stay AI chat.
  const bare = text.replace(/[\s，。！!？?]/g, "");
  if (!targets.length && !/^(?:忽略|忽视|无视|屏蔽|拉黑|允许|恢复|放行|解禁|取消忽略|取消忽视|取消无视|解除屏蔽)(?:账号)?$/.test(bare)) return null;
  return { action, targets };
}

function resolveBotPolicyFile(configured = "") {
  const base = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
  return path.resolve(base, String(configured || "").trim() || "data/group-bot-policy.json");
}

function validateRecord(record) {
  if (!record || Object.keys(record).sort().join(",") !== "allowedUserIds,ignoredUserIds" ||
      ![record.ignoredUserIds, record.allowedUserIds].every(ids => Array.isArray(ids) &&
        ids.every(id => typeof id === "string" && ACCOUNT_ID.test(id)))) {
    throw new Error("Invalid bot policy record");
  }
  if (record.ignoredUserIds.some(id => record.allowedUserIds.includes(id))) throw new Error("Conflicting bot policy");
  return { ignoredUserIds: [...new Set(record.ignoredUserIds)], allowedUserIds: [...new Set(record.allowedUserIds)] };
}

class GroupBotPolicy {
  constructor(config = {}, options = {}) {
    this.file = resolveBotPolicyFile(config.groupChatBotPolicyFile);
    this.groups = new Map();
    this.writeChain = Promise.resolve();
    this.loadError = null;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      if (stored.schemaVersion !== 1 || !stored.groups || typeof stored.groups !== "object" || Array.isArray(stored.groups)) {
        throw new Error("Invalid bot policy file");
      }
      const groups = new Map();
      for (const [id, record] of Object.entries(stored.groups)) {
        if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid bot policy group");
        groups.set(id, validateRecord(record));
      }
      this.groups = groups;
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.loadError = error;
        (options.logger || console).warn("[bot] ignore settings could not be loaded; management writes disabled");
      }
    }
  }

  decision(groupId, userId) {
    const record = this.groups.get(String(groupId));
    if (record?.ignoredUserIds.includes(String(userId))) return "ignore";
    if (record?.allowedUserIds.includes(String(userId))) return "allow";
    return null;
  }

  ignoredIds(groupId, configuredIds = []) {
    if (this.loadError) throw this.loadError;
    const record = this.groups.get(String(groupId));
    const ids = new Set([...configuredIds, ...(record?.ignoredUserIds || [])]);
    for (const id of record?.allowedUserIds || []) ids.delete(id);
    return [...ids].sort();
  }

  async set(groupId, userIds, action) {
    if (this.loadError) throw this.loadError;
    const key = String(groupId);
    if (!/^\d{1,20}$/.test(key) || !userIds.length ||
        !userIds.every(id => ACCOUNT_ID.test(id)) || !["ignore", "allow"].includes(action)) {
      throw new Error("Invalid bot policy update");
    }
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const previous = this.groups.get(key) || { ignoredUserIds: [], allowedUserIds: [] };
      const ignored = new Set(previous.ignoredUserIds), allowed = new Set(previous.allowedUserIds);
      for (const id of userIds) {
        (action === "ignore" ? ignored : allowed).add(id);
        (action === "ignore" ? allowed : ignored).delete(id);
      }
      const groups = new Map(this.groups);
      groups.set(key, { ignoredUserIds: [...ignored], allowedUserIds: [...allowed] });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      try {
        await fs.promises.writeFile(temporary, JSON.stringify({ schemaVersion: 1, groups: Object.fromEntries(groups) }, null, 2) + "\n", "utf8");
        await fs.promises.rename(temporary, this.file);
        this.groups = groups;
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writeChain = operation;
    return operation;
  }
}

module.exports = { GroupBotPolicy, parseBotControlCommand, resolveBotPolicyFile };
