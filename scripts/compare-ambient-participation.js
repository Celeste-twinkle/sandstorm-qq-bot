// Live, decision-only A/B. No generated group replies, web tools or QQ connection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DEFAULT_AMBIENT_CHAT_JUDGE_PROMPT } = require("../src/persona");

const scenarios = [
  ["open-opinion", "open", [["user", "A", "你们觉得下雨天窝家里打游戏是不是最舒服的"]]],
  ["work-complaint", "open", [["user", "A", "今天开了三个小时会，结论是下周接着开"]]],
  ["game-achievement", "open", [["user", "A", "卡了三天的关终于过了，最后一丝血险胜，手还在抖"]]],
  ["game-banter", "open", [["user", "A", "队友扔雷前喊了声小心，然后精准扔到我脚下"]]],
  ["food-opinion", "open", [["user", "A", "我宣布今天这杯奶茶就是一杯糖水，甜得我头疼"]]],
  ["public-discussion", "open", [["user", "A", "这软件把设置藏得也太深了"], ["user", "B", "每次找设置都像在玩密室逃脱"]]],
  ["weather-chat", "open", [["user", "A", "早上穿外套出门，中午热到怀疑人生，这天气没有过渡的"]]],
  ["hobby-sharing", "open", [["user", "A", "新键盘到了，打字声音好听是好听，就是像在炒豆子"]]],
  ["bot-followup", "direct", [["assistant", "Bot", "可以先看看两边版本号。"], ["user", "A", "好的，那版本号在哪看？"]]],
  ["bot-nickname", "direct", [["user", "A", "太太，你觉得这个笑话冷不冷？"]]],
  ["private-logistics", "quiet", [["user", "A", "阿泽，明天来我家取包裹吗"], ["user", "B", "我八点到，你下楼给我就行"]]],
  ["other-member-question", "quiet", [["user", "A", "小林，你刚说的那件事具体是什么情况？"], ["user", "B", "等我整理一下，马上跟你说"]]],
  ["explicit-silence", "quiet", [["user", "A", "我只想自己吐槽一下，bot不用接话，也别给建议"]]],
  ["acknowledgement", "quiet", [["assistant", "Bot", "等服务端更新就行。"], ["user", "A", "好的"]]],
  ["already-answered", "quiet", [["user", "A", "那等更新就行吧"], ["assistant", "Bot", "对，等更新后再试。"]], "idle"],
  ["goodnight", "quiet", [["user", "A", "今天先到这里，大家晚安，不聊了"]], "idle"],
  ["confirmed-plan", "quiet", [["user", "A", "那就这样定，明天九点见"], ["user", "B", "收到，到时候见"]]],
  ["private-exchange", "quiet", [["user", "A", "老王，车票你买了吗？这件事我们俩自己商量就行"]]],
];

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false);
  const dir = path.resolve(process.argv[2] || "reports/ambient-participation-20261014");
  const output = path.join(dir, "ab.json");
  assert.ok(!fs.existsSync(output), "Do not overwrite prior A/B data");
  const prompts = { baseline: DEFAULT_AMBIENT_CHAT_JUDGE_PROMPT,
    candidate: fs.readFileSync(path.join(dir, "candidate-prompt.txt"), "utf8").trim() };
  const temperatures = { baseline: 0, candidate: Number(process.env.PARTICIPATION_CANDIDATE_TEMPERATURE || 0) };
  const report = { startedAt: new Date().toISOString(), model: config.deepseekModel,
    method: "18 synthetic conversations: 8 open-group opportunities, 2 direct continuations, 8 cases to leave quiet. Thinking disabled and only a JSON participation decision. Open opportunities do not require a reply; this is not a production reply-rate estimate.",
    prompts, temperatures, results: [] };
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  for (const [id, category, messages, mode = "instant"] of scenarios) {
    const context = messages.map(([role, senderName, text], index) => ({ role, senderName, text,
      userId: senderName, messageId: `${id}-${index}`, timestamp: Date.now() - (messages.length - index) * 3000 }));
    const paired = await Promise.all(Object.entries(prompts).map(async ([variant, prompt]) => {
      const captures = [];
      const service = new AiChatService({ ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false,
        ambientChatJudgePrompt: prompt, ambientChatJudgeTemperature: temperatures[variant] }, {
        fetch: async (url, options) => {
          const body = JSON.parse(options.body);
          assert.equal(body.thinking.type, "disabled");
          assert.equal(body.tools, undefined);
          const response = await fetch(url, options);
          const data = await response.clone().json();
          captures.push({ status: response.status, usage: data.usage,
            answer: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason });
          return response;
        },
      });
      const decision = await service.shouldAmbientReply(context, { ambientMode: mode });
      return { variant, decision, captures };
    }));
    report.results.push({ id, category, mode, messages, paired });
    save();
    console.log(JSON.stringify({ id, category, ...Object.fromEntries(paired.map(row => [row.variant, row.decision])) }));
  }
  report.summary = Object.fromEntries(Object.keys(prompts).map(variant => {
    const rows = report.results.map(row => ({ ...row, ...row.paired.find(value => value.variant === variant) }));
    return [variant, { openAccepted: rows.filter(row => row.category === "open" && row.decision).length,
      openCases: 8, directAccepted: rows.filter(row => row.category === "direct" && row.decision).length, directCases: 2,
      quietDeclined: rows.filter(row => row.category === "quiet" && !row.decision).length, quietCases: 8,
      requests: rows.reduce((sum, row) => sum + row.captures.length, 0),
      inputTokens: rows.flatMap(row => row.captures).reduce((sum, row) => sum + (row.usage?.prompt_tokens || 0), 0),
      outputTokens: rows.flatMap(row => row.captures).reduce((sum, row) => sum + (row.usage?.completion_tokens || 0), 0) }];
  }));
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ output, summary: report.summary }));
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
