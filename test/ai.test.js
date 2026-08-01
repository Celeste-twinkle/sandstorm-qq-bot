const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AiChatService,
  extractImageSources,
  trimQwenMessagesToBudget,
} = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const {
  LocalQwenChatService,
  LocalQwenRequestError,
  prepareQwenMessages,
} = require("../src/qwen");

test("Local Qwen health check uses authenticated /models without a real network request", async () => {
  const calls = [];
  const logger = createLogger();
  const config = createConfig();
  const service = new LocalQwenChatService(config, {
    logger,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: [{ id: config.localQwenModel }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(await service.checkHealth(), true);
  assert.equal(service.isHealthy(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://qwen.mock/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${config.localQwenApiKey}`);
});

test("Local Qwen automatically returns to healthy after a later successful probe", async () => {
  let attempts = 0;
  const service = new LocalQwenChatService(createConfig(), {
    logger: createLogger(),
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(await service.checkHealth(), false);
  assert.equal(service.isHealthy(), false);
  assert.equal(await service.checkHealth(), true);
  assert.equal(service.isHealthy(), true);
});

test("Local Qwen request body uses supported OpenAI-compatible parameters", async () => {
  const calls = [];
  const config = createConfig();
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (url, options) => {
      calls.push({
        url,
        headers: options.headers,
        body: JSON.parse(options.body),
      });
      return completionResponse("Qwen reply");
    },
  });

  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ];

  assert.equal(await service.createCompletion(messages), "Qwen reply");
  assert.equal(await service.createCompletion(messages, { thinking: true }), "Qwen reply");

  assert.equal(calls[0].url, "http://qwen.mock/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, `Bearer ${config.localQwenApiKey}`);
  assert.equal(calls[0].body.model, "qwen3.6-local");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.max_tokens, 800);
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal("thinking" in calls[0].body, false);
  assert.equal("reasoning_effort" in calls[0].body, false);

  assert.equal(calls[1].body.max_tokens, 1600);
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.equal("temperature" in calls[1].body, false);
  assert.equal("thinking" in calls[1].body, false);
});

test("Local Qwen preserves tools and tool_choice in reasoning mode", async () => {
  let body;
  const service = new LocalQwenChatService(createConfig(), {
    logger: createLogger(),
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return completionResponse("searched reply");
    },
  });

  const reply = await service.createCompletion(
    [
      { role: "system", content: "system" },
      { role: "user", content: "用户消息：联网搜索今天的消息" },
    ],
    {
      webSearch: true,
      thinking: true,
    },
  );

  assert.equal(reply, "searched reply");
  assert.equal(Array.isArray(body.tools), true);
  assert.equal(body.tools.length > 0, true);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.reasoning_effort, "high");
  assert.equal("thinking" in body, false);
});

test("AI router prefers healthy Qwen and falls back to DeepSeek for the complete turn", async () => {
  const config = createConfig();
  const logger = createLogger();
  const qwenCalls = [];
  const deepseekCalls = [];
  const qwen = createQwenStub({
    async createCompletion(messages, options) {
      qwenCalls.push({ messages, options });
      throw new LocalQwenRequestError("Local Qwen API 503: unavailable", { status: 503 });
    },
  });
  const deepseek = createDeepSeekStub({
    async createCompletion(messages, options) {
      deepseekCalls.push({ messages, options });
      return "DeepSeek fallback";
    },
  });
  const service = new AiChatService(config, {
    logger,
    localQwenService: qwen,
    deepseekService: deepseek,
  });

  const reply = await service.chat("group:user", "联网搜索 深度思考 测试", {
    senderName: "Tester",
    webSearch: true,
    thinking: true,
  });

  assert.equal(reply, "DeepSeek fallback");
  assert.equal(qwenCalls.length, 1);
  assert.equal(deepseekCalls.length, 1);
  assert.deepEqual(qwenCalls[0].options, { webSearch: true, thinking: true });
  assert.deepEqual(deepseekCalls[0].options, { webSearch: true, thinking: true });
  assert.equal(qwen.health, false);
  assert.match(logger.lines.join("\n"), /fallback=deepseek/);
});

test("AI router keeps at most 100 recent Qwen history messages as complete turns", async () => {
  const config = createConfig();
  let capturedMessages = [];
  let callCount = 0;
  const qwen = createQwenStub({
    async createCompletion(messages) {
      capturedMessages = messages;
      callCount += 1;
      return `reply-${callCount}`;
    },
  });
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: createDeepSeekStub({ configured: false }),
  });

  for (let index = 0; index < 52; index += 1) {
    await service.chat("group:user", `question-${index}`);
  }

  const history = capturedMessages.slice(1, -1);
  assert.equal(history.length, 100);
  assert.match(capturedMessages[0].content, /最后一条 user 消息/);
  assert.match(capturedMessages[0].content, /不能为了简短省略/);
  assert.equal(history[0].role, "user");
  assert.equal(history[0].content, "question-1");
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(capturedMessages.at(-1).content, "用户消息：question-51");
});

