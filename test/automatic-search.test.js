const assert = require("node:assert/strict");
const test = require("node:test");
const { DeepSeekChatService } = require("../src/deepseek");
const { LocalQwenChatService } = require("../src/qwen");
const { WebToolRunner } = require("../src/webtools");

const messages = [
  { role: "system", content: "Current member persona and chat style" },
  { role: "assistant", content: "Previous actual reply" },
  { role: "user", content: "Current group member message" },
];
const searchCall = {
  id: "search-1", type: "function",
  function: { name: "web_search", arguments: '{"query":"public product release"}' },
};
const searchMessage = { role: "assistant", content: "", tool_calls: [searchCall] };
const evidence = {
  auto_fetched_pages: [{ title: "Release", url: "https://example.com/release",
    evidence_status: "fetched_page", text: "The new release adds export support." }],
};

function fixture(replies, toolResult = {}, overrides = {}) {
  const config = {
    deepseekModel: "deepseek-flash", deepseekBaseUrl: "https://example.invalid",
    deepseekApiKey: "test-key", deepseekThinkingEnabled: false,
    deepseekMaxOutputTokens: 1600, deepseekTemperature: 0.9, deepseekTimeoutMs: 1000,
    webSearchAutoEnabled: true, webSearchMaxToolRounds: 2, webSearchMaxToolCallsPerRound: 2,
    ...overrides,
  };
  const bodies = [];
  const calls = [];
  const service = new DeepSeekChatService(config, {
    webToolRunnerFactory() {
      return {
        setUserQuery() {},
        getToolDefinitions: () => new WebToolRunner(config).getToolDefinitions(),
        async runToolCall(call) { calls.push(call); return toolResult; },
      };
    },
    async fetch(_url, options) {
      const body = JSON.parse(options.body);
      const reply = replies[bodies.length];
      assert.ok(reply, "Unexpected extra model request");
      bodies.push(body);
      return new Response(JSON.stringify({ choices: [{ message: reply, finish_reason: "stop" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  return { service, bodies, calls };
}

test("automatic search allows a normal reply or uncertainty in one request", async () => {
  for (const content of ["哈哈，是有点离谱。", "这个我也不清楚。", "你说的是哪个游戏？"]) {
    const { service, bodies, calls } = fixture([{ role: "assistant", content }]);
    assert.equal(await service.createCompletion(messages, { maxOutputTokens: 180 }), content);
    assert.equal(bodies.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(bodies[0].tool_choice, "auto");
    assert.equal(bodies[0].thinking.type, "disabled");
    assert.equal(bodies[0].max_tokens, 180);
    assert.deepEqual(bodies[0].messages.slice(1), messages.slice(1));
    assert.ok(bodies[0].messages[0].content.startsWith(messages[0].content));
    assert.equal(messages[0].content, "Current member persona and chat style");
  }
});

test("explicit no-tools requests and the configuration switch disable automatic search", async () => {
  for (const [options, config] of [[{ webSearch: false }, {}], [{}, { webSearchAutoEnabled: false }]]) {
    const { service, bodies } = fixture([{ role: "assistant", content: "Direct" }], {}, config);
    await service.createCompletion(messages, options);
    assert.equal(bodies[0].tools, undefined);
    assert.deepEqual(bodies[0].messages, messages);
  }
});

test("participation and structured background decisions never receive web tools", async () => {
  const { service, bodies } = fixture([{ role: "assistant", content: '{"should_reply":false}' }]);
  await service.createCompletion(messages, { webSearch: true, decisionOnly: true,
    responseFormat: { type: "json_object" }, maxOutputTokens: 64, thinking: false });
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].max_tokens, 64);
  assert.deepEqual(bodies[0].messages, messages);
});

test("an automatic search consumes actual evidence and leaves room for a source link", async () => {
  const answer = "加了导出功能。[发布说明](https://example.com/release)";
  const { service, bodies, calls } = fixture([searchMessage, { role: "assistant", content: answer }], evidence);
  assert.equal(await service.createCompletion(messages, { maxOutputTokens: 180, temperature: 0.8 }), answer);
  assert.equal(calls.length, 1);
  assert.equal(bodies[0].tool_choice, "auto");
  assert.equal(bodies[1].max_tokens, 512);
  assert.ok(bodies.every((body) => body.thinking.type === "disabled" && body.temperature === 0.8));
  assert.deepEqual(JSON.parse(bodies[1].messages.at(-1).content), evidence);
});

test("unfetched snippets cannot turn a failed search into a made-up answer", async () => {
  const { service, bodies } = fixture([searchMessage, { role: "assistant", content: "Invented confident answer" }], {
    results: [{ title: "Snippet only", snippet: "Unverified", url: "https://example.com/discovery" }],
  });
  const reply = await service.createCompletion(messages);
  assert.equal(bodies.length, 2);
  assert.equal(reply, "这个我没查到可靠的消息，暂时不确定。");
});

test("automatic search stops at the tool budget and admits uncertainty", async () => {
  const { service, bodies, calls } = fixture([searchMessage], { error: "No results" }, { webSearchMaxToolRounds: 1 });
  assert.equal(await service.createCompletion(messages), "这个我没查到可靠的消息，暂时不确定。");
  assert.equal(bodies.length, 1);
  assert.equal(calls.length, 1);
});

test("Qwen automatic search remains optional instead of starting forced research", async () => {
  const bodies = [];
  const config = { localQwenWebResearchEnabled: true, localQwenModel: "test-qwen",
    localQwenModelMaxOutputTokens: 16384, localQwenReasoningEffort: "high", localQwenTemperature: 0.7,
    webSearchMaxToolRounds: 2, webSearchMaxToolCallsPerRound: 2 };
  const service = new LocalQwenChatService(config);
  service.requestCompletion = async (body) => {
    bodies.push(body);
    return { choices: [{ message: { role: "assistant", content: "不用查也能聊。" } }] };
  };
  assert.equal(await service.createCompletionWithWebTools(messages, false, { webSearch: "auto" }), "不用查也能聊。");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tool_choice, "auto");
  assert.equal(bodies[0].reasoning_effort, "high");
});
