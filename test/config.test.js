const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

function readConfig(overrides = {}) {
  const keys = [
    "AI_PRIMARY_PROVIDER", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
    "DEEPSEEK_VISION_MODEL", "DEEPSEEK_TEMPERATURE", "CHAT_MAX_HISTORY_MESSAGES",
    "LOCAL_QWEN_MAX_HISTORY_MESSAGES", "AMBIENT_CHAT_INSTANT_MAX_MESSAGES",
    "AMBIENT_CHAT_IDLE_MAX_MESSAGES", "CHAT_MAX_CONTEXT_CHARS",
    "DEEPSEEK_THINKING_ENABLED", "DEEPSEEK_REASONING_EFFORT",
    "DEEPSEEK_THINKING_MAX_OUTPUT_TOKENS", "DEEPSEEK_THINKING_TIMEOUT_MS",
    "AMBIENT_CHAT_JUDGE_TIMEOUT_MS", "AMBIENT_CHAT_JUDGE_MAX_OUTPUT_TOKENS",
    "AMBIENT_CHAT_JUDGE_TEMPERATURE", "AMBIENT_CHAT_DEBOUNCE_MS",
    "WEB_SEARCH_AUTO_ENABLED",
    "AMBIENT_CHAT_DRAFT_REVIEW_ENABLED", "PERSONA_FLEXIBILITY_PROMPT", "NATURAL_CHAT_PROMPT",
    "GROUP_CHAT_SELF_REPEAT_CHECK_ENABLED",
    "WEB_SEARCH_PROVIDER", "DEEPSEEK_SEARCH_BASE_URL", "DEEPSEEK_SEARCH_MODEL",
    "DEEPSEEK_SEARCH_API_VERSION", "DEEPSEEK_SEARCH_MAX_TOKENS", "DEEPSEEK_SEARCH_MAX_USES",
    "WEB_SEARCH_MAX_QUERIES", "WEB_SEARCH_MAX_RESULTS", "WEB_SEARCH_TIMEOUT_MS",
    "WEB_FETCH_TIMEOUT_MS", "WEB_FETCH_MAX_RESPONSE_BYTES", "WEB_FETCH_MAX_BODY_CHARS", "WEB_FETCH_MAX_OUTPUT_CHARS",
    "GROUP_CHAT_LEARNING_REASONING_EFFORT", "GROUP_CHAT_LEARNING_MAX_OUTPUT_TOKENS", "GROUP_CHAT_LEARNING_TIMEOUT_MS",
  ];
  const env = { ...process.env, ...Object.fromEntries(keys.map((key) => [key, ""])), ...overrides };
  const source = `
    const { config } = require('./src/config');
    console.log(JSON.stringify({
      primary: config.aiPrimaryProvider, baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel, vision: config.deepseekVisionModel,
      temperature: config.deepseekTemperature, history: config.chatMaxHistoryMessages,
      qwenHistory: config.localQwenMaxHistoryMessages,
      instantHistory: config.ambientChatInstantMaxMessages,
      idleHistory: config.ambientChatIdleMaxMessages,
      maxChars: config.chatMaxContextChars,
      thinking: config.deepseekThinkingEnabled, reasoningEffort: config.deepseekReasoningEffort,
      thinkingMaxTokens: config.deepseekThinkingMaxOutputTokens,
      thinkingTimeoutMs: config.deepseekThinkingTimeoutMs,
      judgeTimeoutMs: config.ambientChatJudgeTimeoutMs,
      judgeMaxOutputTokens: config.ambientChatJudgeMaxOutputTokens,
      judgeTemperature: config.ambientChatJudgeTemperature, ambientDebounceMs: config.ambientChatDebounceMs,
      probabilityConfigured: Object.hasOwn(config, 'ambientChatProbability'),
      autoSearch: config.webSearchAutoEnabled,
      draftReview: config.ambientChatDraftReviewEnabled,
      selfRepeatCheck: config.groupChatSelfRepeatCheckEnabled,
      flexibility: config.personaFlexibilityPrompt, naturalChat: config.naturalChatPrompt,
      webProvider: config.webSearchProvider, searchBaseUrl: config.deepseekSearchBaseUrl,
      searchModel: config.deepseekSearchModel, searchMaxTokens: config.deepseekSearchMaxTokens,
      searchMaxUses: config.deepseekSearchMaxUses, searchMaxQueries: config.webSearchMaxQueries,
      searchMaxResults: config.webSearchMaxResults, searchTimeout: config.webSearchTimeoutMs,
      fetchTimeout: config.webFetchTimeoutMs, fetchMaxBytes: config.webFetchMaxResponseBytes,
      fetchMaxBody: config.webFetchMaxBodyChars, fetchMaxOutput: config.webFetchMaxOutputChars,
      learningEffort: config.groupChatLearningReasoningEffort, learningMaxTokens: config.groupChatLearningMaxOutputTokens,
      learningTimeoutMs: config.groupChatLearningTimeoutMs,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: path.resolve(__dirname, ".."), env, encoding: "utf8",
  }));
}

test("fresh configuration defaults to official DeepSeek Flash and 50-message windows", () => {
  assert.deepEqual(readConfig(), {
    primary: "deepseek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash", vision: "deepseek-flash", temperature: 0.9,
    history: 50, qwenHistory: 50, instantHistory: 50, idleHistory: 50, maxChars: 64000,
    thinking: false, reasoningEffort: "high", thinkingMaxTokens: 3200, thinkingTimeoutMs: 60000,
    judgeTimeoutMs: 10000, judgeMaxOutputTokens: 64, probabilityConfigured: false,
    judgeTemperature: 0.5, ambientDebounceMs: 600,
    autoSearch: true,
    draftReview: false, flexibility: "", naturalChat: "",
    selfRepeatCheck: false,
    webProvider: "deepseek-official", searchBaseUrl: "https://api.deepseek.com/anthropic/v1",
    searchModel: "deepseek-v4-flash", searchMaxTokens: 4096, searchMaxUses: 5,
    searchMaxQueries: 4, searchMaxResults: 8, searchTimeout: 30000,
    fetchTimeout: 30000, fetchMaxBytes: 5000000, fetchMaxBody: 100000, fetchMaxOutput: 200000,
    learningEffort: "high", learningMaxTokens: 8192, learningTimeoutMs: 90000,
  });
});

test("legacy probability settings do not configure the AI decision path", () => {
  assert.equal(readConfig({ AMBIENT_CHAT_PROBABILITY: "1" }).probabilityConfigured, false);
  assert.equal(readConfig({ AMBIENT_CHAT_PROBABILITY: "0" }).probabilityConfigured, false);
});

test("ambient sampling and debounce accept zero and clamp invalid ranges", () => {
  const disabled = readConfig({ AMBIENT_CHAT_JUDGE_TEMPERATURE: "0", AMBIENT_CHAT_DEBOUNCE_MS: "0" });
  assert.equal(disabled.judgeTemperature, 0);
  assert.equal(disabled.ambientDebounceMs, 0);
  const bounded = readConfig({ AMBIENT_CHAT_JUDGE_TEMPERATURE: "9", AMBIENT_CHAT_DEBOUNCE_MS: "9000" });
  assert.equal(bounded.judgeTemperature, 2);
  assert.equal(bounded.ambientDebounceMs, 5000);
});

test("old 100-message environment values are capped at 50", () => {
  const config = readConfig({
    CHAT_MAX_HISTORY_MESSAGES: "100",
    LOCAL_QWEN_MAX_HISTORY_MESSAGES: "100",
    AMBIENT_CHAT_INSTANT_MAX_MESSAGES: "100",
    AMBIENT_CHAT_IDLE_MAX_MESSAGES: "100",
  });
  for (const key of ["history", "qwenHistory", "instantHistory", "idleHistory"]) {
    assert.equal(config[key], 50);
  }
});

test("an explicit provider and custom model remain configurable", () => {
  const config = readConfig({ AI_PRIMARY_PROVIDER: "local-qwen", DEEPSEEK_MODEL: "custom-model" });
  assert.equal(config.primary, "local-qwen");
  assert.equal(config.model, "custom-model");
  assert.equal(config.vision, "custom-model");
});

test("stronger default thinking remains opt-in through configuration", () => {
  const config = readConfig({ DEEPSEEK_THINKING_ENABLED: "true", DEEPSEEK_REASONING_EFFORT: "max" });
  assert.equal(config.thinking, true);
  assert.equal(config.reasoningEffort, "max");
});

test("learning has independent strong reasoning and enough budget despite old non-thinking values", () => {
  const config = readConfig({ GROUP_CHAT_LEARNING_REASONING_EFFORT: "none", GROUP_CHAT_LEARNING_MAX_OUTPUT_TOKENS: "512" });
  assert.equal(config.learningEffort, "high");
  assert.equal(config.learningMaxTokens, 1024);
  assert.equal(config.thinking, false);
  const stronger = readConfig({ GROUP_CHAT_LEARNING_REASONING_EFFORT: "max", GROUP_CHAT_LEARNING_TIMEOUT_MS: "240000" });
  assert.equal(stronger.learningEffort, "max");
  assert.equal(stronger.learningTimeoutMs, 180000);
});

test("automatic search can be disabled independently of reasoning", () => {
  const config = readConfig({ WEB_SEARCH_AUTO_ENABLED: "false" });
  assert.equal(config.autoSearch, false);
  assert.equal(config.thinking, false);
});

test("search endpoint and model are independent of the conversation route", () => {
  const config = readConfig({ DEEPSEEK_BASE_URL: "https://chat.example/v1", DEEPSEEK_MODEL: "custom-chat",
    DEEPSEEK_SEARCH_BASE_URL: "https://search.example/anthropic/v1/", DEEPSEEK_SEARCH_MODEL: "custom-search",
    WEB_SEARCH_MAX_QUERIES: "50", WEB_FETCH_MAX_OUTPUT_CHARS: "500000" });
  assert.equal(config.baseUrl, "https://chat.example/v1");
  assert.equal(config.model, "custom-chat");
  assert.equal(config.searchBaseUrl, "https://search.example/anthropic/v1");
  assert.equal(config.searchModel, "custom-search");
  assert.equal(config.searchMaxQueries, 4);
  assert.equal(config.fetchMaxOutput, 200000);
  assert.equal(config.thinking, false);
});