test("DeepSeek fallback keeps its existing 16-message and character trimming path", async () => {
  const config = createConfig();
  let capturedMessages = [];
  const deepseek = createDeepSeekStub({
    async createCompletion(messages) {
      capturedMessages = messages;
      return "DeepSeek reply";
    },
  });
  const qwen = createQwenStub({ healthy: false });
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: deepseek,
  });

  for (let index = 0; index < 20; index += 1) {
    await service.chat("group:user", `question-${index}`);
  }

  assert.equal(capturedMessages.length, 18);
  assert.equal(capturedMessages[0].role, "system");
  assert.equal(capturedMessages[1].role, "user");
  assert.equal(capturedMessages.at(-1).content, "用户消息：question-19");
  assert.equal(deepseek.trimCalls > 0, true);
});

test("Qwen keeps only the newest 10 images while DeepSeek receives text placeholders", async () => {
  const config = createConfig();
  const images = Array.from({ length: 12 }, (_, index) => {
    return `data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`;
  });
  let qwenMessages;
  const qwen = createQwenStub({
    async createCompletion(messages) {
      qwenMessages = messages;
      return "vision reply";
    },
  });
  const qwenService = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: createDeepSeekStub(),
  });

  await qwenService.chat("group:qwen", "", { images });
  const qwenContent = qwenMessages.at(-1).content;
  assert.equal(qwenContent.filter((part) => part.type === "image_ref").length, 10);
  assert.equal(
    qwenContent.filter((part) => part.type === "text" && part.text === "[较早图片已省略]").length,
    2,
  );

  let deepseekMessages;
  const deepseek = createDeepSeekStub({
    async createCompletion(messages) {
      deepseekMessages = messages;
      return "text fallback";
    },
  });
  const fallbackService = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({ healthy: false }),
    deepseekService: deepseek,
  });

  await fallbackService.chat("group:deepseek", "", { images });
  assert.equal((deepseekMessages.at(-1).content.match(/\[图片\]/g) || []).length, 12);
});

test("Qwen multimodal preparation converts only the latest 10 inline images", async () => {
  const config = createConfig();
  const content = [{ type: "text", text: "look" }];
  for (let index = 0; index < 12; index += 1) {
    content.push({
      type: "image_ref",
      source: `data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`,
    });
  }

  const prepared = await prepareQwenMessages(
    [{ role: "user", content }],
    config,
    async () => {
      throw new Error("network fetch must not be called for data URLs");
    },
    createLogger(),
  );

  assert.equal(prepared[0].content.filter((part) => part.type === "image_url").length, 10);
  assert.equal(
    prepared[0].content.filter((part) => part.text === "[较早图片已省略]").length,
    2,
  );
});

test("OneBot array and CQ image formats are normalized and deduplicated", () => {
  const url = "https://image.example/one.png?x=1,2";
  const encodedUrl = encodeURIComponent(url);
  const message = {
    message: [
      { type: "image", data: { url } },
      { type: "image", data: { url } },
    ],
    raw_message: `[CQ:image,file=test.png,url=${encodedUrl}]`,
  };

  assert.deepEqual(extractImageSources(message), [url]);
});

test("Qwen context trimming removes oldest complete turns and preserves the latest user message", () => {
  const config = {
    ...createConfig(),
    localQwenContextTokens: 1800,
    localQwenContextSafetyTokens: 100,
    localQwenMaxOutputTokens: 100,
  };
  const messages = [{ role: "system", content: "system" }];
  for (let index = 0; index < 8; index += 1) {
    messages.push({ role: "user", content: `u${index}-${"问".repeat(300)}` });
    messages.push({ role: "assistant", content: `a${index}-${"答".repeat(300)}` });
  }
  messages.push({ role: "user", content: "latest question" });

  const trimmed = trimQwenMessagesToBudget(
    messages,
    config,
    config.localQwenMaxOutputTokens,
  );

  assert.equal(trimmed[0].role, "system");
  assert.equal(trimmed[1].role, "user");
  assert.equal(trimmed.at(-1).content, "latest question");
  assert.equal(trimmed.length < messages.length, true);
});

