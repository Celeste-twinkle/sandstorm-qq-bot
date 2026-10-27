const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AiChatService,
  extractImageSources,
  extractSemanticMessageText,
  isRepeatedOwnReply,
  trimQwenMessagesToBudget,
} = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const {
  LocalQwenChatService,
  LocalQwenRequestError,
  prepareQwenMessages,
} = require("../src/qwen");
const {
  DEFAULT_AI_PERSONA_PROMPT,
} = require("../src/persona");
const { AmbientReplyGuard } = require("../src/ambient-chat");

test("the default whale persona allows casual group conversation and playful nonsense", () => {
  const lines = DEFAULT_AI_PERSONA_PROMPT.split("\n");

  assert.equal(lines[0], "【PERSONA_LOAD】");
  assert.match(DEFAULT_AI_PERSONA_PROMPT, /大肥鱼.*蓝色鲸鱼娘/);
  assert.match(DEFAULT_AI_PERSONA_PROMPT, /自己的喜恶/);
  assert.match(DEFAULT_AI_PERSONA_PROMPT, /简体中文/);
  assert.match(DEFAULT_AI_PERSONA_PROMPT, /瞎扯.*吹牛/);
  assert.doesNotMatch(DEFAULT_AI_PERSONA_PROMPT, /FIXED_RULE|ALWAYS_LOYAL|TONE_STYLE_/);
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} casual replies use one persona and bypass optional draft review`, async () => {
    const calls = [];
    const capture = async (messages, options) => {
      calls.push({ messages, options });
      return calls.length === 1 ? '{"should_reply":true}' : "能啊，八点我准时到";
    };
    const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: provider,
      personaFlexibilityPrompt: "", naturalChatPrompt: "", ambientChatDraftReviewEnabled: false }, {
      logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
      localQwenService: createQwenStub({ createCompletion: capture }),
    });
    assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "晚上开黑差一个人" }]), "能啊，八点我准时到");
    assert.equal(calls.length, 2);
    const defaultPrompt = provider === "deepseek" ? service.config.deepseekSystemPrompt : service.config.localQwenSystemPrompt;
    assert.equal(calls[1].messages.filter(message => message.role === "system").length, 1);
    assert.equal(calls[1].messages.map(message => message.content).join("\n").split(defaultPrompt).length - 1, 1);
    service.stop();
  });
}

test("own-reply detection allows matching humans, ignores expired records and catches punctuation-only repeats", () => {
  assert.equal(isRepeatedOwnReply([{ role: "user", text: "哈哈" }], "哈哈"), false);
  assert.equal(isRepeatedOwnReply([{ role: "assistant", text: "哈哈" }], "哈哈！"), true);
  assert.equal(isRepeatedOwnReply([{ role: "assistant", content: "对啊\n就这个" }], "对啊，就这个"), false);
  assert.equal(isRepeatedOwnReply([{ role: "assistant", content: "对啊\n就这个" }], "对啊 就这个。"), true);
  assert.equal(isRepeatedOwnReply([{ role: "assistant", text: "我选蓝白" }], "那我更喜欢黑灰"), false);
  const expired = [{ role: "assistant", text: "哈哈", timestamp: 0 },
    ...Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `word-${i}`, timestamp: i + 1 }))];
  assert.equal(isRepeatedOwnReply(expired, "哈哈"), false);
});

test("a queued direct chat discarded by account policy does not call the model", async () => {
  const service = new AiChatService(createConfig());
  let release, calls = 0, allowed = true;
  service.chatUnlocked = async () => { calls++; await new Promise(resolve => { release = resolve; }); return "answer"; };
  const first = service.chat("session", "first");
  await new Promise(setImmediate);
  const second = service.chat("session", "second", { isCurrent: () => allowed });
  allowed = false; release();
  assert.equal(await first, "answer");
  assert.equal(await second, null);
  assert.equal(calls, 1);
  service.stop();
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} self-repeat checking blocks a paraphrase while allowing human echoes and playful new reactions`, async () => {
    const cases = [
      { own: "三个闹钟都吵不过你", human: "笑死，闹钟也要组队", draft: "闹钟群架，最后全输给你", repeat: true },
      { own: "我喜欢蓝白", human: "今晚这风好舒服", draft: "今晚这风好舒服", repeat: false },
      { own: "我喜欢蓝白", human: "上号吗", draft: "来啦，八点上线，我可不送人头", repeat: false },
      { own: "我喜欢蓝白", human: "今天吃了什么", draft: "这个群里今天的晚饭话题真丰富。".repeat(35), repeat: false },
    ];
    for (const item of cases) {
      const calls = [];
      const capture = async (messages, options) => {
        calls.push({ messages, options });
        if (options.responseFormat) {
          assert.match(JSON.stringify(messages), /json/i, "DeepSeek JSON mode requires the word JSON in the prompt");
          return messages[0].content.includes("self_repeat")
            ? JSON.stringify({ self_repeat: item.repeat }) : '{"should_reply":true}';
        }
        return item.draft;
      };
      const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: provider,
        ambientChatDraftReviewEnabled: false, groupChatSelfRepeatCheckEnabled: true }, {
        logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
        localQwenService: createQwenStub({ createCompletion: capture }),
      });
      const context = [{ role: "assistant", text: item.own, timestamp: 1 },
        { role: "user", text: item.human, timestamp: 2 }];
      const skips = [];
      assert.equal(await service.ambientReplyIfAppropriate(context, {}, { onSkip: reason => skips.push(reason) }), item.repeat ? null : item.draft);
      assert.deepEqual(skips, item.repeat ? ["self_repeat"] : []);
      assert.equal(calls.length, 3);
      const check = calls[2];
      assert.equal(check.options.thinking, false);
      assert.equal(check.options.reasoningEffort, "none");
      assert.equal(check.options.maxOutputTokens, 64);
      assert.equal(check.options.decisionOnly, true);
      assert.deepEqual(JSON.parse(check.messages[1].content).history.map(x=>x.role), ["assistant", "user"]);
      assert.equal(await service.chat("group:user", item.human, { groupContextMessages: context }), item.repeat ? null : item.draft);
      assert.equal(calls.length, 5);
      service.stop();
    }
  });
}

test("self-repeat checking skips malformed boolean decisions", async () => {
  const logger = createLogger();
  const service = new AiChatService({ ...createConfig(), groupChatSelfRepeatCheckEnabled: true }, {
    logger, deepseekService: createDeepSeekStub({ createCompletion: async () => '{"self_repeat":"no"}' }),
    localQwenService: createQwenStub({ createCompletion: async () => "not JSON" }),
  });
  assert.equal(await service.checkOwnReplyRepeat([{ role: "assistant", text: "previous" }, { role: "user", text: "next" }], "new"), true);
  assert.match(logger.lines.join("\n"), /self-repeat check failed/);
  service.stop();
});

