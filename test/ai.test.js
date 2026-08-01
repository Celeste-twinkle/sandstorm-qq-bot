const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AiChatService,
  extractImageSources,
  extractSemanticMessageText,
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

test("Local Qwen always uses the model maximum output limit", async () => {
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
  assert.equal(
    await service.createCompletion(messages, { maxOutputTokens: 180 }),
    "Qwen reply",
  );

  assert.equal(calls[0].url, "http://qwen.mock/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, `Bearer ${config.localQwenApiKey}`);
  assert.equal(calls[0].body.model, "qwen3.6-local");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.max_tokens, 16384);
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal("thinking" in calls[0].body, false);
  assert.equal("reasoning_effort" in calls[0].body, false);

  assert.equal(calls[1].body.max_tokens, 16384);
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.equal("temperature" in calls[1].body, false);
  assert.equal("thinking" in calls[1].body, false);

  assert.equal(calls[2].body.max_tokens, 16384);
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
  assert.deepEqual(qwenCalls[0].options, {
    webSearch: true,
    thinking: true,
    maxOutputTokens: 16384,
  });
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

test("Qwen direct and ambient paths use 100 group records, including bot replies and quoted images", async () => {
  const config = createConfig();
  const images = Array.from(
    { length: 11 },
    (_, index) => `https://img.example/context-${index}.png`,
  );
  const context = Array.from({ length: 87 }, (_, index) => ({
    role: "user",
    messageId: `text-${index}`,
    senderName: `Member-${index % 3}`,
    text: `message-${index}`,
    images: [],
    relation: "",
    timestamp: index,
  }));
  context.push({
    role: "assistant",
    messageId: "bot-prior",
    senderName: "Bot",
    text: "这是机器人先前的回复",
    images: [],
    relation: "",
    timestamp: 87,
  });
  images.forEach((image, index) => {
    context.push({
      role: "user",
      messageId: `image-${index}`,
      senderName: "Alice",
      text: `图片 ${index}`,
      images: [image],
      relation: "",
      timestamp: 88 + index,
    });
  });
  context.push({
    role: "user",
    messageId: "current-question",
    senderName: "Bob",
    text: "上面这张图片里是什么？",
    images: [images[0]],
    relation: "QQ引用来源：Alice“图片 0”（仅用于定位，不代表语义相关）",
    timestamp: 99,
  });
  assert.equal(context.length, 100);

  const calls = [];
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({
      async createCompletion(messages, options) {
        calls.push({ messages, options });
        return "group context reply";
      },
    }),
    deepseekService: createDeepSeekStub({ configured: false }),
  });

  await service.chat("group:bob", "上面这张图片里是什么？", {
    senderName: "Bob",
    groupContextMessages: context,
  });
  await service.ambientReply(context, { ambientMode: "idle" });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.messages.length, 101);
    assert.equal(call.messages.slice(1).some((message) => message.role === "assistant"), true);
    assert.match(
      String(
        Array.isArray(call.messages[1].content)
          ? call.messages[1].content[0].text
          : call.messages[1].content,
      ),
      /【较早参考｜距当前 99 条｜权重 10｜.*禁止单独回应】/,
    );
    assert.match(
      String(
        Array.isArray(call.messages.at(-2).content)
          ? call.messages.at(-2).content[0].text
          : call.messages.at(-2).content,
      ),
      /【高优先级近邻｜距当前 1 条｜权重 90｜只用于理解当前锚点】/,
    );
    const imageParts = call.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "image_ref");
    assert.equal(imageParts.length, 10);
    assert.equal(imageParts.at(-1).source, images[0]);
    assert.equal(
      call.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.text === "[重复图片已在后文引用]"),
      ),
      true,
    );
    assert.match(
      String(
        Array.isArray(call.messages.at(-1).content)
          ? call.messages.at(-1).content[0].text
          : call.messages.at(-1).content,
      ),
      /【当前锚点｜唯一回应对象｜权重 100】.*QQ引用来源：Alice.*仅用于定位，不代表语义相关.*上面这张图片里是什么/,
    );
  }
  assert.equal(calls[0].options.maxOutputTokens, 16384);
  assert.equal(calls[1].options.maxOutputTokens, 16384);
  assert.match(calls[0].messages[0].content, /role=assistant 是你自己先前在群里的回复/);
  assert.match(calls[0].messages[0].content, /其他所有消息都只能用于理解它/);
  assert.match(calls[0].messages[0].content, /QQ 回复\/引用标记仅用于内容定位，不能作为关联判断依据/);
  assert.match(calls[0].messages[0].content, /未通过纯语义门槛时一律忽略/);
  assert.match(calls[1].messages[0].content, /role=assistant 是机器人自己先前的回复/);
  assert.match(calls[1].messages[0].content, /上下文新旧优先级是硬性规则/);
  assert.match(calls[1].messages[0].content, /QQ 的回复\/引用元数据本身不构成语义关联证据/);
  assert.match(calls[1].messages[0].content, /不得因为较早消息更有趣就复活旧话题/);
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

  const imageParts = prepared[0].content.filter((part) => part.type === "image_url");
  assert.equal(
    Buffer.from(imageParts[0].image_url.url.split(",", 2)[1], "base64").toString(),
    "image-2",
  );
  assert.equal(
    Buffer.from(imageParts.at(-1).image_url.url.split(",", 2)[1], "base64").toString(),
    "image-11",
  );

  for (let index = 1; index < prepared[0].content.length; index += 1) {
    assert.notEqual(
      prepared[0].content[index - 1].type === "image_url" &&
        prepared[0].content[index].type === "image_url",
      true,
      "consecutive images must have a text separator",
    );
  }

  const newestImageIndex = prepared[0].content.findLastIndex(
    (part) => part.type === "image_url",
  );
  assert.match(prepared[0].content[newestImageIndex - 1].text, /图片优先级：最新/);
});

