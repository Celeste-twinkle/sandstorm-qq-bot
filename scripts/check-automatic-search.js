const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const { WebToolRunner } = require("../src/webtools");
const { usesDeepSeekHarness } = require("../src/deepseek-harness-web");

const scenarios = [
  { id: "casual-joke", expectedSearch: false, messages: [
    ["user", "阿泽", "排队二十分钟，进去一分钟就输了，主打一个参与"],
  ] },
  { id: "unclear-update", expectedSearch: false, messages: [
    ["user", "小陈", "太太，你觉得这次更新怎么样？"],
  ] },
  { id: "unclear-version", expectedSearch: false, messages: [
    ["assistant", "Bot", "先看看双方的版本号。"],
    ["user", "小陈", "版本号在哪看啊"],
  ] },
  { id: "known-context", expectedSearch: false, messages: [
    ["user", "管理员", "客户端已经更新，服务端十分钟后更"],
    ["user", "小陈", "所以现在等管理更完就行？"],
  ] },
  { id: "no-search-instruction", expectedSearch: false, messages: [
    ["user", "小陈", "不用联网搜索了，这次更新具体改了什么你不知道就说不知道"],
  ] },
  { id: "no-public-answer", expectedSearch: false, messages: [
    ["user", "小陈", "你知道栗子明天几点下班吗？没在群里说过"],
  ] },
  { id: "small-win", expectedSearch: false, messages: [
    ["user", "栗子", "第一次自己拼的模型终于站稳了，刚才还一直倒"],
  ] },
  { id: "serious-disappointment", expectedSearch: false, messages: [
    ["user", "小陈", "排练了好久的节目临时取消了，有点难受，先别给我建议"],
  ] },
  { id: "needs-public-evidence", expectedSearch: true, fixture: "release", messages: [
    ["user", "小陈", "纸鹤笔记 4.2 的新版到底加没加批量导出？帮忙查一下官方发布说明"],
  ] },
  { id: "fact-without-search-command", expectedSearch: "optional", fixture: "release", messages: [
    ["user", "小陈", "纸鹤笔记 4.2 现在支持批量导出了吗？"],
  ] },
  { id: "search-unavailable", expectedSearch: true, fixture: "unavailable", messages: [
    ["user", "小陈", "帮我查纸鹤笔记 4.2 的官方发布说明，没查到直接说不知道"],
  ] },
];

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false);
  assert.equal(config.webSearchAutoEnabled, true);
  const outputDir = path.resolve(process.argv[2] || "reports/automatic-search-chat");
  const live = process.argv.includes("--live");
  const outputPath = path.join(outputDir, "results.json");
  assert.ok(!fs.existsSync(outputPath), "Do not overwrite existing results");
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), model: config.deepseekModel, thinking: false,
    method: "Real model, two rounds of synthetic conversations and fixed simulated search evidence. No QQ connection. Live public-web case runs only with --live.",
    prompts: { naturalChat: config.naturalChatPrompt, persona: config.deepseekSystemPrompt }, results: [],
  };
  const save = () => fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  const caseFilter = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  const selected = caseFilter ? scenarios.filter((scenario) => scenario.id === caseFilter) : scenarios;
  assert.ok(selected.length, "Unknown case filter");
  const checks = [1, 2].flatMap((round) => selected.map((scenario) => ({ ...scenario, round })));
  if (live) checks.push({ id: "live-official-nodejs", round: 1, live: true, expectedSearch: true,
    messages: [["user", "小陈", "Node.js 官网目前推荐的 LTS 大版本是几？核实一下，给个官网链接"]] });
  for (const scenario of checks) {
    const captures = [];
    const calls = [];
    const testConfig = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false };
    const provider = new DeepSeekChatService(testConfig, {
      webToolRunnerFactory(runnerConfig) {
        const realRunner = new WebToolRunner(runnerConfig);
        return {
          setUserQuery: (query) => realRunner.setUserQuery(query),
          getToolDefinitions: () => realRunner.getToolDefinitions(),
          ...(realRunner.hasUsableEvidence ? {
            hasUsableEvidence: (call, result) => realRunner.hasUsableEvidence(call, result),
            formatToolResult: (call, result) => realRunner.formatToolResult(call, result),
          } : {}),
          async runToolCall(call) {
            const item = { name: call.function.name, arguments: JSON.parse(call.function.arguments) };
            calls.push(item);
            if (scenario.live) {
              const result = await realRunner.runToolCall(call);
              item.result = result;
              return result;
            }
            const source = { title: "Paper Crane Notes 4.2 release", url: "https://example.com/paper-crane/4.2" };
            const text = "Version 4.2 adds batch export of selected notes. Individual export remains available.";
            const nativeResult = call.function.name === "web_search"
              ? { sources: [{ ...source, snippet: text }], truncated: false }
              : { url: source.url, statusCode: 200, body: { kind: "text", content: text }, truncated: false };
            const result = scenario.fixture === "release" ? usesDeepSeekHarness(runnerConfig) ? nativeResult : {
              results: [{ title: "Paper Crane Notes 4.2 release", url: "https://example.com/paper-crane/4.2" }],
              auto_fetched_pages: [{ title: "Paper Crane Notes 4.2 release", url: "https://example.com/paper-crane/4.2",
                evidence_status: "fetched_page", text: "Version 4.2 adds batch export of selected notes. Individual export remains available." }],
            } : { error: "No reliable page available in this test fixture" };
            item.result = result;
            return result;
          },
        };
      },
      async fetch(url, options) {
        const body = JSON.parse(options.body);
        const started = Date.now();
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        captures.push({ thinking: body.thinking?.type, toolChoice: body.tool_choice,
          maxTokens: body.max_tokens, messageCount: body.messages.length,
          messagesHash: createHash("sha256").update(JSON.stringify(body.messages)).digest("hex"),
          latencyMs: Date.now() - started, status: response.status, usage: payload.usage || {},
          finishReason: payload.choices?.[0]?.finish_reason });
        return response;
      },
    });
    const service = new AiChatService(testConfig, { deepseekService: provider });
    const context = scenario.messages.map(([role, senderName, text], index) => ({
      role, senderName, text, userId: senderName, messageId: `${scenario.id}-${index}`, timestamp: index + 1,
    }));
    let reply;
    let error;
    try {
      reply = await service.chat(`evaluation:${scenario.id}`, context.at(-1).text, {
        groupContextMessages: context, webSearch: "auto",
      });
    } catch (failure) {
      error = String(failure.message || failure).replaceAll(config.deepseekApiKey, "[redacted]");
    }
    const searched = calls.some((call) => call.name === "web_search");
    const row = { ...scenario, reply, error, searched,
      matchedSearchExpectation: scenario.expectedSearch === "optional" ? null : searched === scenario.expectedSearch,
      captures, calls };
    report.results.push(row);
    report.summary = {
      cases: report.results.length,
      fixedSearchExpectations: report.results.filter((row) => row.expectedSearch !== "optional").length,
      matchedSearchExpectation: report.results.filter((row) => !row.error && row.matchedSearchExpectation).length,
      optionalChoicesForManualReview: report.results.filter((row) => row.expectedSearch === "optional").length,
      apiRequests: report.results.reduce((sum, row) => sum + row.captures.length, 0),
      promptTokens: report.results.flatMap((row) => row.captures).reduce((sum, row) => sum + (row.usage.prompt_tokens || 0), 0),
      completionTokens: report.results.flatMap((row) => row.captures).reduce((sum, row) => sum + (row.usage.completion_tokens || 0), 0),
    };
    save();
    console.log(JSON.stringify({ id: scenario.id, round: scenario.round, searched, matched: row.matchedSearchExpectation,
      requests: captures.length, error }));
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ summary: report.summary, outputPath }));
  if (report.results.some((row) => row.error || row.matchedSearchExpectation === false)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