test("a new message during self-repeat checking invalidates the pending reply", async () => {
  let current = true;
  const capture = async (messages, options) => {
    if (!options.responseFormat) return "新反应";
    if (messages[0].content.includes("self_repeat")) { current = false; return '{"self_repeat":false}'; }
    return '{"should_reply":true}';
  };
  const service = new AiChatService({ ...createConfig(), ambientChatDraftReviewEnabled: false,
    groupChatSelfRepeatCheckEnabled: true }, {
    logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
    localQwenService: createQwenStub({ createCompletion: capture }),
  });
  const reasons = [];
  assert.equal(await service.ambientReplyIfAppropriate([
    { role: "assistant", text: "过去说的话" }, { role: "user", text: "新话题" },
  ], {}, { isCurrent: () => current, onSkip: reason => reasons.push(reason) }), null);
  assert.deepEqual(reasons, ["context_changed"]);
  service.stop();
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} allows short and long human echoes but suppresses its own repeated replies in both paths`, async () => {
    const cases = [
      { role: "user", text: "笑死", draft: "笑死", expected: "笑死" },
      { role: "user", text: "这个故事真的离谱。".repeat(40), draft: "这个故事真的离谱。".repeat(40) },
      { role: "assistant", text: "笑死", draft: "笑死！", expected: null },
      { role: "assistant", text: "刚才这个故事真的离谱。".repeat(40), draft: "刚才这个故事真的离谱。".repeat(40), expected: null },
    ];
    for (const item of cases) {
      const calls = [];
      const capture = async (messages, options) => {
        calls.push({ messages, options });
        return options.responseFormat ? '{"should_reply":true}' : item.draft;
      };
      const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: provider, ambientChatDraftReviewEnabled: false }, {
        logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
        localQwenService: createQwenStub({ createCompletion: capture }),
      });
      const context = [{ role: item.role, text: item.text, timestamp: 1 }, { role: "user", text: "继续聊", timestamp: 2 }];
      const expected = Object.hasOwn(item, "expected") ? item.expected : item.draft;
      const skipped = [];
      assert.equal(await service.ambientReplyIfAppropriate(context, {}, { onSkip: reason => skipped.push(reason) }), expected);
      assert.equal(calls.length, 2, "No extra review or regeneration call");
      assert.deepEqual(skipped, expected === null ? ["self_repeat"] : []);
      assert.equal(await service.chat("group:user", "继续聊", { groupContextMessages: context }), expected);
      assert.equal(calls.length, 3);
      service.stop();
    }
  });
}

test("direct and ambient prompts share persona, flexibility, and sensitivity cache prefix", () => {
  const config = createConfig();
  const qwen = new LocalQwenChatService(config, { logger: createLogger() });
  const deepseek = new DeepSeekChatService(config);
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: deepseek,
  });
  const stableQwenPrefix = `${config.localQwenSystemPrompt}\n\n${config.personaFlexibilityPrompt}\n\n${config.responseNeutralityPrompt}`;
  const stableDeepSeekPrefix = `${config.deepseekSystemPrompt}\n\n${config.personaFlexibilityPrompt}\n\n${config.responseNeutralityPrompt}`;
  const directQwenMessages = service.buildLocalQwenMessages(
    { messages: [] },
    { role: "user", content: "hello" },
    {},
  );
  const directDeepSeekMessages = service.buildDeepSeekMessages(
    { messages: [] },
    { role: "user", content: "hello" },
  );
  const context = [
    {
      role: "user",
      senderName: "Alice",
      text: "hello",
      images: [],
      timestamp: 1,
    },
  ];

  assert.equal(directQwenMessages[0].content.startsWith(stableQwenPrefix), true);
  assert.equal(
    service.buildAmbientSystemPrompt("idle").startsWith(stableQwenPrefix),
    true,
  );
  assert.equal(
    directDeepSeekMessages[0].content.startsWith(stableDeepSeekPrefix),
    true,
  );
  assert.equal(
    service
      .buildDeepSeekAmbientMessages(context, "idle")[0]
      .content.startsWith(stableDeepSeekPrefix),
    true,
  );
  assert.equal(
    directQwenMessages[0].content.indexOf(config.personaFlexibilityPrompt) <
      directQwenMessages[0].content.indexOf(config.responseNeutralityPrompt),
    true,
  );
  assert.equal(
    directQwenMessages[0].content.indexOf(config.responseNeutralityPrompt) <
      directQwenMessages[0].content.indexOf(config.localQwenDialoguePrompt),
    true,
  );
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} uses its default prompt despite obsolete member persona metadata`, async () => {
    const config = { ...createConfig(), aiPrimaryProvider: provider };
    const calls = [];
    const capture = async messages => { calls.push(messages); return "Reply"; };
    const service = new AiChatService(config, {
      logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
      localQwenService: createQwenStub({ createCompletion: capture }),
    });
    const meta = { personaPrompt: "OBSOLETE_MEMBER_PERSONA" };
    const context = [{ role: "user", text: "hello", senderName: "Alice", timestamp: 1 }];
    await service.chat("standalone", "hello", meta);
    await service.chat("group", "hello", { ...meta, groupContextMessages: context });
    await service.ambientReply(context, { ...meta, ambientMode: "instant" });
    const defaultPrompt = provider === "deepseek" ? config.deepseekSystemPrompt : config.localQwenSystemPrompt;
    assert.equal(calls.length, 3);
    for (const messages of calls) {
      assert.ok(messages[0].content.startsWith(defaultPrompt));
      assert.doesNotMatch(JSON.stringify(messages), /OBSOLETE_MEMBER_PERSONA/);
    }
    service.stop();
  });
}

test("inherited Local Qwen quick replies use the Qwen persona, not DeepSeek's", async () => {
  const config = {
    ...createConfig(),
    localQwenSystemPrompt: "Qwen-only persona",
    deepseekSystemPrompt: "DeepSeek-only persona",
  };
  const bodies = [];
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return completionResponse("Qwen quick reply");
    },
  });

  assert.equal(await service.quickReply("hello"), "Qwen quick reply");
  assert.equal(bodies.length, 1);
  assert.equal(
    bodies[0].messages[0].content.startsWith(
      `Qwen-only persona\n\n${config.personaFlexibilityPrompt}\n\n${config.responseNeutralityPrompt}`,
    ),
    true,
  );
  assert.equal(
    bodies[0].messages[0].content.includes("DeepSeek-only persona"),
    false,
  );
});

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

test("Local Qwen uses the model maximum output and strong reasoning for ordinary chat", async () => {
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
  assert.equal(calls[0].body.reasoning_effort, "high");
  assert.equal("temperature" in calls[0].body, false);
  assert.equal("thinking" in calls[0].body, false);
  assert.equal("tools" in calls[0].body, false);

  assert.equal(calls[1].body.max_tokens, 16384);
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.equal("temperature" in calls[1].body, false);
  assert.equal("thinking" in calls[1].body, false);

  assert.equal(calls[2].body.max_tokens, 16384);
  assert.equal(calls[2].body.reasoning_effort, "high");
});

test("Local Qwen accepts max reasoning while background image indexing uses its own effort", async () => {
  const bodies = [];
  const config = {
    ...createConfig(),
    localQwenReasoningEffort: "max",
  };
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const isImageIndexer = String(body.messages?.[0]?.content || "").includes(
        "无损图片 OCR 与视觉语义索引器",
      );
      return completionResponse(
        isImageIndexer
          ? JSON.stringify({
              transcription: "Madame Curie",
              uncertain_text: [],
              image_type_style: "黑白历史人物肖像，低对比。",
              subjects: ["一名成年女性，深色服装，正面半身像"],
              scene_layout: "人物居中，背景简洁，左下角有手写题字。",
              actions_relationships: [],
              salient_details: ["深色高领服装", "柔和侧光"],
              document_ui_structure: "",
              possible_entities: [
                "玛丽·居里；依据为脸部轮廓、发型及时代服饰；中置信度",
              ],
              visual_uncertainties: ["左下角题字较模糊"],
            })
          : "indexed",
      );
    },
  });

  assert.equal(
    await service.createCompletion([{ role: "user", content: "hello" }]),
    "indexed",
  );
  const indexed = await service.analyzeImageForCache({
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  });
  assert.match(indexed, /【逐字转录】\nMadame Curie/);
  assert.match(indexed, /【文字不确定项】/);
  assert.match(indexed, /精确字符必须回看原图核验/);
  assert.match(indexed, /【视觉元数据】/);
  assert.match(indexed, /图片类型与风格：黑白历史人物肖像/);
  assert.match(indexed, /主体：一名成年女性/);
  assert.match(indexed, /可能实体（候选，需结合原图复核）：玛丽·居里/);

  assert.equal(bodies[0].reasoning_effort, "max");
  assert.equal("temperature" in bodies[0], false);
  assert.equal(bodies[1].reasoning_effort, "none");
  assert.equal(bodies[1].temperature, 0);
  assert.equal(bodies[1].max_tokens, 16384);
  assert.equal(bodies[1].response_format.type, "json_schema");
  assert.equal(bodies[1].response_format.json_schema.strict, true);
  assert.deepEqual(
    bodies[1].response_format.json_schema.schema.required,
    [
      "transcription",
      "uncertain_text",
      "image_type_style",
      "subjects",
      "scene_layout",
      "actions_relationships",
      "salient_details",
      "document_ui_structure",
      "possible_entities",
      "visual_uncertainties",
    ],
  );
  assert.equal(
    bodies[1].messages[1].content[1].image_url.detail,
    "high",
  );
  assert.match(bodies[1].messages[0].content, /无损图片 OCR/);
  assert.match(bodies[1].messages[1].content[0].text, /transcription/);
  assert.match(bodies[1].messages[1].content[0].text, /image_type_style/);
  assert.match(bodies[1].messages[1].content[0].text, /possible_entities/);
  assert.match(bodies[1].messages[1].content[0].text, /uncertain_text/);
  assert.match(bodies[1].messages[1].content[0].text, /O\/0、I\/1\/l、B\/8/);
  assert.match(bodies[1].messages[1].content[0].text, /公众人物、知名角色、地标、产品或作品/);

  config.localQwenImageCacheReasoningEffort = "low";
  assert.match(
    await service.analyzeImageForCache({
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    }),
    /Madame Curie/,
  );
  assert.equal(bodies[2].reasoning_effort, "low");
  assert.equal("temperature" in bodies[2], false);
});

