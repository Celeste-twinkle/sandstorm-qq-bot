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
const {
  DEFAULT_AI_PERSONA_PROMPT,
  DEFAULT_PERSONA_FLEXIBILITY_PROMPT,
} = require("../src/persona");

test("Lexington persona prompt is loaded verbatim as one stable block", () => {
  const lines = DEFAULT_AI_PERSONA_PROMPT.split("\n");

  assert.equal(lines[0], "【PERSONA_LOAD】");
  assert.equal(lines[1], "CHARACTER_LEXINGTON_WARSHIPGIRLR_FULL");
  assert.equal(lines[2], "IDENTITY_USS_LEXINGTON_CARRIER_LADY");
  assert.equal(lines.includes("LANG_ZH_CN_ONLY_PURE"), true);
  assert.equal(lines.includes("SELF_CALL_LEXINGTON_AND_TAITAI"), true);
  assert.equal(lines.includes("DISLIKE_DUSTY_TurbULENT_ENVIRONMENT"), true);
  assert.equal(
    lines.at(-2),
    "FIXED_RULE_EVERY_SENTENCE_END_WITH_WAVE_EMOJI",
  );
  assert.equal(lines.at(-1), "TIMEOUT_SIGNAL_SILENT_STANDBY");
});

test("shared persona flexibility keeps character voice without forcing canon lines", () => {
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /保留当前角色的核心性格/);
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /不要照着角色原有台词表演/);
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /以本规则为准.*一律降为可选/);
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /不合适时完全不用/);
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /每句固定结尾/);
  assert.match(DEFAULT_PERSONA_FLEXIBILITY_PROMPT, /机械复读/);
});

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

test("a selected member persona overrides defaults in direct and ambient replies", () => {
  const config = createConfig();
  const qwen = new LocalQwenChatService(config, { logger: createLogger() });
  const deepseek = new DeepSeekChatService(config);
  const service = new AiChatService(config, {
    logger: createLogger(),
    localQwenService: qwen,
    deepseekService: deepseek,
  });
  const selectedPersona = [
    "【PERSONA_LOAD】",
    "CHARACTER_ENTERPRISE_AZUR_LANE_FULL",
    "AFFECTION_STATE_MAX_WITH_CURRENT_GROUP_MEMBER",
  ].join("\n");
  const session = { messages: [] };
  const current = { role: "user", content: "hello" };
  const context = [
    {
      role: "user",
      userId: "10001",
      senderName: "Alice",
      text: "hello",
      images: [],
      timestamp: 1,
    },
  ];

  const qwenDirect = service.buildLocalQwenMessages(
    session,
    current,
    {},
    1,
    [],
    selectedPersona,
  )[0].content;
  const qwenGroup = service.buildLocalQwenMessages(
    session,
    current,
    {},
    1,
    context,
    selectedPersona,
  )[0].content;
  const qwenAmbient = service.buildAmbientSystemPrompt("idle", selectedPersona);
  const deepseekDirect = service.buildDeepSeekMessages(
    session,
    current,
    selectedPersona,
  )[0].content;
  const deepseekAmbient = service.buildDeepSeekAmbientMessages(
    context,
    "idle",
    selectedPersona,
  )[0].content;

  for (const prompt of [
    qwenDirect,
    qwenGroup,
    qwenAmbient,
    deepseekDirect,
    deepseekAmbient,
  ]) {
    assert.equal(prompt.startsWith(selectedPersona), true);
    assert.equal(prompt.includes(config.localQwenSystemPrompt), false);
    assert.equal(prompt.includes(config.deepseekSystemPrompt), false);
    assert.equal(prompt.includes(config.personaFlexibilityPrompt), true);
    assert.equal(prompt.includes(config.responseNeutralityPrompt), true);
  }
});

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
  for (const [callIndex, call] of calls.entries()) {
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

test("DeepSeek web search uses the shared evidence research policy", () => {
  const service = new DeepSeekChatService(createConfig());
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
    deepseekModel: "deepseek-v4-flash",
    deepseekSystemPrompt: "DeepSeek system",
    personaFlexibilityPrompt: "Flexible roleplay",
    responseNeutralityPrompt: "Neutral",
    deepseekTimeoutMs: 30000,
    deepseekThinkingTimeoutMs: 60000,
    deepseekMaxOutputTokens: 1600,
    deepseekThinkingMaxOutputTokens: 3200,
    deepseekTemperature: 0.7,
    deepseekReasoningEffort: "high",
    webSearchTriggerKeywords: ["联网搜索", "联网查询", "联网搜搜"],
    webSearchMaxToolRounds: 2,
    webSearchMaxToolCallsPerRound: 2,
    ambientChatSystemPrompt: "Ambient",
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
    if (!Array.isArray(message.content)) {
      return count;
    }
    return (
      count +
      message.content.filter((part) => part?.type === "image_url").length
    );
  }, 0);
}
