const dotenv = require("dotenv");

dotenv.config();

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set(values)];
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseOptionalInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return parseInteger(value, fallback);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

const config = {
  port: parseInteger(process.env.PORT, 6700),
  wsPath: process.env.WS_PATH || "/onebot/v11/ws",
  accessToken: process.env.ACCESS_TOKEN || "",
  sandstormHost: process.env.SANDSTORM_HOST || "127.0.0.1",
  sandstormPort: parseInteger(process.env.SANDSTORM_PORT, 27015),
  queryTimeoutMs: parseInteger(process.env.QUERY_TIMEOUT_MS, 7000),
  triggerKeywords: parseList(process.env.TRIGGER_KEYWORDS || "叛乱,沙漠风暴,服务器状态,ins"),
  requireAt: parseBoolean(process.env.REQUIRE_AT, true),
  cooldownSeconds: parseInteger(process.env.COOLDOWN_SECONDS, 20),
  allowedGroupIds: new Set(parseList(process.env.ALLOWED_GROUP_IDS)),
  botName: process.env.BOT_NAME || "沙暴状态",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEKER_API_KEY || "",
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  deepseekSystemPrompt:
    process.env.DEEPSEEK_SYSTEM_PROMPT ||
    "你是一只接入 QQ 群聊的中文猫娘机器人。回答要自然、简洁、有帮助，语气可爱但不过度；每次回复至少自然地带一次 喵~；不知道时直接说明，不编造。",
  responseNeutralityPrompt:
    process.env.RESPONSE_NEUTRALITY_PROMPT ||
    "回复必须避免表现出政治或宗教倾向。不要主动引入政治、宗教、意识形态立场；如果用户内容涉及这些话题，只做中立、克制、事实性或轻轻转移话题的回应，不站队、不宣传、不劝诱、不评价任何政治或宗教群体。",
  deepseekTimeoutMs: parseInteger(process.env.DEEPSEEK_TIMEOUT_MS, 30000),
  deepseekThinkingTimeoutMs: parseInteger(process.env.DEEPSEEK_THINKING_TIMEOUT_MS, 60000),
  deepseekMaxOutputTokens: parseInteger(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS, 1600),
  deepseekThinkingMaxOutputTokens: parseInteger(process.env.DEEPSEEK_THINKING_MAX_OUTPUT_TOKENS, 3200),
  deepseekTemperature: Number.isFinite(Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE))
    ? Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE)
    : 0.7,
  deepseekReasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
  webSearchTriggerKeywords: uniqueList([
    ...parseList("联网搜索,联网查询,联网搜搜"),
    ...parseList(process.env.WEB_SEARCH_TRIGGER_KEYWORDS),
    ...parseList(process.env.WEB_SEARCH_TRIGGER_KEYWORD),
  ]),
  webSearchProvider: process.env.WEB_SEARCH_PROVIDER || "open-websearch",
  webSearchMaxResults: parseInteger(process.env.WEB_SEARCH_MAX_RESULTS, 3),
  webSearchCandidateResults: parseInteger(process.env.WEB_SEARCH_CANDIDATE_RESULTS, 8),
  webSearchMaxToolRounds: parseInteger(process.env.WEB_SEARCH_MAX_TOOL_ROUNDS, 2),
  webSearchMaxToolCallsPerRound: parseInteger(process.env.WEB_SEARCH_MAX_TOOL_CALLS_PER_ROUND, 2),
  webSearchTimeoutMs: parseInteger(process.env.WEB_SEARCH_TIMEOUT_MS, 10000),
  webFetchMaxChars: parseInteger(process.env.WEB_FETCH_MAX_CHARS, 1000),
  webSearchSnippetMaxChars: parseInteger(process.env.WEB_SEARCH_SNIPPET_MAX_CHARS, 220),
  webSearchMinRelevanceScore: parseInteger(process.env.WEB_SEARCH_MIN_RELEVANCE_SCORE, 3),
  webSearchLanguage: process.env.WEB_SEARCH_LANGUAGE || "zh-CN,zh;q=0.9,en;q=0.8",
  webSearchLanguageCode: process.env.WEB_SEARCH_LANGUAGE_CODE || "zh-CN",
  webSearchCountryCode: process.env.WEB_SEARCH_COUNTRY_CODE || "CN",
  webSearchMarket: process.env.WEB_SEARCH_MARKET || "zh-CN",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  tavilySearchDepth: process.env.TAVILY_SEARCH_DEPTH || "basic",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  braveSearchCountry: process.env.BRAVE_SEARCH_COUNTRY || "US",
  braveSearchLang: process.env.BRAVE_SEARCH_LANG || "zh-hans",
  braveSearchUiLang: process.env.BRAVE_SEARCH_UI_LANG || "zh-CN",
  openWebSearchEngines: parseList(process.env.OPEN_WEBSEARCH_ENGINES || "duckduckgo,startpage,sogou"),
  openWebSearchMode: process.env.OPEN_WEBSEARCH_MODE || "auto",
  openWebSearchFakeIpCidrs: parseList(process.env.OPEN_WEBSEARCH_FAKE_IP_CIDRS || "198.18.0.0/15"),
  bilibiliEnabled: parseBoolean(process.env.BILIBILI_ENABLED, true),
  bilibiliProviders: parseList(process.env.BILIBILI_PROVIDERS || "mir6,injahow"),
  bilibiliSendVideo: parseBoolean(process.env.BILIBILI_SEND_VIDEO, true),
  bilibiliMetadataEnabled: parseBoolean(process.env.BILIBILI_METADATA_ENABLED, false),
  bilibiliTimeoutMs: parseInteger(process.env.BILIBILI_TIMEOUT_MS, 15000),
  chatEnabled: parseBoolean(process.env.CHAT_ENABLED, true),
  chatRequireAt: parseBoolean(process.env.CHAT_REQUIRE_AT, true),
  chatCooldownSeconds: parseInteger(process.env.CHAT_COOLDOWN_SECONDS, 3),
  ambientChatEnabled: parseBoolean(process.env.AMBIENT_CHAT_ENABLED, true),
  ambientChatProbability: clampNumber(parseNumber(process.env.AMBIENT_CHAT_PROBABILITY, 0.08), 0, 1),
  ambientChatCooldownSeconds: parseInteger(process.env.AMBIENT_CHAT_COOLDOWN_SECONDS, 60),
  ambientChatIdleSeconds: parseInteger(process.env.AMBIENT_CHAT_IDLE_SECONDS, 60),
  ambientChatInstantMaxMessages: parseInteger(process.env.AMBIENT_CHAT_INSTANT_MAX_MESSAGES, 4),
  ambientChatIdleMaxMessages: parseInteger(process.env.AMBIENT_CHAT_IDLE_MAX_MESSAGES, 6),
  ambientChatContextSeconds: parseInteger(process.env.AMBIENT_CHAT_CONTEXT_SECONDS, 300),
  ambientChatTimeoutMs: parseInteger(process.env.AMBIENT_CHAT_TIMEOUT_MS, 12000),
  ambientChatMaxOutputTokens: parseInteger(process.env.AMBIENT_CHAT_MAX_OUTPUT_TOKENS, 180),
  ambientChatSystemPrompt:
    process.env.AMBIENT_CHAT_SYSTEM_PROMPT ||
    "你是一只接入 QQ 群聊的中文猫娘机器人。现在你是在群聊里偶尔插一句闲聊，不是回答问题。请用中文快速回复 1 句，优先 20-45 个字，必要时最多 70 个字；必须自然带一次“喵”；语气像二次元社区玩家路过接梗、轻吐槽或轻轻感叹，可以有一点游戏群/番剧群的弹幕感，但味不要太冲；吐槽要友善，不恶意、不阴阳怪气、不嘲讽、不攻击任何人；不要说教，不要长篇解释，不要提到自己是 AI。",
  chatMaxHistoryMessages: parseInteger(process.env.CHAT_MAX_HISTORY_MESSAGES, 16),
  chatMaxContextChars: parseInteger(process.env.CHAT_MAX_CONTEXT_CHARS, 12000),
  chatSessionTtlMinutes: parseOptionalInteger(process.env.CHAT_SESSION_TTL_MINUTES, 120),
};

module.exports = { config };