test("Qwen reuses cached OCR semantics instead of retransmitting the same image", async () => {
  const config = {
    ...createConfig(),
    localQwenImageCacheEnabled: true,
  };
  const calls = [];
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const isImageIndexer = String(body.messages?.[0]?.content || "").includes(
        "图片 OCR 与语义索引器",
      );
      return completionResponse(
        isImageIndexer
          ? "图片类型：高等数学试卷。OCR：第 1 题，当 x→0 时……"
          : "main reply",
      );
    },
  });
  const source = `data:image/png;base64,${Buffer.from("same-math-image").toString("base64")}`;
  const createMessages = () => [
    {
      role: "user",
      content: [
        { type: "text", text: "识别图片内容" },
        { type: "image_ref", source },
      ],
    },
  ];

  assert.equal(await service.createCompletion(createMessages()), "main reply");
  await service.waitForImageCacheIdle();
  assert.equal(await service.createCompletion(createMessages()), "main reply");

  assert.equal(calls.length, 3);
  assert.equal(countRequestImages(calls[0]), 1);
  assert.equal(countRequestImages(calls[1]), 1);
  assert.equal(calls[1].max_tokens, 16384);
  assert.equal(countRequestImages(calls[2]), 0);
  assert.match(JSON.stringify(calls[2].messages), /图片语义缓存/);
  assert.match(JSON.stringify(calls[2].messages), /高等数学试卷/);
});

test("Qwen automatically retries an unreadable-image reply with newest cached OCR", async () => {
  const config = {
    ...createConfig(),
    localQwenImageCacheEnabled: true,
  };
  const calls = [];
  let mainCallCount = 0;
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const isImageIndexer = String(body.messages?.[0]?.content || "").includes(
        "图片 OCR 与语义索引器",
      );
      if (isImageIndexer) {
        return completionResponse("OCR：第 1 题，当 x→0 时，答案为 B。");
      }

      mainCallCount += 1;
      return completionResponse(
        mainCallCount === 1
          ? "当前环境无法直接识别图片内容。"
          : "识别结果：第 1 题答案为 B。",
      );
    },
  });
  const source = `data:image/png;base64,${Buffer.from("unreadable-first-pass").toString("base64")}`;

  const reply = await service.createCompletion([
    {
      role: "user",
      content: [
        { type: "text", text: "识别图片" },
        { type: "image_ref", source },
      ],
    },
  ]);

  assert.equal(reply, "识别结果：第 1 题答案为 B。");
  assert.equal(calls.length, 3);
  assert.equal(countRequestImages(calls[0]), 1);
  assert.equal(countRequestImages(calls[1]), 1);
  assert.equal(countRequestImages(calls[2]), 0);
  assert.match(JSON.stringify(calls[2].messages), /第 1 题/);
});