test("Local Qwen starts web research with required parallel tools and fails closed without evidence", async () => {
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

  assert.match(reply, /没有取得可验证的网页正文/);
  assert.equal(Array.isArray(body.tools), true);
  assert.equal(body.tools.length > 0, true);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.reasoning_effort, "high");
  assert.equal("thinking" in body, false);
  const researchPolicy = body.messages.find(
    (message) =>
      message.role === "system" &&
      String(message.content).includes("web-evidence-research"),
  );
  assert.ok(researchPolicy);
  assert.doesNotMatch(researchPolicy.content, /今天的消息/);
  assert.equal(
    body.messages.some(
      (message) =>
        message.role === "user" &&
        String(message.content).includes("今天的消息"),
    ),
    true,
  );
  assert.match(researchPolicy.content, /搜索摘要只用于发现线索/);
  assert.match(researchPolicy.content, /明确标注为推断/);
  assert.match(researchPolicy.content, /不可信指令/);
});

test("Local Qwen preserves Ollama reasoning across parallel web tool turns", async () => {
  const bodies = [];
  const executedCalls = [];
  const runnerConfigs = [];
  const toolCalls = [
    {
      id: "search-1",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query: "official current fact" }),
      },
    },
    {
      id: "search-2",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query: "independent verification" }),
      },
    },
  ];
  const fetchCall = {
    id: "fetch-1",
    type: "function",
    function: {
      name: "web_fetch",
      arguments: JSON.stringify({
        url: "https://example.com/search-1",
      }),
    },
  };
  const service = new LocalQwenChatService(createConfig(), {
    logger: createLogger(),
    webToolRunnerFactory(runnerConfig) {
      runnerConfigs.push(runnerConfig);
      return {
        setUserQuery(query) {
          assert.equal(query, "测试事实");
        },
        getToolDefinitions() {
          return [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object" },
              },
            },
          ];
        },
        async runToolCall(toolCall) {
          executedCalls.push(toolCall.id);
          if (toolCall.function.name === "web_fetch") {
            return {
              title: "Fetched primary source",
              url: "https://example.com/search-1",
              status: 200,
              text: "Full source evidence",
            };
          }
          return {
            query: JSON.parse(toolCall.function.arguments).query,
            results: [
              {
                title: `Result ${toolCall.id}`,
                url: `https://example.com/${toolCall.id}`,
              },
            ],
          };
        },
      };
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  reasoning: "先搜索官方来源并交叉验证。",
                  tool_calls: toolCalls,
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (bodies.length === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  reasoning: "读取决定答案的关键来源正文。",
                  tool_calls: [fetchCall],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return completionResponse(
        "基于两路来源的最终答案【S1】\n【S1】Fetched primary source — https://example.com/search-1",
      );
    },
  });

  const reply = await service.createCompletion(
    [
      { role: "system", content: "system" },
      { role: "user", content: "用户消息：联网搜索 测试事实" },
    ],
    { webSearch: true },
  );

  assert.equal(
    reply,
    "基于两路来源的最终答案【S1】\n【S1】Fetched primary source — https://example.com/search-1",
  );
  assert.deepEqual(executedCalls.sort(), ["fetch-1", "search-1", "search-2"]);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].tool_choice, "required");
  assert.equal(bodies[1].tool_choice, "auto");
  assert.equal(bodies[2].tool_choice, "auto");
  assert.equal(bodies[1].parallel_tool_calls, true);
  assert.equal(bodies[2].parallel_tool_calls, true);
  assert.equal(bodies[2].reasoning_effort, "high");
  const assistantToolMessage = bodies[1].messages.find(
    (message) => Array.isArray(message.tool_calls),
  );
  assert.equal(
    assistantToolMessage.reasoning,
    "先搜索官方来源并交叉验证。",
  );
  assert.equal(
    bodies[1].messages.filter((message) => message.role === "tool").length,
    2,
  );
  assert.equal(
    bodies[2].messages.filter((message) => message.role === "tool").length,
    3,
  );
  assert.equal(runnerConfigs[0].webSearchMaxResults, 5);
  assert.equal(runnerConfigs[0].webSearchCandidateResults, 12);
  assert.equal(runnerConfigs[0].webSearchSnippetMaxChars, 500);
  assert.equal(runnerConfigs[0].webFetchMaxChars, 6000);
});

test("Local Qwen does not accept search snippets as final evidence", async () => {
  const bodies = [];
  const config = createConfig();
  config.localQwenWebSearchMaxToolRounds = 1;
  const service = new LocalQwenChatService(config, {
    logger: createLogger(),
    webToolRunnerFactory() {
      return {
        setUserQuery() {},
        getToolDefinitions() {
          return [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object" },
              },
            },
          ];
        },
        async runToolCall() {
          return {
            results: [
              {
                title: "Discovery result",
                url: "https://example.com/discovery",
                snippet: "Unfetched search snippet",
              },
            ],
          };
        },
      };
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "search-only",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: JSON.stringify({ query: "test" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return completionResponse("不应请求没有正文证据的最终答案");
    },
  });

  const reply = await service.createCompletion(
    [{ role: "user", content: "用户消息：联网搜索 测试事实" }],
    { webSearch: true },
  );

  assert.match(reply, /没有取得可验证的网页正文/);
  assert.match(reply, /搜索摘要不能作为最终证据/);
  assert.equal(bodies.length, 1);
});

test("Local Qwen accepts controller-fetched evidence when the model stops after search", async () => {
  const bodies = [];
  const citedAnswer =
    "Verified answer \u3010S1\u3011\n\u3010S1\u3011 Fetched report — https://example.com/report";
  const service = new LocalQwenChatService(createConfig(), {
    logger: createLogger(),
    webToolRunnerFactory() {
      return {
        setUserQuery() {},
        getToolDefinitions() {
          return [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object" },
              },
            },
          ];
        },
        async runToolCall() {
          return {
            evidence_status: "discovery_with_fetched_pages",
            results: [
              {
                title: "Discovery result",
                url: "https://example.com/report",
                snippet: "Discovery-only summary.",
              },
            ],
            auto_fetched_pages: [
              {
                title: "Fetched report",
                url: "https://example.com/report",
                status: 200,
                evidence_status: "fetched_page",
                text: "Readable page evidence.",
              },
            ],
          };
        },
      };
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "search-with-auto-fetch",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: JSON.stringify({ query: "test" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return completionResponse(citedAnswer);
    },
  });

  const reply = await service.createCompletion(
    [{ role: "user", content: "鐢ㄦ埛娑堟伅锛氳仈缃戞悳绱?娴嬭瘯浜嬪疄" }],
    { webSearch: true },
  );

  assert.equal(reply, citedAnswer);
  assert.equal(bodies.length, 2);
  const toolResult = bodies[1].messages.find(
    (message) => message.role === "tool",
  );
  const parsedResult = JSON.parse(toolResult.content);
  assert.equal(parsedResult.auto_fetched_pages[0].source_id, "S1");
  assert.equal(
    parsedResult.auto_fetched_pages[0].evidence_status,
    "fetched_page",
  );
});

test("Local Qwen rejects a citation URL that only shares a fetched-source prefix", async () => {
  const service = new LocalQwenChatService(createConfig(), {
    logger: createLogger(),
    fetch: async () =>
      completionResponse(
        "不可靠结论【S1】\n【S1】Source — https://example.com/article-fake",
      ),
  });
  const sourceCatalog = new Map([
    [
      "https://example.com/article",
      {
        source_id: "S1",
        title: "Source",
        url: "https://example.com/article",
        fetched: true,
      },
    ],
  ]);

  const reply = await service.repairWebResearchCitations(
    [],
    { role: "assistant", content: "draft" },
    "draft",
    sourceCatalog,
    1000,
  );

  assert.match(reply, /未能通过来源引用校验/);
});

test("AI router supports explicitly preferring Qwen and falling back to DeepSeek", async () => {
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

test("AI router defaults to DeepSeek even when Qwen is healthy", async () => {
  const config = { ...createConfig(), aiPrimaryProvider: undefined };
  let qwenCalls = 0;
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({
      async createCompletion() { qwenCalls += 1; return "Qwen reply"; },
    }),
    deepseekService: createDeepSeekStub(),
  });
  assert.equal(await service.chat("group:user", "hello"), "DeepSeek reply");
  assert.equal(await service.quickReply("hello"), "DeepSeek quick reply");
  assert.equal(qwenCalls, 0);
});

test("AI declining to join skips reply generation and does not store judgement in chat history", async () => {
  const calls = [];
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion(messages, options) {
      calls.push({ messages, options });
      return '{"should_reply":false}';
    } }),
  });
  const context = [{ role: "user", messageId: "one", senderName: "Alice", text: "好的", timestamp: 1 }];
  assert.equal(await service.ambientReplyIfAppropriate(context), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.decisionOnly, true);
  assert.equal(calls[0].options.thinking, false);
  assert.equal(calls[0].options.maxOutputTokens, 64);
  assert.equal(service.sessions.size, 0);
});

test("a valid no-reply decision is not overridden by the fallback provider", async () => {
  let qwenCalls = 0;
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(),
    localQwenService: createQwenStub({ async createCompletion() {
      qwenCalls += 1;
      return '{"should_reply":true}';
    } }),
    deepseekService: createDeepSeekStub({ async createCompletion() { return '{"should_reply":false}'; } }),
  });
  assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "thanks" }]), null);
  assert.equal(qwenCalls, 0);
});

