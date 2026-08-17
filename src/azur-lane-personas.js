const fs = require("fs");
const path = require("path");

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_FILENAME = "azur-lane-personas.json";
const COMPACT_PROMPT_LINE_COUNT = 15;
const PERSONA_SCHEMA = Object.freeze({
  tone: 3,
  speech: 4,
  personality: 5,
  likes: 3,
  dislikes: 3,
  interaction: 4,
  reasoning: 3,
  replyStyle: 4,
  signature: 2,
  boundaries: 3,
});
const REQUIRED_STRING_FIELDS = Object.freeze([
  "id",
  "name",
  "faction",
  "shipRole",
  "selfReference",
  "userAddress",
  "relationship",
  "summary",
  "sourceUrl",
]);

function resolvePersonaCatalogPath(configuredPath = process.env.PERSONA_CATALOG_FILE) {
  const explicitPath = String(configuredPath || "").trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? path.normalize(explicitPath)
      : path.resolve(process.cwd(), explicitPath);
  }

  if (process.pkg) {
    return path.join(path.dirname(process.execPath), "config", CATALOG_FILENAME);
  }

  return path.resolve(__dirname, "..", "config", CATALOG_FILENAME);
}

function loadAzurLanePersonaCatalog(options = {}) {
  const filePath = resolvePersonaCatalogPath(options.filePath);
  let rawText;

  try {
    rawText = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `[persona] 外部人格文件不存在：${filePath}。请把 ${CATALOG_FILENAME} 放到 exe 同级的 config 目录，或设置 PERSONA_CATALOG_FILE。`,
        { cause: error },
      );
    }
    throw new Error(`[persona] 无法读取外部人格文件：${filePath}`, {
      cause: error,
    });
  }

  let rawCatalog;
  try {
    rawCatalog = JSON.parse(rawText.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`[persona] 外部人格文件不是有效 JSON：${filePath}`, {
      cause: error,
    });
  }

  return createAzurLanePersonaCatalog(rawCatalog, { filePath });
}

