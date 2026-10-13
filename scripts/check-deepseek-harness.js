// Explicit live smoke test: real model/API/web requests, synthetic conversations,
// no OneBot connection. Records token usage without credentials or hidden reasoning.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const { WebToolRunner } = require("../src/webtools");
const { mapAnthropicResponse } = require("../src/vendor/deepseek-harness/search-provider");

const scenarios = [
  { id: "casual", text: "今天只想躺着，不用帮我安排啥。", expected: "no-tools" },
  { id: "native-search", text: "帮我查下 Node.js 官方现在推荐的 LTS 大版本，给我官网链接就行。", expected: "search" },
  { id: "direct-page", text: "读一下 https://nodejs.org/en/about/previous-releases 这个页面，简单说 LTS 和 Current 有啥区别，附链接。", expected: "fetch" },
  { id: "no-search", text: "这次更新加了什么你没把握就说不知道，别联网。", expected: "no-tools" },
  { id: "missing-search-key", text: "帮我查 Node.js 官方推荐的 LTS 大版本；查不到就说不知道。", expected: "search-error", missingSearchKey: true },
];

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false, "This check must not enable chat thinking");
  assert.equal(config.webSearchProvider, "deepseek-official");
  const outputDir = path.resolve(process.argv[2] || "reports/deepseek-harness-native");
  const output = path.join(outputDir, "integration.json");
  assert.ok(!fs.existsSync(output), "Do not overwrite prior test results");
  fs.mkdirSync(outputDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(),
    upstreamRevision: "d743267388641bc76f17c45ce8b4c231aed1d32c",
    method: "Real chat model, native search API and public HTTP fetch. Synthetic group messages; no QQ connection. Missing-key case overrides only the search runner key.",
    configuration: { chatModel: config.deepseekModel, chatThinking: config.deepseekThinkingEnabled,
      searchModel: config.deepseekSearchModel, maxQueries: config.webSearchMaxQueries,
      maxUses: config.deepseekSearchMaxUses, maxToolRounds: config.webSearchMaxToolRounds },
    results: [],
  };
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  for (const scenario of scenarios) {
    const row = { id: scenario.id, prompt: scenario.text, expected: scenario.expected,
      chatRequests: [], nativeSearchRequests: [], nativeSearchResponses: [], tools: [] };
    const testConfig = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false };
    const provider = new DeepSeekChatService(testConfig, {
      webToolRunnerFactory(runnerConfig) {
        const runner = new WebToolRunner({ ...runnerConfig,
          ...(scenario.missingSearchKey ? { deepseekApiKey: "" } : {}) }, {
          recordSearchRequest(request) { row.nativeSearchRequests.push(request); },
          recordSearchResponse(payload) {
            row.nativeSearchResponses.push({ model: payload.model, usage: payload.usage,
              blockTypes: payload.content?.map((block) => block.type),
              ...mapAnthropicResponse(payload) });
          },
        });
        const run = runner.runToolCall.bind(runner);
        runner.runToolCall = async (call) => {
          const start = Date.now();
          const result = await run(call);
          const rendered = runner.formatToolResult(call, result);
          row.tools.push({ name: call.function.name, arguments: JSON.parse(call.function.arguments),
            elapsedMs: Date.now() - start, code: result.code, error: result.error,
            sources: result.sources, url: result.url, statusCode: result.statusCode,
            rawBodyChars: result.body?.content.length, renderedChars: rendered.length,
            renderedHash: createHash("sha256").update(rendered).digest("hex"),
            renderedExcerpt: rendered.slice(0, 1000), usableEvidence: runner.hasUsableEvidence(call, result) });
          return result;
        };
        return runner;
      },
      async fetch(url, options) {
        const body = JSON.parse(options.body);
        const start = Date.now();
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        row.chatRequests.push({ model: body.model, thinking: body.thinking,
          status: response.status, elapsedMs: Date.now() - start, maxTokens: body.max_tokens,
          messageCount: body.messages.length, toolChoice: body.tool_choice,
          finishReason: payload.choices?.[0]?.finish_reason, usage: payload.usage });
        return response;
      },
    });
    const ai = new AiChatService(testConfig, { deepseekService: provider });
    const context = [{ role: "user", senderName: "测试成员", userId: "synthetic-member",
      text: scenario.text, timestamp: Date.now(), messageId: `harness-${scenario.id}` }];
    const start = Date.now();
    try {
      row.reply = await ai.chat(`harness-test:${scenario.id}`, scenario.text,
        { groupContextMessages: context, webSearch: "auto" });
    } catch (error) {
      row.error = String(error.message || error).split(config.deepseekApiKey).join("[REDACTED]");
    }
    row.elapsedMs = Date.now() - start;
    row.allChatThinkingDisabled = row.chatRequests.every((request) => request.thinking?.type === "disabled");
    row.passed = !row.error && row.allChatThinkingDisabled && (scenario.expected === "no-tools"
      ? row.tools.length === 0
      : scenario.expected === "search-error"
        ? row.tools.some((item) => item.code === "WEB_PROVIDER_CREDENTIAL_MISSING") && row.nativeSearchRequests.length === 0
        : row.tools.some((item) => item.name === `web_${scenario.expected}` && !item.error)
          && row.tools.some((item) => item.usableEvidence)
          && /https?:\/\//.test(row.reply || ""));
    report.results.push(row);
    save();
    console.log(JSON.stringify({ id: row.id, passed: row.passed, elapsedMs: row.elapsedMs,
      chatRequests: row.chatRequests.length, nativeSearchRequests: row.nativeSearchRequests.length,
      tools: row.tools.map((item) => item.name), error: row.error }));
  }
  const chats = report.results.flatMap((row) => row.chatRequests);
  const searches = report.results.flatMap((row) => row.nativeSearchResponses);
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.results.filter((row) => row.passed).length, cases: report.results.length,
    chatRequests: chats.length, nativeSearchRequests: searches.length,
    chatInputTokens: chats.reduce((sum, row) => sum + (row.usage?.prompt_tokens || 0), 0),
    chatOutputTokens: chats.reduce((sum, row) => sum + (row.usage?.completion_tokens || 0), 0),
    searchInputTokens: searches.reduce((sum, row) => sum + (row.usage?.input_tokens || 0)
      + (row.usage?.cache_read_input_tokens || 0) + (row.usage?.cache_creation_input_tokens || 0), 0),
    searchOutputTokens: searches.reduce((sum, row) => sum + (row.usage?.output_tokens || 0), 0),
  };
  save();
  console.log(JSON.stringify({ output, summary: report.summary }));
  if (report.results.some((row) => !row.passed)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
