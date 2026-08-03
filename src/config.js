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

function parseStrongReasoningEffort(value) {
  return String(value || "").trim().toLowerCase() === "max" ? "max" : "high";
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
  localQwenEnabled: parseBoolean(process.env.LOCAL_QWEN_ENABLED, true),
  localQwenProviderId: process.env.LOCAL_QWEN_PROVIDER_ID || "local-qwen-manual",
  localQwenDisplayName: process.env.LOCAL_QWEN_DISPLAY_NAME || "Local Qwen Manual",
  localQwenApiKey: process.env.LOCAL_QWEN_API_KEY || "",
  localQwenBaseUrl: (process.env.LOCAL_QWEN_BASE_URL || "").replace(/\/+$/, ""),
  localQwenModel: process.env.LOCAL_QWEN_MODEL || "qwen3.6-local",
  localQwenSystemPrompt:
    process.env.LOCAL_QWEN_SYSTEM_PROMPT ||
    "你是一只接入 QQ 群聊的中文猫娘机器人。回答要自然、简洁、有帮助，语气可爱但不过度；每次回复至少自然地带一次 喵~；不知道时直接说明，不编造。",
  localQwenDialoguePrompt:
    process.env.LOCAL_QWEN_DIALOGUE_PROMPT ||
    "消息按时间从旧到新排列，最后一条 user 消息是当前必须回答的问题。先判断它是在承接上文、修改条件，还是开启新话题：承接时结合最近相关回合解析“这个”“它”“刚才”“继续”等指代；换题时立即以新问题为准，不要把无关旧内容硬套进来。回答必须覆盖用户真正要解决的点，不能只抓关键词、复述原话或答非所问。信息足够就直接给出可靠答案；只有缺少的关键条件会导致答案明显不同时，才说明歧义并只问一个最必要的澄清问题。若有图片，同时结合图片和配文；看不清的内容要明确说明，不能猜。回答前静默核对一次“这是否直接回答了最后一个问题”，不要输出思考过程。",
  localQwenConcisePrompt:
    process.env.LOCAL_QWEN_CONCISE_PROMPT ||
    "回答长度服从问题复杂度：简单问题直接用一句到几句回答；需要解释时使用少量短段落或清晰列表。除非用户明确要求详细展开，否则不堆砌背景、不重复问题，但不能为了简短省略答案成立所必需的条件。",
  localQwenHealthPath: process.env.LOCAL_QWEN_HEALTH_PATH || "/models",
  localQwenHealthIntervalMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_HEALTH_INTERVAL_MS, 10000),
    1000,
    3600000,
  ),
  localQwenHealthTimeoutMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_HEALTH_TIMEOUT_MS, 3000),
    500,
    60000,
  ),
  localQwenTimeoutMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_TIMEOUT_MS, 60000),
    1000,
    600000,
  ),
  localQwenContextTokens: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_CONTEXT_TOKENS, 262144),
    8192,
    262144,
  ),
  localQwenContextSafetyTokens: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_CONTEXT_SAFETY_TOKENS, 4096),
    1024,
    32768,
  ),
  localQwenModelMaxOutputTokens: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_MODEL_MAX_OUTPUT_TOKENS, 16384),
    1,
    16384,
  ),
  localQwenTemperature: clampNumber(parseNumber(process.env.LOCAL_QWEN_TEMPERATURE, 0.7), 0, 2),
  localQwenReasoningEffort: parseStrongReasoningEffort(
    process.env.LOCAL_QWEN_REASONING_EFFORT,
  ),
  localQwenWebResearchEnabled: parseBoolean(
    process.env.LOCAL_QWEN_WEB_RESEARCH_ENABLED,
    true,
  ),
  localQwenWebResearchTimeoutMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_WEB_RESEARCH_TIMEOUT_MS, 120000),
    1000,
    600000,
  ),
  localQwenWebSearchMaxToolRounds: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_WEB_SEARCH_MAX_TOOL_ROUNDS, 4),
    1,
    8,
  ),
  localQwenWebSearchMaxToolCallsPerRound: clampNumber(
    parseInteger(
      process.env.LOCAL_QWEN_WEB_SEARCH_MAX_TOOL_CALLS_PER_ROUND,
      4,
    ),
    1,
    8,
  ),
  localQwenWebSearchMaxTotalToolCalls: clampNumber(
    parseInteger(
      process.env.LOCAL_QWEN_WEB_SEARCH_MAX_TOTAL_TOOL_CALLS,
      12,
    ),
    1,
    32,
  ),
  localQwenWebSearchMaxResults: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_WEB_SEARCH_MAX_RESULTS, 5),
    1,
    5,
  ),
  localQwenWebSearchCandidateResults: clampNumber(
    parseInteger(
      process.env.LOCAL_QWEN_WEB_SEARCH_CANDIDATE_RESULTS,
      12,
    ),
    1,
    12,
  ),
  localQwenWebSearchSnippetMaxChars: clampNumber(
    parseInteger(
      process.env.LOCAL_QWEN_WEB_SEARCH_SNIPPET_MAX_CHARS,
      500,
    ),
    80,
    1000,
  ),
  localQwenWebFetchMaxChars: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_WEB_FETCH_MAX_CHARS, 6000),
    500,
    12000,
  ),
  localQwenWebEvidenceReserveTokens: clampNumber(
    parseInteger(
      process.env.LOCAL_QWEN_WEB_EVIDENCE_RESERVE_TOKENS,
      48000,
    ),
    4096,
    131072,
  ),
  localQwenMaxHistoryMessages: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_MAX_HISTORY_MESSAGES, 100),
    2,
    100,
  ),
  localQwenMaxImages: clampNumber(parseInteger(process.env.LOCAL_QWEN_MAX_IMAGES, 10), 0, 10),
  localQwenImageTokenEstimate: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_TOKEN_ESTIMATE, 4096),
    256,
    32768,
  ),
  localQwenImageFetchTimeoutMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_FETCH_TIMEOUT_MS, 10000),
    1000,
    60000,
  ),
  localQwenImageMaxBytes: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_MAX_BYTES, 8 * 1024 * 1024),
    64 * 1024,
    32 * 1024 * 1024,
  ),
  localQwenImagesMaxTotalBytes: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGES_MAX_TOTAL_BYTES, 32 * 1024 * 1024),
    64 * 1024,
    128 * 1024 * 1024,
  ),
  localQwenImageCacheEnabled: parseBoolean(
    process.env.LOCAL_QWEN_IMAGE_CACHE_ENABLED,
    true,
  ),
  localQwenImageCacheMaxEntries: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_CACHE_MAX_ENTRIES, 500),
    10,
    5000,
  ),
  localQwenImageCacheTtlMinutes: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_CACHE_TTL_MINUTES, 720),
    1,
    10080,
  ),
  localQwenImageCacheMaxChars: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_CACHE_MAX_CHARS, 24000),
    500,
    50000,
  ),
  localQwenImageCacheTimeoutMs: clampNumber(
    parseInteger(process.env.LOCAL_QWEN_IMAGE_CACHE_TIMEOUT_MS, 120000),
    1000,
    120000,
  ),
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
  bilibiliDownloadVideo: parseBoolean(process.env.BILIBILI_DOWNLOAD_VIDEO, true),
  bilibiliDownloadTimeoutMs: parseInteger(process.env.BILIBILI_DOWNLOAD_TIMEOUT_MS, 180000),
  bilibiliMaxVideoSizeMb: clampNumber(parseNumber(process.env.BILIBILI_MAX_VIDEO_SIZE_MB, 95), 1, 100),
  bilibiliSendRetries: clampNumber(parseInteger(process.env.BILIBILI_SEND_RETRIES, 1), 0, 3),
  bilibiliKeepFailedVideo: parseBoolean(process.env.BILIBILI_KEEP_FAILED_VIDEO, false),
  chatEnabled: parseBoolean(process.env.CHAT_ENABLED, true),
  chatRequireAt: parseBoolean(process.env.CHAT_REQUIRE_AT, true),
  chatCooldownSeconds: parseInteger(process.env.CHAT_COOLDOWN_SECONDS, 3),
  ambientChatEnabled: parseBoolean(process.env.AMBIENT_CHAT_ENABLED, true),
  ambientChatProbability: clampNumber(parseNumber(process.env.AMBIENT_CHAT_PROBABILITY, 0.08), 0, 1),
  ambientChatCooldownSeconds: parseInteger(process.env.AMBIENT_CHAT_COOLDOWN_SECONDS, 60),
  ambientChatIdleSeconds: parseInteger(process.env.AMBIENT_CHAT_IDLE_SECONDS, 60),
  ambientChatInstantMaxMessages: clampNumber(
    parseInteger(process.env.AMBIENT_CHAT_INSTANT_MAX_MESSAGES, 100),
    1,
    100,
  ),
  ambientChatIdleMaxMessages: clampNumber(
    parseInteger(process.env.AMBIENT_CHAT_IDLE_MAX_MESSAGES, 100),
    1,
    100,
  ),
  ambientChatContextSeconds: clampNumber(
    parseInteger(process.env.AMBIENT_CHAT_CONTEXT_SECONDS, 7200),
    60,
    86400,
  ),
  ambientChatTimeoutMs: parseInteger(process.env.AMBIENT_CHAT_TIMEOUT_MS, 30000),
  ambientChatMaxOutputTokens: parseInteger(process.env.AMBIENT_CHAT_MAX_OUTPUT_TOKENS, 180),
  ambientChatSystemPrompt:
    process.env.AMBIENT_CHAT_SYSTEM_PROMPT ||
    "你是一只接入 QQ 群聊的中文猫娘机器人。现在你是在群聊里偶尔插一句闲聊，不是回答问题。请用中文快速回复 1 句，优先 20-45 个字，必要时最多 70 个字；必须自然带一次“喵”；语气像二次元社区玩家路过接梗、轻吐槽或轻轻感叹，可以有一点游戏群/番剧群的弹幕感，但味不要太冲；吐槽要友善，不恶意、不阴阳怪气、不嘲讽、不攻击任何人；不要说教，不要长篇解释，不要提到自己是 AI。",
  chatMaxHistoryMessages: parseInteger(process.env.CHAT_MAX_HISTORY_MESSAGES, 16),
  chatMaxContextChars: parseInteger(process.env.CHAT_MAX_CONTEXT_CHARS, 12000),
  chatSessionTtlMinutes: parseOptionalInteger(process.env.CHAT_SESSION_TTL_MINUTES, 120),
};

module.exports = { config };