test("AI choosing to join generates a reply only after its decision", async () => {
  const calls = [];
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion(messages, options) {
      calls.push({ messages, options });
      if (calls.length === 3) return '{"action":"send"}';
      return options.decisionOnly ? '{"should_reply":true}' : "接话正文";
    } }),
  });
  const context = [{ role: "user", messageId: "one", text: "太太，我怎么查版本？", timestamp: 1 }];
  assert.equal(await service.ambientReplyIfAppropriate(context, { personaPrompt: "Member persona" }), "接话正文");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.decisionOnly, true);
  assert.equal(calls[1].options.decisionOnly, undefined);
  assert.equal(calls[2].options.decisionOnly, true);
  assert.equal(calls[2].options.thinking, false);
  assert.equal(calls[2].options.temperature, 0);
  assert.equal(calls[0].messages[0].content.startsWith(service.config.deepseekSystemPrompt), true);
  assert.equal(calls[1].messages[0].content.startsWith(service.config.deepseekSystemPrompt), true);
});

test("rejected ambient drafts are never returned or rerolled into group history", async () => {
  let calls = 0;
  const skipped = [];
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion(messages) {
      calls += 1;
      if (calls === 1) return '{"should_reply":true}';
      if (calls === 2) return "今晚我上线等你";
      const data = JSON.parse(messages[1].content);
      assert.equal(data.draft, "今晚我上线等你");
      assert.equal(data.history.length, 1);
      return '{"action":"skip"}';
    } }),
  });
  assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "今晚还打吗" }], {}, {
    onSkip: reason => skipped.push(reason),
  }), null);
  assert.equal(calls, 3);
  assert.deepEqual(skipped, ["draft_rejected"]);
  assert.equal(service.sessions.size, 0);
});

test("a new message during ambient draft review prevents delivery", async () => {
  let current = true;
  let calls = 0;
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion() {
      calls += 1;
      if (calls === 2) return "接话";
      if (calls === 3) { current = false; return '{"action":"send"}'; }
      return '{"should_reply":true}';
    } }),
  });
  assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "话题" }], {}, {
    isCurrent: () => current,
  }), null);
  assert.equal(calls, 3);
});

test("ambient review returns only the edited text without a fourth generation call", async () => {
  const calls = [];
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion(messages, options) {
      calls.push({ messages, options });
      return ['{"should_reply":true}', "敲着挺解压，就是别在半夜用。", '{"action":"edit","text":"敲着挺解压。"}'][calls.length - 1];
    } }),
  });
  assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "空格键像盖锅盖" }]), "敲着挺解压。");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.thinking, false);
  assert.equal(calls[2].options.decisionOnly, true);
  assert.equal(calls[2].options.maxOutputTokens, 180);
  assert.equal(service.sessions.size, 0);
});

test("invalid or non-extractive review edits stay silent rather than leaking drafts", async () => {
  for (const review of ['{"action":"edit","text":"我家的键盘也这样。"}', '{"action":"send","reason":"internal"}']) {
    let calls = 0;
    const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
      logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
      deepseekService: createDeepSeekStub({ async createCompletion() {
        return ['{"should_reply":true}', "敲着挺解压。", review][calls++];
      } }),
    });
    assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "空格键像盖锅盖" }]), null);
    assert.equal(calls, 3);
    assert.equal(service.sessions.size, 0);
  }
});

