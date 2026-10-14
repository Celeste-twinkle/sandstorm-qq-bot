// Real-model replay of narrow self-repeat cases. No QQ, tools or learning writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DEFAULT_OWN_REPLY_REVIEW_PROMPT } = require("../src/persona");
const output = path.resolve(process.argv[2]);
const run = JSON.parse(fs.readFileSync("reports/whale-group-learning-20261014/npc/round-05-self-repeat/run.json", "utf8"));
const operation = run.operations.find(row => row.kind === "self-repeat" && row.anchor === "h28");
const original = run.requests.find(row => row.operation === operation.id);
const replay = JSON.parse(original.messages[1].content);
const cases = [
  { id: "actual-followup", expected: false, history: replay.history, draft: replay.draft },
  { id: "own-paraphrase", expected: true, history: [
    { role: "user", text: "明天靠三个闹钟起床" },
    { role: "assistant", text: "三个闹钟都吵不过你，最后你赢" },
    { role: "user", text: "笑死，闹钟组队" }], draft: "组队吵架，最后全输给你" },
  { id: "human-echo", expected: false, history: [
    { role: "assistant", text: "我喜欢蓝白" },
    { role: "user", text: "今晚这风好舒服" }], draft: "今晚这风好舒服" },
  { id: "playful-invention", expected: false, history: [
    { role: "assistant", text: "我喜欢蓝白" },
    { role: "user", text: "来打游戏吗" }], draft: "本鱼刚吃完三大碗饭，这就上号，你们等我两分钟" },
  { id: "long-human-echo", expected: false, history: [
    { role: "assistant", text: "我喜欢蓝白" },
    { role: "user", text: "这个故事是真的离谱，听完我都不敢睡了。".repeat(20) }], draft: "这个故事是真的离谱，听完我都不敢睡了。".repeat(20) },
];

async function main() {
  assert.ok(!fs.existsSync(path.join(output, "run.json")));
  fs.mkdirSync(output, { recursive: true });
  const report = { method: "Actual frozen follow-up from round-05 plus independent paraphrase, human echo, imaginative participation and long-echo controls. Real DeepSeek, non-thinking. Single samples; no human naturalness rating or QQ delivery.", prompt: DEFAULT_OWN_REPLY_REVIEW_PROMPT, results: [] };
  const ai = new AiChatService({ ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false, groupChatSelfRepeatCheckEnabled: true });
  for (const item of cases) {
    const context = item.history.map((row, i) => ({ role: row.role, senderName: row.speaker || "", text: row.text, timestamp: i }));
    const actual = await ai.checkOwnReplyRepeat(context, item.draft);
    report.results.push({ ...item, actual, passed: actual === item.expected });
    fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ case: item.id, expected: item.expected, actual }));
  }
  ai.stop(); report.passed = report.results.every(row=>row.passed);
  fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
  assert.ok(report.passed, "Some self-repeat cases failed; inspect the captured replies");
}
main().catch(error=> { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode=1; });