test("DeepSeek request body remains unchanged", () => {
  const config = createConfig();
  const service = new DeepSeekChatService(config);
  const messages = [{ role: "user", content: "hello" }];

  assert.deepEqual(service.buildCompletionBody(messages, false), {
    model: "deepseek-v4-flash",
    messages,
    stream: false,
    max_tokens: 1600,
    thinking: { type: "disabled" },
    temperature: 0.7,
  });
  assert.deepEqual(service.buildCompletionBody(messages, true), {
    model: "deepseek-v4-pro",
    messages,
    stream: false,
    max_tokens: 3200,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
});

test("provider logs redact API keys", async () => {
  const config = createConfig();
  const logger = createLogger();
  const service = new LocalQwenChatService(config, {
    logger,
    fetch: async () => {
      return new Response(`bad key ${config.localQwenApiKey}`, { status: 401 });
    },
  });

  assert.equal(await service.checkHealth(), false);
  assert.equal(logger.lines.join("\n").includes(config.localQwenApiKey), false);
  assert.match(logger.lines.join("\n"), /<redacted>/);
});

function createConfig() {
  return {
    localQwenEnabled: true,
    localQwenProviderId: "local-qwen-manual",
    localQwenDisplayName: "Local Qwen Manual",
    localQwenApiKey: "sk-test-local-qwen",
    localQwenBaseUrl: "http://qwen.mock/v1",
    localQwenModel: "qwen3.6-local",
    localQwenSystemPrompt: "Qwen system",
    localQwenDialoguePrompt: "最后一条 user 消息是当前必须回答的问题",
    localQwenConcisePrompt: "不能为了简短省略答案成立所必需的条件",
    localQwenHealthPath: "/models",
    localQwenHealthIntervalMs: 10000,
    localQwenHealthTimeoutMs: 1000,
    localQwenTimeoutMs: 1000,
    localQwenContextTokens: 262144,
    localQwenContextSafetyTokens: 4096,
    localQwenModelMaxOutputTokens: 16384,
    localQwenMaxOutputTokens: 800,
    localQwenThinkingMaxOutputTokens: 1600,
    localQwenTemperature: 0.7,
    localQwenReasoningEffort: "high",
    localQwenMaxHistoryMessages: 100,
    localQwenMaxImages: 10,
    localQwenImageTokenEstimate: 4096,
    localQwenImageFetchTimeoutMs: 1000,
    localQwenImageMaxBytes: 8 * 1024 * 1024,
    localQwenImagesMaxTotalBytes: 32 * 1024 * 1024,
    deepseekApiKey: "sk-test-deepseek",
    deepseekBaseUrl: "http://deepseek.mock",
    deepseekModel: "deepseek-v4-flash",
    deepseekSystemPrompt: "DeepSeek system",
    responseNeutralityPrompt: "Neutral",
    deepseekTimeoutMs: 30000,
    deepseekThinkingTimeoutMs: 60000,
    deepseekMaxOutputTokens: 1600,
    deepseekThinkingMaxOutputTokens: 3200,
    deepseekTemperature: 0.7,
    deepseekReasoningEffort: "high",
    webSearchMaxToolRounds: 2,
    webSearchMaxToolCallsPerRound: 2,
    ambientChatSystemPrompt: "Ambient",
    ambientChatMaxOutputTokens: 180,
    ambientChatTimeoutMs: 12000,
    chatMaxHistoryMessages: 16,
    chatMaxContextChars: 12000,
    chatSessionTtlMinutes: 120,
  };
}

function createQwenStub(overrides = {}) {
  const stub = {
    configured: overrides.configured ?? true,
    health: overrides.healthy ?? true,
    isConfigured() {
      return this.configured;
    },
    isHealthy() {
      return this.configured && this.health;
    },
    buildSystemPrompt(prompt) {
      return prompt;
    },
    async createCompletion() {
      return "Qwen reply";
    },
    async quickReply() {
      return "Qwen quick reply";
    },
    markUnavailable() {
      this.health = false;
    },
    async startHealthChecks() {
      return this.health;
    },
    stopHealthChecks() {},
    ...overrides,
  };
  return stub;
}

function createDeepSeekStub(overrides = {}) {
  const stub = {
    configured: overrides.configured ?? true,
    trimCalls: 0,
    isConfigured() {
      return this.configured;
    },
    buildSystemPrompt(prompt) {
      return prompt;
    },
    trimMessages(messages) {
      this.trimCalls += 1;
      return messages;
    },
    async createCompletion() {
      return "DeepSeek reply";
    },
    async quickReply() {
      return "DeepSeek quick reply";
    },
    ...overrides,
  };
  return stub;
}

function createLogger() {
  const lines = [];
  return {
    lines,
    log(...values) {
      lines.push(values.join(" "));
    },
    warn(...values) {
      lines.push(values.join(" "));
    },
    error(...values) {
      lines.push(values.join(" "));
    },
  };
}

function completionResponse(content) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