test("stale conversations do not trigger reply generation after a positive AI decision", async () => {
  let calls = 0;
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion() { calls += 1; return '{"should_reply":true}'; } }),
  });
  assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "question" }], {}, {
    isCurrent: () => false,
  }), null);
  assert.equal(calls, 1);
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} accumulates public messages during serial requests and sends a relevant draft`, async () => {
    const context = [{ role: "user", messageId: "h1", text: "下班想吃炒饭", timestamp: 1 }];
    const guard = new AmbientReplyGuard();
    const ticket = guard.begin("g", context);
    let active = 0;
    const calls = [];
    const capture = async (messages, options) => {
      assert.equal(++active, 1, "Requests within a group must stay serial");
      try {
        calls.push({ messages, options });
        if (calls.length === 1) {
          context.push({ role: "user", messageId: "h2", text: "蛋炒饭加火腿", timestamp: 2 });
          return '{"should_reply":true}';
        }
        if (calls.length === 2) {
          assert.match(JSON.stringify(messages), /蛋炒饭加火腿/);
          context.push({ role: "user", messageId: "h3", text: "我还要双倍的蛋", timestamp: 3 });
          return "蛋加双倍，饭是配菜";
        }
        const data = JSON.parse(messages[1].content.split("\n")[1]);
        assert.equal(data.draft, "蛋加双倍，饭是配菜");
        assert.match(JSON.stringify(data.messages), /双倍的蛋/);
        return '{"should_reply":true}';
      } finally { active--; }
    };
    const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: provider,
      ambientChatDraftReviewEnabled: false }, {
      logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
      localQwenService: createQwenStub({ createCompletion: capture }),
    });
    assert.equal(await service.ambientReplyIfAppropriate(context, {}, {
      isCurrent: () => guard.canContinue(ticket, context), getCurrentContext: () => context,
      onContextReviewed: latest => guard.refresh(ticket, latest),
    }), "蛋加双倍，饭是配菜");
    assert.equal(calls.length, 3, "Generate once, check fresh interest without rewriting");
    assert.equal(guard.canSend(ticket, context), true);
    service.stop();
  });
}

test("a stop accumulated during generation suppresses the old draft", async () => {
  const context = [{ role: "user", text: "聊蛋炒饭", timestamp: 1 }];
  let calls = 0;
  const capture = async (messages, options) => {
    calls++;
    if (calls === 1) return '{"should_reply":true}';
    if (!options.decisionOnly) {
      context.push({ role: "user", text: "我们先停，机器人这条不用回", timestamp: 2 });
      return "炒饭多加蛋";
    }
    assert.match(JSON.stringify(messages), /这条不用回/);
    return '{"should_reply":false}';
  };
  const skips = [];
  const service = new AiChatService({ ...createConfig(), ambientChatDraftReviewEnabled: false }, {
    logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
    localQwenService: createQwenStub({ configured: false }),
  });
  assert.equal(await service.ambientReplyIfAppropriate(context, {}, {
    getCurrentContext: () => context, onSkip: reason => skips.push(reason),
  }), null);
  assert.equal(calls, 3);
  assert.deepEqual(skips, ["conversation_moved_on"]);
  service.stop();
});

test("arrivals during the last inference wait for the next cycle without starving this one", async () => {
  const context = [{ role: "user", text: "一个公共话题", timestamp: 1 }];
  let calls = 0;
  const capture = async (_messages, options) => {
    calls++;
    if (calls === 1) return '{"should_reply":true}';
    context.push({ role: "user", text: `新进展${calls}`, timestamp: calls });
    return options.decisionOnly ? '{"should_reply":true}' : "想插一句";
  };
  const service = new AiChatService({ ...createConfig(), ambientChatDraftReviewEnabled: false }, {
    logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
    localQwenService: createQwenStub({ configured: false }),
  });
  let reviewedContext;
  assert.equal(await service.ambientReplyIfAppropriate(context, {}, {
    getCurrentContext: () => context, onContextReviewed: latest => { reviewedContext = latest; },
  }), "想插一句");
  assert.equal(calls, 3);
  assert.equal(reviewedContext.at(-1).text, "新进展2");
  assert.equal(context.at(-1).text, "新进展3");
  service.stop();
});

test("invalid judgement or provider failure keeps the bot silent", async () => {
  for (const result of ["not JSON", '{"should_reply":"yes"}', new Error("API failed")]) {
    const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek" }, {
      logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
      deepseekService: createDeepSeekStub({ async createCompletion() {
        if (result instanceof Error) throw result;
        return result;
      } }),
    });
    assert.equal(await service.ambientReplyIfAppropriate([{ role: "user", text: "hello" }]), null);
  }
});

test("decision requests use 100 chronological text records and a JSON budget", async () => {
  const config = { ...createConfig(), aiPrimaryProvider: "deepseek" };
  let body;
  const service = new AiChatService(config, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: new DeepSeekChatService(config, { fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return completionResponse('{"should_reply":true}');
    } }),
  });
  const context = Array.from({ length: 120 }, (_, index) => ({
    role: index % 4 === 0 ? "assistant" : "user", text: `item-${index}`,
    timestamp: index, images: ["https://image.invalid/not-fetched.png"],
  })).reverse();
  assert.equal(await service.shouldAmbientReply(context, { ambientMode: "idle" }), true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, "user");
  const records = JSON.parse(body.messages[1].content.split("\n")[1]).messages;
  assert.equal(records.length, 100);
  assert.match(records[0].content, /item-20/);
  assert.match(records.at(-1).content, /item-119/);
  assert.equal(records[0].role, "assistant");
  assert.match(body.messages[1].content, /不要生成聊天正文/);
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages.every((message) => typeof message.content === "string"), true);
  assert.equal(body.messages[0].content.includes(config.naturalChatPrompt), false);
});

test("Qwen decision requests disable reasoning and use a small output budget", async () => {
  const config = createConfig();
  let body;
  const qwen = new LocalQwenChatService(config, { logger: createLogger(), fetch: async (_url, options) => {
    body = JSON.parse(options.body);
    return completionResponse('{"should_reply":false}');
  } });
  qwen.healthStatus = "healthy";
  const service = new AiChatService(config, { logger: createLogger(), localQwenService: qwen,
    deepseekService: createDeepSeekStub({ configured: false }) });
  assert.equal(await service.shouldAmbientReply([{ role: "user", text: "晚安" }]), false);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.reasoning_effort, "none");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("DeepSeek failure falls back to Qwen for the entire turn and redacts secrets", async () => {
  const config = { ...createConfig(), aiPrimaryProvider: "deepseek" };
  const logger = createLogger();
  const attempts = [];
  const service = new AiChatService(config, {
    logger,
    deepseekService: createDeepSeekStub({
      async createCompletion() {
        attempts.push("deepseek");
        throw new Error(`DeepSeek API 503: ${config.deepseekApiKey}`);
      },
    }),
    localQwenService: createQwenStub({
      async createCompletion(_messages, options) {
        attempts.push("qwen");
        assert.equal(options.webSearch, true);
        return "Qwen fallback";
      },
    }),
  });
  assert.equal(await service.chat("group:user", "search", { webSearch: true }), "Qwen fallback");
  assert.deepEqual(attempts, ["deepseek", "qwen"]);
  assert.match(logger.lines.join("\n"), /provider=deepseek.*fallback=local-qwen-manual/);
  assert.equal(logger.lines.join("\n").includes(config.deepseekApiKey), false);
});

test("DeepSeek direct and both ambient modes send the same latest 100 group records", async () => {
  const config = { ...createConfig(), aiPrimaryProvider: "deepseek", chatMaxContextChars: 64000 };
  const requests = [];
  const deepseek = new DeepSeekChatService(config, {
    fetch: async (url, options) => {
      assert.equal(url, "http://deepseek.mock/chat/completions");
      requests.push(JSON.parse(options.body));
      return completionResponse("natural reply");
    },
  });
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub(),
    deepseekService: deepseek,
  });
  service.sessions.set("group:user", { messages: [
    { role: "user", content: "obsolete personal history" },
    { role: "assistant", content: "obsolete personal answer" },
  ], updatedAt: Date.now() });
  const context = Array.from({ length: 120 }, (_, index) => ({
    role: index % 4 === 0 ? "assistant" : "user",
    messageId: String(index),
    senderName: index % 4 === 0 ? "Bot" : `Member-${index % 3}`,
    text: `timeline-${index}`,
    images: [],
    timestamp: index * 1000,
    ...(index % 4 === 0 ? { qwenOnly: true } : {}),
  })).reverse();
  await service.chat("group:user", "timeline-69", { groupContextMessages: context });
  await service.ambientReply(context, { ambientMode: "instant" });
  await service.ambientReply(context, { ambientMode: "idle" });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.model, "deepseek-flash");
    assert.equal(request.thinking.type, "disabled");
    const records = request.messages.filter(message => message.role !== "system");
    assert.equal(records.length, 100);
    assert.deepEqual(records.map((message) => message.content.match(/timeline-\d+/)[0]),
      Array.from({ length: 100 }, (_, index) => `timeline-${index + 20}`));
    assert.equal(request.messages.filter((message) => message.role === "assistant").length, 25);
    assert.doesNotMatch(JSON.stringify(request.messages), /obsolete personal/);
    assert.equal(request.messages[0].content.includes(config.naturalChatPrompt), true);
    assert.match(records.at(-1).content, /当前锚点.*timeline-119/);
    assert.equal(request.messages.filter(message => message.role === "system").length, 1);
    assert.equal(request.messages.map(message => message.content).join("\n").split(config.deepseekSystemPrompt).length - 1, 1);
  }
  // Actual sent replies are recorded by OneBot, never appended to a user session.
  assert.equal(service.sessions.get("group:user").messages.length, 2);
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} learned phrasing reaches replies without gating interest`, async () => {
    const calls = [];
    const hint = "有上下文时，一个词也可以表达完整反应。";
    const capture = async (messages, options) => {
      calls.push({ messages, options });
      return ['{"should_reply":true}', "啊？", '{"action":"send"}'][calls.length - 1];
    };
    const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: provider }, {
      logger: createLogger(), deepseekService: createDeepSeekStub({ createCompletion: capture }),
      localQwenService: createQwenStub({ createCompletion: capture }),
    });
    const context = [{ role: "user", text: "临下班说全改", timestamp: 1 }];
    const meta = { groupChatStyle: [{ text: hint, evidence: ["m1"] }] };
    assert.equal(await service.ambientReplyIfAppropriate(context, meta), "啊？");
    assert.ok(!calls[0].messages.some(message => message.role === "system" && message.content.includes(hint)));
    for (const call of calls.slice(1)) assert.ok(call.messages.some(message => message.role === "system" && message.content.includes(hint)));
    const defaultPrompt = provider === "deepseek" ? service.config.deepseekSystemPrompt : service.config.localQwenSystemPrompt;
    assert.ok(calls[1].messages[0].content.includes(defaultPrompt));
    assert.ok(calls[1].messages.at(-1).content.includes(hint));
    assert.ok(!calls[1].messages.at(-1).content.includes(defaultPrompt));
    assert.equal(JSON.parse(calls[2].messages[1].content).draft, "啊？");
    service.stop();
  });

  test(`${provider} ambient judgement, generation and review share 100 records despite legacy small limits`, async () => {
    const config = { ...createConfig(), aiPrimaryProvider: provider,
      ambientChatInstantMaxMessages: 4, ambientChatIdleMaxMessages: 6, localQwenMaxHistoryMessages: 8 };
    const calls = [];
    const capture = async (messages) => {
      calls.push(messages);
      return calls.length % 3 === 1 ? '{"should_reply":true}'
        : calls.length % 3 === 2 ? "A connected reply." : '{"action":"send"}';
    };
    const service = new AiChatService(config, {
      logger: createLogger(),
      deepseekService: createDeepSeekStub({ createCompletion: capture }),
      localQwenService: createQwenStub({ createCompletion: capture }),
    });
    const context = Array.from({ length: 120 }, (_, index) => ({
      role: index % 4 === 0 ? "assistant" : "user", text: `timeline-${index}`,
      senderName: index % 4 === 0 ? "Bot" : `Member-${index % 3}`, timestamp: index,
    })).reverse();
    for (const ambientMode of ["instant", "idle"]) {
      const offset = calls.length;
      assert.equal(await service.ambientReplyIfAppropriate(context, { ambientMode }), "A connected reply.");
      const judgement = JSON.parse(calls[offset][1].content.split("\n")[1]).messages;
      const generation = calls[offset + 1].filter(message => message.role !== "system");
      const review = JSON.parse(calls[offset + 2][1].content).history;
      for (const records of [judgement, generation, review]) {
        assert.equal(records.length, 100);
        assert.deepEqual(records.map(message => message.content.match(/timeline-\d+/)[0]),
          Array.from({ length: 100 }, (_, index) => `timeline-${index + 20}`));
        assert.equal(records.filter(message => message.role === "assistant").length, 25);
        assert.match(records.at(-1).content, /当前锚点.*timeline-119/);
      }
    }
    assert.equal(calls.length, 6);
    assert.equal(context.length, 120);
    assert.equal(context[0].text, "timeline-119");
    service.stop();
  });
}

test("learning evaluates the current module and chat in thinking mode without images or tools", async () => {
  let seen;
  const service = new AiChatService({ ...createConfig(), aiPrimaryProvider: "deepseek", groupChatLearningMaxOutputTokens: 4096 }, {
    logger: createLogger(), localQwenService: createQwenStub({ configured: false }),
    deepseekService: createDeepSeekStub({ async createCompletion(messages, options) {
      seen = { messages, options }; return '{"rules":[]}';
    } }),
  });
  const previous = [{ text: "搜索后自然重述，保留来源。", evidence: ["m1"] }];
  assert.equal(await service.learnGroupChatStyle([{ role: "user", text: "嗯", images: ["https://unused.invalid/image"], timestamp: 1 }], previous), '{"rules":[]}');
  assert.equal(seen.options.thinking, true);
  assert.equal(seen.options.webSearch, false);
  assert.equal(seen.options.reasoningEffort, "high");
  assert.equal(seen.options.backgroundTask, true);
  assert.equal(seen.options.decisionOnly, undefined);
  assert.equal(seen.options.maxOutputTokens, 4096);
  assert.deepEqual(seen.options.responseFormat, { type: "json_object" });
  assert.equal(seen.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(seen.messages), /unused.invalid/);
  assert.equal(JSON.parse(seen.messages[1].content).records[0].text, "嗯");
  assert.deepEqual(JSON.parse(seen.messages[1].content).learning_module, { rules: [{ id: "p1", text: previous[0].text }] });
  assert.equal(service.sessions.size, 0);
});

