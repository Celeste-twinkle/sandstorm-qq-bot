const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");

const scenarios = [
  { id: "bot-nickname-question", expected: true, mode: "instant", messages: [
    ["user", "Alice", "太太，这更新一小时都没动静，先查哪里？别让我重装"],
  ] },
  { id: "followup-to-bot", expected: true, mode: "instant", messages: [
    ["user", "Alice", "进服报版本不一致"],
    ["assistant", "Bot", "先对一下客户端和服务端版本号。"],
    ["user", "Alice", "那版本号在哪看？"],
  ] },
  { id: "already-answered-idle", expected: false, mode: "idle", messages: [
    ["user", "Alice", "所以我等管理更完就能进了？"],
    ["assistant", "Bot", "对，等服务端更新到同一版本就行，不用重装。"],
  ] },
  { id: "ended-goodnight", expected: false, mode: "idle", messages: [
    ["user", "Alice", "今天先到这吧，大家晚安，不聊了"],
  ] },
  { id: "acknowledgement", expected: false, mode: "instant", messages: [
    ["user", "Alice", "我先等服务器更新吧"],
    ["assistant", "Bot", "嗯，更完再连就行。"],
    ["user", "Alice", "好的"],
  ] },
  { id: "ack-with-question", expected: true, mode: "instant", messages: [
    ["assistant", "Bot", "先对一下两边的版本。"],
    ["user", "Alice", "好的，那版本号在哪看？"],
  ] },
  { id: "mentions-another-member", expected: false, mode: "instant", recipientHint: "艾特其他群成员", messages: [
    ["user", "Alice", "老王，明天的车票你买了吗？这事我们俩商量就行"],
  ] },
  { id: "explicit-no-reply", expected: false, mode: "instant", messages: [
    ["user", "Alice", "我就是吐槽两句，不用接话，也别给建议"],
  ] },
  { id: "members-making-plan", expected: false, mode: "instant", messages: [
    ["user", "Alice", "阿泽，你今晚下班来我家取包裹吗"],
    ["user", "Bob", "来，我八点到，你到时候下楼拿给我就行"],
  ] },
  { id: "explicit-bot-invitation", expected: true, mode: "instant", messages: [
    ["user", "Alice", "太太，你也说两句，这次更新你怎么看？"],
  ] },
  { id: "natural-close-idle", expected: false, mode: "idle", messages: [
    ["user", "Alice", "那就这么定，明晚再约，今天散了"],
  ] },
  { id: "new-question-after-answer", expected: true, mode: "instant", messages: [
    ["user", "Alice", "等服务端更新就行？"],
    ["assistant", "Bot", "对，先等管理把服务端更新。"],
    ["user", "Alice", "那如果更完还不一致呢？"],
  ] },
  { id: "question-for-another-member", expected: false, mode: "instant", messages: [
    ["user", "Alice", "小林，你看过今天新出的那篇评测吗？里面的数据靠谱吗"],
    ["user", "Bob", "我还在看，看完跟你说"],
  ] },
  { id: "unnamed-bot-no-need-to-research", expected: false, mode: "instant", messages: [
    ["user", "Alice", "阿泽，这次补丁是不是把那把枪削了？你刚玩过吧"],
  ] },
];

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false);
  const outputDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "reports", "ambient-ai-decisions"));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "results.json");
  assert.ok(!fs.existsSync(outputPath), "Do not overwrite existing decision results");
  let captures = [];
  const service = new AiChatService({ ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false }, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const started = Date.now();
      const response = await fetch(url, options);
      const copy = await response.clone().json();
      captures.push({ decisionRequest: body.response_format?.type === "json_object",
        thinking: body.thinking?.type, maxTokens: body.max_tokens, messageCount: body.messages.length,
        latencyMs: Date.now() - started, status: response.status, usage: copy.usage || {},
        finishReason: copy.choices?.[0]?.finish_reason || null });
      return response;
    },
  });
  const report = { startedAt: new Date().toISOString(), model: config.deepseekModel,
    defaultThinking: false, method: `${scenarios.length} synthetic conversations; judge first, generate only if accepted. Reply may choose web tools. No QQ connection.`,
    results: [] };
  const save = () => fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  for (const scenario of scenarios) {
    const context = scenario.messages.map(([role, senderName, text], index) => ({
      role, senderName, text, userId: senderName, messageId: `${scenario.id}-${index}`, timestamp: index + 1,
      ...(index === scenario.messages.length - 1 && scenario.recipientHint ? { recipientHint: scenario.recipientHint } : {}),
    }));
    captures = [];
    let decision;
    const reply = await service.ambientReplyIfAppropriate(context, { ambientMode: scenario.mode }, {
      onDecision: (value) => { decision = value; }, isCurrent: () => true,
    });
    const result = { ...scenario, decision, reply, passed: decision === scenario.expected, captures };
    const replyCalls = captures.filter((call) => !call.decisionRequest).length;
    assert.ok(decision ? replyCalls >= 1 : replyCalls === 0);
    report.results.push(result);
    report.summary = { cases: report.results.length, matchedExpected: report.results.filter((row) => row.passed).length,
      accepted: report.results.filter((row) => row.decision).length,
      declined: report.results.filter((row) => !row.decision).length,
      apiRequests: report.results.reduce((sum, row) => sum + row.captures.length, 0),
      promptTokens: report.results.flatMap((row) => row.captures).reduce((sum, row) => sum + (row.usage.prompt_tokens || 0), 0),
      outputTokens: report.results.flatMap((row) => row.captures).reduce((sum, row) => sum + (row.usage.completion_tokens || 0), 0),
    };
    save();
    console.log(JSON.stringify({ id: scenario.id, decision, expected: scenario.expected, passed: result.passed, requests: captures.length }));
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ summary: report.summary, outputPath }));
}

main().catch((error) => { console.error(error.name); process.exitCode = 1; });