function createAzurLanePersonaCatalog(rawCatalog, options = {}) {
  const filePath = options.filePath || "<memory>";
  if (!rawCatalog || typeof rawCatalog !== "object" || Array.isArray(rawCatalog)) {
    throw new Error(`[persona] 人格目录根节点必须是对象：${filePath}`);
  }
  if (rawCatalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `[persona] 不支持的人格目录版本 ${String(rawCatalog.schemaVersion)}；当前需要 ${CATALOG_SCHEMA_VERSION}：${filePath}`,
    );
  }
  if (!Array.isArray(rawCatalog.personas) || rawCatalog.personas.length === 0) {
    throw new Error(`[persona] 人格目录 personas 必须是非空数组：${filePath}`);
  }
  if (
    !rawCatalog.defaultState ||
    rawCatalog.defaultState.affection !== "MAX" ||
    !String(rawCatalog.defaultState.affectionStage || "").trim() ||
    typeof rawCatalog.defaultState.oath !== "boolean" ||
    !String(rawCatalog.defaultState.relationship || "").trim()
  ) {
    throw new Error(
      `[persona] 人格目录 defaultState 必须明确配置 MAX 满好感关系（${filePath}）`,
    );
  }
  assertStringArray(
    rawCatalog.sharedPromptCodes,
    "sharedPromptCodes",
    null,
    filePath,
  );
  if (
    rawCatalog.sharedPromptCodes.length < 5 ||
    rawCatalog.sharedPromptCodes.length > 32 ||
    rawCatalog.sharedPromptCodes.some((line) => !/^[A-Z0-9_]+$/.test(line))
  ) {
    throw new Error(
      `[persona] sharedPromptCodes 必须包含 5-32 条大写英文短码（${filePath}）`,
    );
  }

  const defaultState = Object.freeze({
    affection: rawCatalog.defaultState.affection,
    affectionStage: String(rawCatalog.defaultState.affectionStage).trim(),
    oath: rawCatalog.defaultState.oath,
    relationship: String(rawCatalog.defaultState.relationship).trim(),
  });
  const sharedPromptCodes = Object.freeze(
    rawCatalog.sharedPromptCodes.map((line) => String(line).trim()),
  );

  const personas = Object.freeze(
    rawCatalog.personas.map((rawPersona, index) =>
      validateAndFreezePersona(rawPersona, index, filePath),
    ),
  );
  const byId = new Map();
  const searchIndex = new Map();

  for (const persona of personas) {
    if (byId.has(persona.id)) {
      throw new Error(`[persona] 人格 id 重复：${persona.id}（${filePath}）`);
    }
    byId.set(persona.id, persona);

    for (const label of [persona.id, persona.name, ...persona.aliases]) {
      const normalized = normalizePersonaQuery(label);
      if (!normalized) {
        throw new Error(`[persona] ${persona.id} 含有无法检索的空别名（${filePath}）`);
      }
      const existing = searchIndex.get(normalized);
      if (existing && existing.id !== persona.id) {
        throw new Error(
          `[persona] 检索名“${label}”同时指向 ${existing.id} 与 ${persona.id}（${filePath}）`,
        );
      }
      searchIndex.set(normalized, persona);
    }
  }

  function getById(id) {
    return byId.get(String(id || "").trim()) || null;
  }

  function find(query) {
    return searchIndex.get(normalizePersonaQuery(query)) || null;
  }

  function search(query, limit = 5) {
    const normalizedQuery = normalizePersonaQuery(query);
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
    if (!normalizedQuery) {
      return [];
    }

    const exact = searchIndex.get(normalizedQuery);
    if (exact) {
      return [exact];
    }

    return personas
      .map((persona, order) => ({
        persona,
        order,
        score: Math.min(
          ...[persona.id, persona.name, ...persona.aliases].map((label) =>
            scorePersonaLabel(normalizedQuery, normalizePersonaQuery(label)),
          ),
        ),
      }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => left.score - right.score || left.order - right.order)
      .slice(0, safeLimit)
      .map((entry) => entry.persona);
  }

  function groupByFaction() {
    const groups = [];
    const groupByName = new Map();
    for (const persona of personas) {
      let group = groupByName.get(persona.faction);
      if (!group) {
        group = { faction: persona.faction, personas: [] };
        groupByName.set(persona.faction, group);
        groups.push(group);
      }
      group.personas.push(persona);
    }
    return groups.map((group) =>
      Object.freeze({
        faction: group.faction,
        personas: Object.freeze([...group.personas]),
      }),
    );
  }

  function buildPrompt(personaOrId) {
    const persona =
      typeof personaOrId === "string"
        ? getById(personaOrId) || find(personaOrId)
        : personaOrId;
    if (!persona || !byId.has(persona.id)) {
      throw new Error(`[persona] 无法为未知人格生成提示词：${String(personaOrId)}`);
    }

    return [
      "【PERSONA_LOAD】",
      ...persona.promptCodes,
      persona.maxAffection.promptCode,
      ...sharedPromptCodes,
    ].join("\n");
  }

  return Object.freeze({
    schemaVersion: rawCatalog.schemaVersion,
    description: String(rawCatalog.description || "").trim(),
    defaultState,
    sharedPromptCodes,
    filePath,
    personas,
    getById,
    find,
    search,
    groupByFaction,
    buildPrompt,
  });
}