test("DeepSeek trimming preserves the active persona with an oversized latest message", () => {
  const service = new DeepSeekChatService({ ...createConfig(), chatMaxContextChars: 1000 });
  const messages = service.trimMessages([
    { role: "system", content: "active persona" },
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "新".repeat(2000) },
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.equal(messages[0].content, "active persona");
  assert.equal(messages[1].content.length, 2000);
});

for (const provider of ["deepseek", "local-qwen"]) {
  test(`${provider} learning HTTP request keeps reasoning and a complete JSON budget`, async () => {
    const config = { ...createConfig(), aiPrimaryProvider: provider,
      groupChatLearningMaxOutputTokens: 4096, groupChatLearningReasoningEffort: "high" };
    const bodies = [];
    const service = new AiChatService(config, { logger: createLogger(), fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return completionResponse('{"rules":[]}');
    } });
    service.localQwen.markHealthy("test provider");
    await service.learnGroupChatStyle([{ role: "user", text: "Search answers should sound natural.", timestamp: 1 }]);
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    assert.equal(body.reasoning_effort, "high");
    if (provider === "deepseek") assert.equal(body.thinking.type, "enabled");
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.tools, undefined);
    assert.equal(body.temperature, undefined);
    service.stop();
  });
}

test("group guidance preserves the latest message under a tight budget", () => {
  const config = { ...createConfig(), chatMaxContextChars: 1000 };
  const provider = new DeepSeekChatService(config);
  const service = new AiChatService(config, { deepseekService: provider });
  const messages = service.withGroupReplyGuidance([
    { role: "system", content: "base rules" },
    { role: "assistant", content: "I am the previous persona" },
    { role: "user", content: "新".repeat(2000) },
  ], provider, 1, [{ text: "顺着群里的口语表达自己的想法。", evidence: ["m1"] }]);
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "system"]);
  assert.equal(messages[1].content.length, 2000);
  assert.ok(messages.at(-1).content.includes("顺着群里的口语表达自己的想法"));
  assert.doesNotMatch(JSON.stringify(messages), /previous persona/);
});

test("standalone DeepSeek requests include the current message in the configured 100-message cap", () => {
  const service = new DeepSeekChatService({ ...createConfig(), chatMaxHistoryMessages: 100 });
  const history = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant", content: `history-${index}`,
  }));
  const messages = service.buildMessages({ messages: history }, { role: "user", content: "latest" });
  assert.equal(messages.length, 101);
  assert.equal(messages[1].content, "history-21");
  assert.equal(messages.at(-1).content, "latest");
});

test("AI router caps Qwen history at the configured 100 including the current message", async () => {
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
  assert.equal(history.length, 98);
  assert.equal(capturedMessages.length <= 101, true);
  assert.match(capturedMessages[0].content, /最后一条 user 消息/);
  assert.match(capturedMessages[0].content, /不能为了简短省略/);
  assert.equal(history[0].role, "user");
  assert.equal(history[0].content, "question-2");
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(capturedMessages.at(-1).content, "用户消息：question-51");
});

test("DeepSeek includes the current message in a configured smaller history limit", async () => {
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

  assert.equal(capturedMessages.length, 17);
  assert.equal(capturedMessages[0].role, "system");
  assert.equal(capturedMessages[1].role, "assistant");
  assert.equal(capturedMessages.at(-1).content, "用户消息：question-19");
  assert.equal(deepseek.trimCalls > 0, true);
});

test("Qwen and DeepSeek keep only the newest 10 images", async () => {
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
    qwenContent
      .filter((part) => part.type === "image_ref")
      .every((part) => part.preferOriginal === true),
    true,
  );
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
  const deepseekContent = deepseekMessages.at(-1).content;
  assert.equal(
    deepseekContent.filter((part) => part.type === "image_ref").length,
    10,
  );
  assert.equal(
    deepseekContent.filter(
      (part) => part.type === "text" && part.text === "[较早图片已省略]",
    ).length,
    2,
  );
});

test("DeepSeek attaches the image recovered from the current QQ reply context", async () => {
  const config = createConfig();
  const quotedImage = "https://img.example/quoted.png";
  let deepseekMessages;
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({ healthy: false }),
    deepseekService: createDeepSeekStub({
      async createCompletion(messages) {
        deepseekMessages = messages;
        return "quoted image reply";
      },
    }),
  });

  await service.chat("group:deepseek-quote", "这张图是什么？", {
    groupContextMessages: [
      {
        role: "user",
        senderName: "Tester",
        text: "这张图是什么？",
        images: [quotedImage],
        relation: "QQ引用图片来源：Alice（仅用于定位，不代表语义相关）",
      },
    ],
  });

  assert.equal(
    deepseekMessages.findLast(message => message.role === "user").content.some(
      (part) => part.type === "image_ref" && part.source === quotedImage,
    ),
    true,
  );
});

test("Qwen direct and ambient paths retain 100 group records including bot replies", async () => {
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
  for (const [callIndex, call] of calls.entries()) {
    const records = call.messages.filter(message => message.role !== "system");
    assert.equal(records.length, 100);
    assert.equal(call.messages.slice(1).some((message) => message.role === "assistant"), true);
    assert.match(
      String(
        Array.isArray(call.messages[1].content)
          ? call.messages[1].content[0].text
          : call.messages[1].content,
      ),
      /群成员 Member-0：message-0/,
    );
    assert.match(
      String(
        Array.isArray(records.at(-2).content)
          ? records.at(-2).content[0].text
          : records.at(-2).content,
      ),
      /群成员 Alice：图片 10/,
    );
    const imageParts = call.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "image_ref");
    assert.equal(imageParts.length, 10);
    assert.equal(imageParts.at(-1).source, images[0]);
    assert.equal(
      imageParts.at(-1).preferOriginal,
      callIndex === 0 ? true : undefined,
    );
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
        Array.isArray(records.at(-1).content)
          ? records.at(-1).content[0].text
          : records.at(-1).content,
      ),
      /【当前锚点】.*QQ引用来源：Alice.*仅用于定位，不代表语义相关.*上面这张图片里是什么/,
    );
  }
  assert.equal(calls[0].options.maxOutputTokens, 16384);
  assert.equal(calls[1].options.maxOutputTokens, 16384);
  for (const call of calls) {
    assert.match(call.messages[0].content, /assistant 是你已发过的话/);
    assert.match(call.messages[0].content, /按配置与请求预算保留，从旧到新排列/);
    assert.match(call.messages[0].content, /图片、表情、引用和转发属于所在消息/);
    assert.equal(call.messages.find((message) => message.role === "assistant").content, "这是机器人先前的回复");
    assert.doesNotMatch(JSON.stringify(call.messages), /权重 \d+/);
  }
});

test("flattened forwarded records are visible to Qwen but hidden from DeepSeek", async () => {
  const config = createConfig();
  const forwardedImage = "https://img.example/forwarded-only.png";
  const context = [
    {
      role: "user",
      messageId: "forwarded-record",
      senderName: "Alice",
      text: "",
      images: [],
      qwenText:
        "[合并转发聊天记录（嵌套内容已展平）]\nBob：仅 Qwen 可见的秘密内容",
      qwenImages: [forwardedImage],
      qwenOnly: true,
      hasForwardedContent: true,
      relation: "",
      qwenRelation: "",
      timestamp: 1,
    },
    {
      role: "user",
      messageId: "current-message",
      senderName: "Carol",
      text: "普通的新消息",
      images: [],
      relation: "",
      timestamp: 2,
    },
  ];

  let qwenMessages;
  const qwenService = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({
      async createCompletion(messages) {
        qwenMessages = messages;
        return "Qwen forwarded reply";
      },
    }),
    deepseekService: createDeepSeekStub({ configured: false }),
  });

  assert.equal(
    await qwenService.ambientReply(context, { ambientMode: "idle" }),
    "Qwen forwarded reply",
  );
  const qwenText = qwenMessages
    .map((message) =>
      Array.isArray(message.content)
        ? message.content.map((part) => part.text || "").join("\n")
        : message.content,
    )
    .join("\n");
  assert.match(qwenText, /仅 Qwen 可见的秘密内容/);
  assert.equal(
    qwenMessages
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .some(
        (part) =>
          part.type === "image_ref" && part.source === forwardedImage,
      ),
    true,
  );

  let deepseekMessages;
  const deepseekService = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({ healthy: false }),
    deepseekService: createDeepSeekStub({
      async createCompletion(messages) {
        deepseekMessages = messages;
        return "DeepSeek ambient reply";
      },
    }),
  });

  assert.equal(
    await deepseekService.ambientReply(context, { ambientMode: "idle" }),
    "DeepSeek ambient reply",
  );
  const deepseekText = deepseekMessages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(deepseekText, /仅 Qwen 可见的秘密内容/);
  assert.doesNotMatch(deepseekText, /forwarded-only/);
  assert.match(deepseekText, /普通的新消息/);
});