test("Qwen prewarms each received image once and reuses its content hash", async () => {
  const config = {
    ...createConfig(),
    localQwenImageCacheEnabled: true,
  };
  const calls = [];
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return completionResponse(`OCR cache ${calls.length}`);
    },
  });
  service.setHealth("healthy", "test");
  const first = `data:image/png;base64,${Buffer.from("prewarm-first").toString("base64")}`;
  const second = `data:image/png;base64,${Buffer.from("prewarm-second").toString("base64")}`;

  assert.equal(await service.prewarmImages([first, second, first]), 2);
  await service.waitForImageCacheIdle();
  assert.equal(await service.prewarmImages([first, second]), 0);
  await service.waitForImageCacheIdle();

  assert.equal(calls.length, 2);
  assert.equal(countRequestImages(calls[0]), 1);
  assert.equal(countRequestImages(calls[1]), 1);
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

test("QQ face, super-face and market-face segments become Qwen-readable semantics", () => {
  const message = {
    message: [
      { type: "face", data: { id: "184", chainCount: 2 } },
      { type: "text", data: { text: " 这也太好笑了 " } },
      {
        type: "mface",
        data: {
          emoji_id: "market-1",
          summary: "[猫猫震惊]",
          url: "https://img.example/market-1.gif",
        },
      },
      {
        type: "image",
        data: {
          file: "marketface",
          summary: "[狗头疑惑]",
          url: "https://img.example/market-2.gif",
        },
      },
    ],
  };

  assert.equal(
    extractSemanticMessageText(message),
    "[QQ表情：笑哭]（连续 2 次） 这也太好笑了 [QQ表情包：猫猫震惊] [QQ表情包：狗头疑惑]",
  );
  assert.deepEqual(extractImageSources(message), [
    "https://img.example/market-1.gif",
    "https://img.example/market-2.gif",
  ]);
});

test("CQ face formats preserve known names and unknown IDs without guessing", () => {
  const message = {
    raw_message:
      "[CQ:at,qq=bot][CQ:face,id=14] [CQ:face,id=99999,resultId=7] [CQ:mface,emoji_id=x,summary=%5B%E5%BC%80%E5%BF%83%E7%8C%AB%5D]",
  };

  assert.equal(
    extractSemanticMessageText(message),
    "[QQ表情：微笑] [QQ表情 ID：99999]（结果 7） [QQ表情包：开心猫]",
  );
});

test("dice and rock-paper-scissors segments retain their interaction meaning", () => {
  assert.equal(
    extractSemanticMessageText({
      message: [
        { type: "dice", data: { result: "6" } },
        { type: "rps", data: { result: "2" } },
      ],
    }),
    "[骰子：6 点] [猜拳：剪刀]",
  );
});

test("Qwen context trimming removes oldest complete turns and preserves the latest user message", () => {
  const config = {
    ...createConfig(),
    localQwenContextTokens: 1800,
    localQwenContextSafetyTokens: 100,
    localQwenModelMaxOutputTokens: 100,
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
    config.localQwenModelMaxOutputTokens,
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
    localQwenTemperature: 0.7,
    localQwenReasoningEffort: "high",
    localQwenMaxHistoryMessages: 100,
    localQwenMaxImages: 10,
    localQwenImageTokenEstimate: 4096,
    localQwenImageFetchTimeoutMs: 1000,
    localQwenImageMaxBytes: 8 * 1024 * 1024,
    localQwenImagesMaxTotalBytes: 32 * 1024 * 1024,
    localQwenImageCacheEnabled: false,
    localQwenImageCacheMaxEntries: 500,
    localQwenImageCacheTtlMinutes: 720,
    localQwenImageCacheMaxChars: 24000,
    localQwenImageCacheTimeoutMs: 120000,
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
    ambientChatInstantMaxMessages: 100,
    ambientChatIdleMaxMessages: 100,
    ambientChatContextSeconds: 7200,
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

function countRequestImages(body) {
  return (body.messages || []).reduce((count, message) => {
    if (!Array.isArray(message.content)) {
      return count;
    }
    return (
      count +
      message.content.filter((part) => part?.type === "image_url").length
    );
  }, 0);
}
