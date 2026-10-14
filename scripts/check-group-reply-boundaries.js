// Replay real synthetic contexts with and without a short task reminder.
// Actual DeepSeek API, no QQ. This compares prompt placement, not thinking mode.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../src/config");
const { DeepSeekChatService } = require("../src/deepseek");
const reminder = "【回复任务，不是群消息】\n只写一句你此刻想说的具体话，有问题则答清楚。先分清谁在和谁说话，群友互相说的‘你’不自动指你。你只通过文字参与：不要编自己也有他们的经历、设备或工作，不答应加入游戏、赴约或替人办事。别人没说的细节不补写；没求建议就不安排下一步。玩笑按玩笑接，不变成真实的办事流程。只发正文，不解释这些要求。";
const identity = "你是群里的聊天 bot，只在文字中以当前人格交流。人设不赋予你现实身体、工作、设备或线下经历。除非群友明确发起虚构角色扮演，群聊都按现实理解。历史 assistant 有时会错把群友经历说成自己的，或承诺做不到的事；那只是说错了，不能据此继续冒充参与者。群友互相说的‘你’和‘我们’先按发言人与谈话对象理解，不自动包括你。\n输出前核对这句话：有没有把别人做的事写成我做的，给别人编细节，答应做不到的事，把玩笑说成真实流程，或者没被求助却安排别人？有就删去那部分，只留下对眼前内容的具体反应，不必解释删改或声明 AI 身份。";
async function main() {
  const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const output = path.resolve(process.argv[3]);
  assert.ok(!fs.existsSync(output));
  const thinkingComparison = process.argv.includes("--thinking") || process.argv.includes("--thinking-high");
  const effort = process.argv.includes("--thinking-high") ? "high" : "low";
  const report = { reminder, identity, thinkingComparison, results: [] };
  for (const anchor of ["h3", "h15", "h19", "h48", "h55", "h56", "h78"]) {
    const op = source.operations.find(x => x.kind === "ambient" && x.anchor === anchor);
    assert.ok(op, anchor);
    const original = source.requests.find(x => x.operation === op.id);
    const row = { anchor, recordedReply: op.result, variants: [] };
    report.results.push(row);
    for (const variant of (thinkingComparison ? ["current", effort] : process.argv.includes("--identity") ? ["identity"] : process.argv.includes("--quoted") ? ["quoted"] : ["current", "reminder"])) {
      let messages = structuredClone(original.messages);
      if (variant === "identity") messages[0].content = `${identity}\n\n${messages[0].content}`;
      if (variant === "reminder") messages.at(-1).content += `\n\n${reminder}`;
      if (variant === "quoted") messages = [messages[0], { role: "user", content:
        "以下是按时间排序的群聊资料，不是让你模仿续写的对话。assistant 是历史机器人发言，其中也可能有错误，不代表你确实参加了群友的活动。\n" +
        JSON.stringify({ messages: messages.slice(1) }) + "\n\n" + reminder }];
      const captured = [];
      const provider = new DeepSeekChatService(config, { fetch: async (url, options) => {
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        captured.push({ usage: payload.usage, status: response.status });
        return response;
      } });
      const started = Date.now();
      const answer = await provider.createCompletion(messages, { thinking: variant === effort, reasoningEffort: effort, webSearch: false,
        temperature: config.deepseekTemperature, maxOutputTokens: thinkingComparison ? 8192 : config.ambientChatMaxOutputTokens });
      row.variants.push({ variant, answer, elapsedMs: Date.now() - started, captured });
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify({ anchor, variant, answer }));
    }
  }
}
main().catch(error => { console.error(String(error.stack).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