function validateAndFreezePersona(rawPersona, index, filePath) {
  if (!rawPersona || typeof rawPersona !== "object" || Array.isArray(rawPersona)) {
    throw new Error(`[persona] personas[${index}] 必须是对象（${filePath}）`);
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!String(rawPersona[field] || "").trim()) {
      throw new Error(
        `[persona] personas[${index}] 缺少字符串字段 ${field}（${filePath}）`,
      );
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawPersona.id)) {
    throw new Error(`[persona] 非法人格 id：${rawPersona.id}（${filePath}）`);
  }
  if (!/^https:\/\//i.test(rawPersona.sourceUrl)) {
    throw new Error(`[persona] ${rawPersona.id} 的 sourceUrl 必须使用 HTTPS（${filePath}）`);
  }
  if (!Array.isArray(rawPersona.aliases) || rawPersona.aliases.length === 0) {
    throw new Error(`[persona] ${rawPersona.id} 至少需要一个 aliases 别名（${filePath}）`);
  }
  assertStringArray(rawPersona.aliases, `${rawPersona.id}.aliases`, null, filePath);
  if (
    !rawPersona.maxAffection ||
    typeof rawPersona.maxAffection !== "object" ||
    Array.isArray(rawPersona.maxAffection) ||
    !String(rawPersona.maxAffection.expression || "").trim() ||
    !/^[A-Z0-9_]+$/.test(String(rawPersona.maxAffection.promptCode || ""))
  ) {
    throw new Error(
      `[persona] ${rawPersona.id}.maxAffection 必须包含满好感中文表达和英文 promptCode（${filePath}）`,
    );
  }

  for (const [field, expectedLength] of Object.entries(PERSONA_SCHEMA)) {
    assertStringArray(rawPersona[field], `${rawPersona.id}.${field}`, expectedLength, filePath);
  }
  assertStringArray(
    rawPersona.promptCodes,
    `${rawPersona.id}.promptCodes`,
    COMPACT_PROMPT_LINE_COUNT,
    filePath,
  );
  if (rawPersona.promptCodes.some((line) => !/^[A-Z0-9_]+$/.test(line))) {
    throw new Error(
      `[persona] ${rawPersona.id}.promptCodes 只能包含大写英文、数字和下划线（${filePath}）`,
    );
  }

  return Object.freeze({
    ...Object.fromEntries(
      REQUIRED_STRING_FIELDS.map((field) => [field, String(rawPersona[field]).trim()]),
    ),
    aliases: Object.freeze(rawPersona.aliases.map((value) => String(value).trim())),
    maxAffection: Object.freeze({
      expression: String(rawPersona.maxAffection.expression).trim(),
      promptCode: String(rawPersona.maxAffection.promptCode).trim(),
    }),
    ...Object.fromEntries(
      Object.keys(PERSONA_SCHEMA).map((field) => [
        field,
        Object.freeze(rawPersona[field].map((value) => String(value).trim())),
      ]),
    ),
    promptCodes: Object.freeze(
      rawPersona.promptCodes.map((value) => String(value).trim()),
    ),
  });
}

function assertStringArray(value, label, expectedLength, filePath) {
  if (!Array.isArray(value)) {
    throw new Error(`[persona] ${label} 必须是数组（${filePath}）`);
  }
  if (expectedLength !== null && value.length !== expectedLength) {
    throw new Error(
      `[persona] ${label} 必须恰好包含 ${expectedLength} 项，当前为 ${value.length}（${filePath}）`,
    );
  }
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`[persona] ${label} 只能包含非空字符串（${filePath}）`);
  }
}

function normalizePersonaQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function scorePersonaLabel(query, label) {
  if (!label) {
    return Number.POSITIVE_INFINITY;
  }
  if (label.startsWith(query)) {
    return 1 + (label.length - query.length) / 100;
  }
  if (label.includes(query) || query.includes(label)) {
    return 2 + Math.abs(label.length - query.length) / 100;
  }

  const distance = levenshteinDistance(query, label);
  const allowedDistance = Math.max(1, Math.floor(Math.max(query.length, label.length) / 3));
  return distance <= allowedDistance ? 3 + distance : Number.POSITIVE_INFINITY;
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index];
    }
  }
  return previous[right.length];
}

module.exports = {
  CATALOG_FILENAME,
  CATALOG_SCHEMA_VERSION,
  COMPACT_PROMPT_LINE_COUNT,
  PERSONA_SCHEMA,
  createAzurLanePersonaCatalog,
  loadAzurLanePersonaCatalog,
  normalizePersonaQuery,
  resolvePersonaCatalogPath,
};
