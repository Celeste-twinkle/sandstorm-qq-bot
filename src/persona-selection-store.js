const fs = require("fs");
const path = require("path");

const STORE_SCHEMA_VERSION = 1;
const STORE_FILENAME = "persona-selections.json";
const DEFAULT_CUSTOM_PERSONA_MAX_CHARS = 12000;

function resolvePersonaSelectionPath(configuredPath = process.env.PERSONA_CACHE_FILE) {
  const explicitPath = String(configuredPath || "").trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? path.normalize(explicitPath)
      : path.resolve(process.cwd(), explicitPath);
  }

  const baseDir = process.pkg
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, "..");
  return path.join(baseDir, "data", STORE_FILENAME);
}

class PersonaSelectionStore {
  constructor(options = {}) {
    this.filePath = resolvePersonaSelectionPath(options.filePath);
    this.customPersonaMaxChars = normalizeCustomPersonaLimit(
      options.customPersonaMaxChars,
    );
    this.selections = new Map();
    this.writeChain = Promise.resolve();
    this.tempSequence = 0;
  }

  load() {
    let rawText;
    try {
      rawText = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return this;
      }
      throw new Error(`[persona] 无法读取人格选择缓存：${this.filePath}`, {
        cause: error,
      });
    }

    let data;
    try {
      data = JSON.parse(rawText.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`[persona] 人格选择缓存不是有效 JSON：${this.filePath}`, {
        cause: error,
      });
    }

    if (!data || data.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new Error(`[persona] 人格选择缓存版本不受支持：${this.filePath}`);
    }
    if (!data.selections || typeof data.selections !== "object" || Array.isArray(data.selections)) {
      throw new Error(`[persona] 人格选择缓存 selections 必须是对象：${this.filePath}`);
    }

    const loaded = new Map();
    for (const [groupId, groupSelections] of Object.entries(data.selections)) {
      if (!groupSelections || typeof groupSelections !== "object" || Array.isArray(groupSelections)) {
        throw new Error(`[persona] 群 ${groupId} 的人格选择必须是对象：${this.filePath}`);
      }
      for (const [userId, storedSelection] of Object.entries(groupSelections)) {
        const normalized = normalizeStoredSelection(
          groupId,
          userId,
          storedSelection,
          this.customPersonaMaxChars,
        );
        loaded.set(selectionKey(normalized.groupId, normalized.userId), normalized);
      }
    }

    this.selections = loaded;
    return this;
  }

  getSelection(groupId, userId) {
    return this.selections.get(selectionKey(groupId, userId)) || null;
  }

  get(groupId, userId) {
    const selection = this.getSelection(groupId, userId);
    return selection?.type === "catalog" ? selection.personaId : null;
  }

  has(groupId, userId) {
    return this.selections.has(selectionKey(groupId, userId));
  }

  async set(groupId, userId, personaId) {
    return this.setCatalog(groupId, userId, personaId);
  }

  async setCatalog(groupId, userId, personaId) {
    const normalized = normalizeCatalogSelection(groupId, userId, personaId);
    this.selections.set(
      selectionKey(normalized.groupId, normalized.userId),
      normalized,
    );
    await this.enqueueWrite();
    return normalized.personaId;
  }

  async setCustom(groupId, userId, prompt) {
    const normalized = normalizeCustomSelection(
      groupId,
      userId,
      prompt,
      this.customPersonaMaxChars,
    );
    this.selections.set(
      selectionKey(normalized.groupId, normalized.userId),
      normalized,
    );
    await this.enqueueWrite();
    return normalized.prompt;
  }

  async clear(groupId, userId) {
    const key = selectionKey(groupId, userId);
    const existed = this.selections.delete(key);
    if (existed) {
      await this.enqueueWrite();
    }
    return existed;
  }

  toJSON() {
    const selections = {};
    const values = [...this.selections.values()].sort(
      (left, right) =>
        left.groupId.localeCompare(right.groupId, "en", { numeric: true }) ||
        left.userId.localeCompare(right.userId, "en", { numeric: true }),
    );

    for (const selection of values) {
      selections[selection.groupId] ||= {};
      selections[selection.groupId][selection.userId] = selection.type === "custom"
        ? { type: "custom", prompt: selection.prompt }
        : { type: "catalog", personaId: selection.personaId };
    }

    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      selections,
    };
  }

  enqueueWrite() {
    const snapshot = `${JSON.stringify(this.toJSON(), null, 2)}\n`;
    this.tempSequence += 1;
    const temporaryPath = `${this.filePath}.${process.pid}.${this.tempSequence}.tmp`;
    const write = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
          await fs.promises.writeFile(temporaryPath, snapshot, "utf8");
          await fs.promises.rename(temporaryPath, this.filePath);
        } finally {
          await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      });
    this.writeChain = write;
    return write;
  }
}

function normalizeStoredSelection(groupId, userId, storedSelection, customMaxChars) {
  if (!storedSelection || typeof storedSelection !== "object" || Array.isArray(storedSelection)) {
    throw new Error(`[persona] 群 ${groupId} 用户 ${userId} 的人格选择格式无效`);
  }
  if (storedSelection.type === "catalog") {
    return normalizeCatalogSelection(groupId, userId, storedSelection.personaId);
  }
  if (storedSelection.type === "custom") {
    return normalizeCustomSelection(
      groupId,
      userId,
      storedSelection.prompt,
      customMaxChars,
    );
  }
  throw new Error(`[persona] 群 ${groupId} 用户 ${userId} 的人格选择类型无效`);
}

function normalizeCatalogSelection(groupId, userId, personaId) {
  const base = normalizeSelectionIdentity(groupId, userId);
  const normalizedPersonaId = String(personaId || "").trim();
  if (!normalizedPersonaId) {
    throw new Error("[persona] personaId 不能为空");
  }
  return Object.freeze({
    ...base,
    type: "catalog",
    personaId: normalizedPersonaId,
  });
}

function normalizeCustomSelection(groupId, userId, prompt, maxChars) {
  const base = normalizeSelectionIdentity(groupId, userId);
  const normalizedPrompt = String(prompt || "").replace(/\r\n?/g, "\n").trim();
  if (!normalizedPrompt) {
    throw new Error("[persona] 自定义人格提示词不能为空");
  }
  const promptLength = countUnicodeCharacters(normalizedPrompt);
  if (promptLength > maxChars) {
    throw new Error(
      `[persona] 自定义人格提示词超过 ${maxChars} 字，当前为 ${promptLength} 字`,
    );
  }
  return Object.freeze({
    ...base,
    type: "custom",
    prompt: normalizedPrompt,
  });
}

function normalizeSelectionIdentity(groupId, userId) {
  const normalized = {
    groupId: String(groupId || "").trim(),
    userId: String(userId || "").trim(),
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!value) {
      throw new Error(`[persona] ${field} 不能为空`);
    }
  }
  return normalized;
}

function normalizeCustomPersonaLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_CUSTOM_PERSONA_MAX_CHARS;
  }
  return Math.min(parsed, DEFAULT_CUSTOM_PERSONA_MAX_CHARS);
}

function countUnicodeCharacters(value) {
  return Array.from(String(value || "")).length;
}

function selectionKey(groupId, userId) {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedGroupId || !normalizedUserId) {
    return "";
  }
  return JSON.stringify([normalizedGroupId, normalizedUserId]);
}

module.exports = {
  DEFAULT_CUSTOM_PERSONA_MAX_CHARS,
  PersonaSelectionStore,
  STORE_FILENAME,
  STORE_SCHEMA_VERSION,
  resolvePersonaSelectionPath,
  selectionKey,
};