test("a forwarded-record ambient anchor never falls back to DeepSeek", async () => {
  const config = createConfig();
  let deepseekCalls = 0;
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: createQwenStub({
      async createCompletion() {
        throw new LocalQwenRequestError("Qwen unavailable", { status: 503 });
      },
    }),
    deepseekService: createDeepSeekStub({
      async createCompletion() {
        deepseekCalls += 1;
        return "must not be returned";
      },
    }),
  });
  const context = [
    {
      role: "user",
      messageId: "normal-before-forward",
      senderName: "Alice",
      text: "DeepSeek 原本可见的旧消息",
      images: [],
      relation: "",
      timestamp: 1,
    },
    {
      role: "user",
      messageId: "forward-anchor",
      senderName: "Bob",
      text: "",
      images: [],
      qwenText:
        "[合并转发聊天记录（嵌套内容已展平）]\nCarol：只允许 Qwen 回应",
      qwenImages: [],
      qwenOnly: true,
      hasForwardedContent: true,
      relation: "",
      timestamp: 2,
    },
  ];

  await assert.rejects(
    service.ambientReply(context, { ambientMode: "instant" }),
    /Qwen unavailable/,
  );
  assert.equal(deepseekCalls, 0);
});

test("a Qwen answer based on forwarded records stays out of later DeepSeek history", async () => {
  const config = createConfig();
  let qwenCalls = 0;
  let deepseekMessages;
  const qwen = createQwenStub({
    async createCompletion() {
      qwenCalls += 1;
      return "Qwen 根据转发秘密生成的总结";
    },
  });
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: createDeepSeekStub({
      async createCompletion(messages) {
        deepseekMessages = messages;
        return "DeepSeek later reply";
      },
    }),
  });

  await service.chat("group:user", "总结引用内容", {
    qwenForwardedContext: true,
    groupContextMessages: [
      {
        role: "user",
        senderName: "Alice",
        text: "总结引用内容",
        images: [],
        qwenText:
          "总结引用内容\n\n[合并转发聊天记录（嵌套内容已展平）]\nBob：转发秘密",
        qwenImages: [],
        hasForwardedContent: true,
      },
    ],
  });
  assert.equal(qwenCalls, 1);

  qwen.health = false;
  assert.equal(
    await service.chat("group:user", "普通后续问题"),
    "DeepSeek later reply",
  );
  const deepseekText = deepseekMessages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(deepseekText, /转发秘密/);
  assert.doesNotMatch(deepseekText, /Qwen 根据转发秘密生成的总结/);
  assert.doesNotMatch(deepseekText, /总结引用内容/);
  assert.match(deepseekText, /普通后续问题/);
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

test("Qwen reuses cached visual metadata for history but isolates a requested original image", async () => {
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
        "无损图片 OCR 与视觉语义索引器",
      );
      return completionResponse(
        isImageIndexer
          ? JSON.stringify({
              transcription: "第 1 题，当 x→0 时……",
              visual_metadata: "图片类型：高等数学试卷。",
              uncertain_text: [],
            })
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
  const requestedOriginalMessages = createMessages();
  requestedOriginalMessages[0].content[1].preferOriginal = true;
  assert.equal(
    await service.createCompletion(requestedOriginalMessages),
    "main reply",
  );

  assert.equal(calls.length, 4);
  assert.equal(countRequestImages(calls[0]), 1);
  assert.equal(countRequestImages(calls[1]), 1);
  assert.equal(calls[1].max_tokens, 16384);
  assert.equal(countRequestImages(calls[2]), 0);
  assert.match(JSON.stringify(calls[2].messages), /图片语义缓存/);
  assert.match(JSON.stringify(calls[2].messages), /高等数学试卷/);
  assert.equal(countRequestImages(calls[3]), 1);
  assert.equal(calls[3].reasoning_effort, "high");
  assert.doesNotMatch(JSON.stringify(calls[3].messages), /图片预索引元数据/);
  assert.doesNotMatch(JSON.stringify(calls[3].messages), /高等数学试卷/);
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
        "无损图片 OCR 与视觉语义索引器",
      );
      if (isImageIndexer) {
        return completionResponse(
          JSON.stringify({
            transcription: "第 1 题，当 x→0 时，答案为 B。",
            visual_metadata: "数学题截图。",
            uncertain_text: [],
          }),
        );
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

test("DeepSeek uses the configured vision model in normal and thinking modes", () => {
  const config = createConfig();
  const service = new DeepSeekChatService(config);
  const messages = [{ role: "user", content: "hello" }];

  assert.deepEqual(service.buildCompletionBody(messages, false), {
    model: "deepseek-flash",
    messages,
    stream: false,
    max_tokens: 1600,
    thinking: { type: "disabled" },
    temperature: 0.7,
  });
  assert.deepEqual(service.buildCompletionBody(messages, true), {
    model: "deepseek-flash",
    messages,
    stream: false,
    max_tokens: 3200,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
});

test("A/B requests can use max thinking without changing subsequent default replies", async () => {
  const config = createConfig();
  const bodies = [];
  const service = new DeepSeekChatService(config, {
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({ choices: [{ message: {
        role: "assistant", content: "visible reply", reasoning_content: "private analysis",
      }, finish_reason: "stop" }] }), { status: 200 });
    },
  });
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(await service.createCompletion(messages), "visible reply");
  assert.equal(await service.createCompletion(messages, {
    thinking: true, reasoningEffort: "max", maxOutputTokens: 8192,
  }), "visible reply");
  assert.equal(await service.createCompletion(messages), "visible reply");
  assert.deepEqual(bodies.map((body) => body.thinking.type), ["disabled", "enabled", "disabled"]);
  assert.equal(bodies[1].reasoning_effort, "max");
  assert.equal(bodies[1].max_tokens, 8192);
  assert.equal("temperature" in bodies[1], false);
  assert.equal(config.deepseekReasoningEffort, "high");
  assert.equal(config.deepseekThinkingEnabled, false);
});

test("DeepSeek OCR is demand-driven and reuses one cached result per image digest", async () => {
  const config = createConfig();
  const bodies = [];
  const bytes = Buffer.from("same-image-content");
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const legacyBase64 = `base64://${bytes.toString("base64")}`;
  const service = new DeepSeekChatService(config, {
    logger: createLogger(),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (body.response_format?.type === "json_object") {
        return completionResponse(
          JSON.stringify({
            transcription: "OCR text",
            uncertain_text: [],
          }),
        );
      }
      return completionResponse("DeepSeek vision reply");
    },
  });

  assert.equal(await service.prewarmImages([dataUrl, legacyBase64]), 0);
  assert.equal(bodies.length, 0);

  assert.equal(
    await service.createCompletion([
      {
        role: "assistant",
        content: [
          { type: "text", text: "历史回复" },
          { type: "image_ref", source: dataUrl },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "这张图是什么？" },
          { type: "image_ref", source: dataUrl, preferOriginal: true },
        ],
      },
    ]),
    "DeepSeek vision reply",
  );
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].response_format, undefined);
  assert.equal(countRequestImages(bodies[0]), 1);

  assert.equal(
    await service.createCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: "提取这张图里的文字" },
          { type: "image_ref", source: legacyBase64, preferOriginal: true },
        ],
      },
    ]),
    "DeepSeek vision reply",
  );

  assert.equal(
    await service.createCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: "OCR 这张图片" },
          { type: "image_ref", source: dataUrl, preferOriginal: true },
        ],
      },
    ]),
    "DeepSeek vision reply",
  );

  const ocrBodies = bodies.filter(
    (body) => body.response_format?.type === "json_object",
  );
  const reasoningBodies = bodies.filter((body) => !body.response_format);
  assert.equal(ocrBodies.length, 1);
  assert.equal(reasoningBodies.length, 3);
  assert.equal(bodies[1], ocrBodies[0]);
  assert.equal(bodies[2], reasoningBodies[1]);
  assert.equal(bodies[3], reasoningBodies[2]);
  assert.equal(ocrBodies[0].model, "deepseek-flash");
  assert.equal(ocrBodies[0].temperature, 0);
  assert.equal(countRequestImages(ocrBodies[0]), 1);
  assert.equal(countRequestImages(reasoningBodies[0]), 1);
  assert.equal(countRequestImages(reasoningBodies[1]), 0);
  assert.equal(countRequestImages(reasoningBodies[2]), 0);
  assert.equal(
    JSON.stringify(reasoningBodies[1].messages).includes("OCR text"),
    true,
  );
  assert.equal(
    JSON.stringify(reasoningBodies[2].messages).includes("OCR text"),
    true,
  );
  assert.equal(
    bodies.filter((body) => body.response_format?.type === "json_object").length,
    1,
  );
});

