// Opt-in live learning and generation comparison. Synthetic chat only, no QQ or tools.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { GroupChatLearning } = require("../src/group-chat-learning");

async function main() {
  const output = path.resolve(process.argv[2]);
  assert.ok(config.deepseekApiKey && !config.deepseekThinkingEnabled);
  assert.ok(!fs.existsSync(path.join(output, "run.json")), "Preserve earlier results");
  fs.mkdirSync(output, { recursive: true });
  const turns = [
    ["user", "等车等麻了"], ["user", "又晚点？"], ["user", "八分钟了"],
    ["assistant", "耐心等待，交通拥堵难免，建议你下次提前出门。"],
    ["user", "你这句像站务广播"], ["user", "真的"], ["user", "跟我们正常聊就行"],
    ["user", "啊？"], ["user", "车来了"], ["user", "终于"], ["user", "刚坐下又堵了"], ["user", "草"],
    ["assistant", "刚坐下就堵车，这令人无奈，建议放轻松。"], ["user", "别总结，我已经说了"],
    ["user", "哈哈哈"], ["user", "前面好像蹭了"], ["user", "能走吗"], ["user", "慢慢挪"],
    ["user", "服了"], ["user", "我赶早八呢"], ["assistant", "下次记得提前出发，调整好自己的心态。"],
    ["user", "别提醒我起早，我现在在车上"], ["user", "就是想吐槽"], ["user", "懂"], ["user", "啊这"],
    ["assistant", "面对这种无法改变的情况，先好好照顾自己，别着急。"],
    ["user", "你别安慰成主持人"], ["user", "不用替我们维持话题"], ["user", "行"], ["user", "反正还在堵"],
  ];
  const context = turns.map(([role, text], i) => ({ role, text, messageId: `d${i}`, timestamp: i + 1,
    userId: role === "user" ? `member${i % 4}` : "bot", senderName: role === "user" ? `成员${i % 4}` : "Bot" }));
  const report = { startedAt: new Date().toISOString(), method: "Synthetic fragmentary human chat and explicit feedback; same current prompts, frozen histories, random request order, two samples per case. Learning uses thinking; generation uses no thinking. No web or QQ.",
    context, requests: [], results: [] };
  const save = () => fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
  let task;
  const cfg = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false, webSearchAutoEnabled: false,
    groupChatLearningDir: path.join(output, "storage") };
  const ai = new AiChatService(cfg, { fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    const row = { task, model: body.model, thinking: body.thinking, messages: body.messages, maxTokens: body.max_tokens };
    report.requests.push(row);
    assert.equal(body.thinking.type, task === "learning" ? "enabled" : "disabled"); assert.ok(!body.tools);
    const response = await fetch(url, options); const payload = await response.clone().json();
    Object.assign(row, { status: response.status, usage: payload.usage, answer: payload.choices?.[0]?.message?.content }); save();
    return response;
  } });
  const learning = new GroupChatLearning(cfg, { learn: (messages, previous) => ai.learnGroupChatStyle(messages, previous) });
  task = "learning"; learning.observe("98000001", context); await learning.flush();
  report.profile = learning.getStatus("98000001");
  assert.ok(report.profile.rules.length, "Learning should yield evidence-backed expression hints");
  const cases = [
    ["after-delays", "我刚下车赶到教室，老师正好点完名"],
    ["brief-relief", "终于下车了"],
    ["preference", "柠檬水和冰美式你选哪个？就说偏好"],
    ["feedback", "你刚才那句又总结了，不用把我消息再说一遍"],
  ];
  for (const [id, text] of cases) for (let sample = 1; sample <= 2; sample++) {
    const history = [...context, { role: "user", text, messageId: id, timestamp: 31, userId: "member1", senderName: "成员1" }];
    for (const variant of randomInt(2) ? ["unlearned", "learned"] : ["learned", "unlearned"]) {
      task = `${id}:${sample}:${variant}`;
      const answer = await ai.ambientReply(history, { ambientMode: "instant", thinking: false,
        groupChatStyle: variant === "learned" ? learning.getRules("98000001") : [] });
      report.results.push({ id, sample, variant, answer }); save();
    }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = { requests: report.requests.length,
    promptTokens: report.requests.reduce((n, row) => n + (row.usage?.prompt_tokens || 0), 0),
    completionTokens: report.requests.reduce((n, row) => n + (row.usage?.completion_tokens || 0), 0) };
  save(); learning.stop(); ai.stop(); console.log(JSON.stringify(report.summary));
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