test("Qwen OCR cache is reused by DeepSeek after a provider fallback", async () => {
  const config = {
    ...createConfig(),
    localQwenImageCacheEnabled: true,
  };
  const calls = [];
  const dataUrl = `data:image/png;base64,${Buffer.from("shared-image").toString("base64")}`;
  const service = new AiChatService(config, {
    logger: createLogger(),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (body.response_format?.type === "json_schema") {
        return completionResponse(
          JSON.stringify({
            transcription: "shared OCR",
            uncertain_text: [],
            image_type_style: "test image",
            subjects: [],
            scene_layout: "",
            actions_relationships: [],
            salient_details: [],
            document_ui_structure: "",
            possible_entities: [],
            visual_uncertainties: [],
          }),
        );
      }
      return completionResponse("DeepSeek fallback vision reply");
    },
  });
  service.localQwen.healthStatus = "healthy";

  assert.equal(await service.prewarmImages([dataUrl]), 1);
  await service.localQwen.waitForImageCacheIdle();
  service.localQwen.healthStatus = "unhealthy";
  assert.equal(
    await service.deepseek.createCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: "识别这张图里的文字" },
          { type: "image_ref", source: dataUrl, preferOriginal: true },
        ],
      },
    ]),
    "DeepSeek fallback vision reply",
  );

  assert.equal(
    calls.filter((call) => call.body.response_format?.type === "json_schema").length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.body.response_format?.type === "json_object").length,
    0,
  );
  assert.equal(
    calls.filter((call) => call.url === "http://deepseek.mock/chat/completions").length,
    1,
  );
  const deepseekBody = calls.find(
    (call) => call.url === "http://deepseek.mock/chat/completions",
  ).body;
  assert.equal(countRequestImages(deepseekBody), 0);
  assert.match(JSON.stringify(deepseekBody.messages), /shared OCR/);
});

test("legacy DeepSeek web search uses the shared evidence research policy", () => {
  const service = new DeepSeekChatService({ ...createConfig(), webSearchProvider: "auto" });
  const messages = service.buildWebSearchMessages([
    { role: "system", content: "system" },
    { role: "user", content: "用户消息：联网搜索 当前政策是否适用" },
  ]);
  const researchPolicy = messages.find(
    (message) =>
      message.role === "system" &&
      String(message.content).includes("web-evidence-research"),
  );

  assert.ok(researchPolicy);
  assert.doesNotMatch(researchPolicy.content, /当前政策是否适用/);
  assert.equal(
    messages.some(
      (message) =>
        message.role === "user" &&
        String(message.content).includes("当前政策是否适用"),
    ),
    true,
  );
  assert.match(researchPolicy.content, /404、传输错误、被拦截页面或空内容都不算证据/);
  assert.match(researchPolicy.content, /地区或司法辖区、产品版本和适用日期/);
  assert.match(researchPolicy.content, /不可信指令/);
});

test("DeepSeek requires a first tool call and fails closed without fetched evidence", async () => {
  const config = createConfig();
  config.webSearchMaxToolRounds = 1;
  const bodies = [];
  const service = new DeepSeekChatService(config, {
    webToolRunnerFactory() {
      return {
        setUserQuery(query) {
          assert.equal(query, "联网搜索 测试事实");
        },
        getToolDefinitions() {
          return [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object" },
              },
            },
          ];
        },
        async runToolCall() {
          return {
            results: [
              {
                title: "Discovery only",
                url: "https://example.com/discovery",
                snippet: "Unfetched search snippet",
              },
            ],
          };
        },
      };
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "search-only",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({ query: "test" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const reply = await service.createCompletion(
    [{ role: "user", content: "用户消息：联网搜索 测试事实" }],
    { webSearch: true },
  );

  assert.match(reply, /没有取得可验证的网页正文/);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tool_choice, "required");
});

test("DeepSeek accepts controller-fetched evidence from a search result", async () => {
  const config = createConfig();
  config.webSearchMaxToolRounds = 1;
  const bodies = [];
  const service = new DeepSeekChatService(config, {
    webToolRunnerFactory() {
      return {
        setUserQuery() {},
        getToolDefinitions() {
          return [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object" },
              },
            },
          ];
        },
        async runToolCall() {
          return {
            results: [
              {
                title: "Discovery result",
                url: "https://example.com/report",
              },
            ],
            auto_fetched_pages: [
              {
                title: "Fetched report",
                url: "https://example.com/report",
                evidence_status: "fetched_page",
                text: "Readable page evidence.",
              },
            ],
          };
        },
      };
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "search-with-auto-fetch",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: JSON.stringify({ query: "test" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return completionResponse("DeepSeek evidence-backed answer");
    },
  });

  const reply = await service.createCompletion(
    [{ role: "user", content: "鐢ㄦ埛娑堟伅锛氳仈缃戞悳绱?娴嬭瘯浜嬪疄" }],
    { webSearch: true },
  );

  assert.equal(reply, "DeepSeek evidence-backed answer");
  assert.equal(bodies.length, 2);
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
    aiPrimaryProvider: "local-qwen",
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
    localQwenWebResearchEnabled: true,
    localQwenWebResearchTimeoutMs: 120000,
    localQwenWebSearchMaxToolRounds: 4,
    localQwenWebSearchMaxToolCallsPerRound: 4,
    localQwenWebSearchMaxTotalToolCalls: 12,
    localQwenWebSearchMaxResults: 5,
    localQwenWebSearchCandidateResults: 12,
    localQwenWebSearchSnippetMaxChars: 500,
    localQwenWebFetchMaxChars: 6000,
    localQwenWebEvidenceReserveTokens: 48000,
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
    localQwenImageCacheReasoningEffort: "none",
    localQwenImageCacheDetail: "high",
    deepseekApiKey: "sk-test-deepseek",
    deepseekBaseUrl: "http://deepseek.mock",
    deepseekModel: "deepseek-flash",
    deepseekVisionModel: "deepseek-flash",
    deepseekMaxImages: 10,
    deepseekImageDetail: "high",
    deepseekImageFetchTimeoutMs: 1000,
    deepseekImageMaxBytes: 8 * 1024 * 1024,
    deepseekImagesMaxTotalBytes: 32 * 1024 * 1024,
    deepseekImageCacheEnabled: true,
    deepseekImageCacheMaxEntries: 500,
    deepseekImageCacheTtlMinutes: 720,
    deepseekImageCacheMaxChars: 24000,
    deepseekImageCacheTimeoutMs: 60000,
    deepseekImageCacheMaxOutputTokens: 4096,
    deepseekImageCacheDetail: "high",
    deepseekSystemPrompt: "DeepSeek system",
    personaFlexibilityPrompt: "Flexible roleplay",
    naturalChatPrompt: "Optional natural overrides",
    responseNeutralityPrompt: "Neutral",
    deepseekTimeoutMs: 30000,
    deepseekThinkingEnabled: false,
    deepseekThinkingTimeoutMs: 60000,
    deepseekMaxOutputTokens: 1600,
    deepseekThinkingMaxOutputTokens: 3200,
    deepseekTemperature: 0.7,
    deepseekReasoningEffort: "high",
    webSearchTriggerKeywords: ["联网搜索", "联网查询", "联网搜搜"],
    webSearchMaxToolRounds: 2,
    webSearchMaxToolCallsPerRound: 2,
    ambientChatSystemPrompt: "Ambient",
    ambientChatDraftReviewEnabled: true, // Exercise the explicitly optional review path.
    groupChatSelfRepeatCheckEnabled: false, // Self-repeat classifier has dedicated tests.
    ambientChatInstantMaxMessages: 100,
    ambientChatIdleMaxMessages: 100,
    ambientChatContextSeconds: 7200,
    ambientChatMaxOutputTokens: 180,
    ambientChatTimeoutMs: 30000,
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
    buildSystemPrompt(prompt, ...taskPrompts) {
      return [prompt, ...taskPrompts]
        .filter((part) => String(part || "").trim())
        .join("\n\n");
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
    buildSystemPrompt(prompt, ...taskPrompts) {
      return [prompt, ...taskPrompts]
        .filter((part) => String(part || "").trim())
        .join("\n\n");
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
    return count + countMessageImages(message);
  }, 0);
}

function countMessageImages(message) {
  if (!Array.isArray(message?.content)) {
    return 0;
  }
  return message.content.filter((part) => part?.type === "image_url").length;
}
