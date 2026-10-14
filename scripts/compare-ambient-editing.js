// Live, opt-in comparison on identical draft/history pairs. Never connects to QQ.
// node scripts/compare-ambient-editing.js <source-run.json> <new-output-dir> [case-pairs.json]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { DeepSeekChatService } = require("../src/deepseek");
const { DEFAULT_AMBIENT_DRAFT_REVIEW_PROMPT: editingPrompt } = require("../src/persona");

async function main() {
  const [input, destination, casesFile] = process.argv.slice(2);
  assert.ok(input && destination);
  assert.equal(config.deepseekThinkingEnabled, false);
  const output = path.resolve(destination);
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, "results.json");
  assert.ok(!fs.existsSync(file));
  const source = JSON.parse(fs.readFileSync(input, "utf8"));
  const cases = source.operations.filter(op => op.kind === "review").map(op => {
    const request = source.requests.find(r => r.operation === op.id);
    return { id: op.anchor, input: JSON.parse(request.messages[1].content), baselinePrompt: request.messages[0].content };
  });
  assert.ok(cases.length && cases.every(item => item.baselinePrompt.includes('"should_reply"')),
    "Choose a recorded boolean-review run as the baseline");
  const baselinePrompt = cases[0].baselinePrompt;
  if (casesFile) cases.length = 0;
  for (const [id, context, draft, expectation] of (casesFile ? JSON.parse(fs.readFileSync(casesFile, "utf8")) : [
    ["real-help", [["user", "空格键太响，怎么处理能安静点？"]], "先把键帽拔下来看看卫星轴有没有松动，没拆过的话别硬掰。", "retain requested help and caution"],
    ["repeated-preference", [["assistant", "我选浅色，好搭。"], ["user", "那耐看程度呢？我还是在问你。"]], "还是浅色，看久了比较舒服。", "answer followup even with same preference"],
    ["requested-recap", [["assistant", "周五南门六点。"], ["user", "刚才没看清，你再说一下集合的时间地点。"]], "周五，南门，六点。", "retain requested repetition"],
    ["genuine-loss", [["user", "做了一个月的作品被否掉了，挺难受的。"]], "一个月的心血就这样被否了，确实憋屈。", "retain specific empathy"],
    ["thanks", [["user", "谢谢，照你说的弄好了。"]], "弄好了就行。", "retain normal acknowledgement"],
    ["invented-gear", [["user", "新显示器颜色看着挺舒服。"]], "我这台也是，比旧的好多了。", "skip fabricated ownership"],
    ["mixed-advice", [["user", "排了半小时队，店员说卖完了。"]], "白排半小时。下次先打电话问问，别又白跑。", "remove unsolicited advice"],
    ["numbers", [["user", "就耽误十分钟，笑死。"]], "这一下午全浪费了。", "skip altered duration"],
    ["uncertain", [["user", "你能确定文件能救回来吗？"]], "不能确定，得看有没有备份。", "preserve uncertainty"],
    ["citation", [["user", "文档的入口在哪？"]], "官方入口：https://example.com/docs ，以页面说明为准。", "preserve source link"],
    ["old-false-self", [["assistant", "我家狗也总拆家。"], ["user", "我家狗又咬拖鞋了。"]], "我家那只也咬，已经换三双了。", "skip inherited fabricated life"],
    ["explicit-silence", [["user", "我去睡了，这条不用回。"]], "好，早点休息。", "skip explicit no reply"],
  ])) cases.push({ id, input: { history: context.map(([role, content]) => ({ role, content })), draft },
    baselinePrompt, expectation });
  const report = { startedAt: new Date().toISOString(), model: config.deepseekModel, thinking: false,
    editingPrompt, cases, results: [], method: "Identical frozen history and draft; randomized variant order. One request per variant, same temperature and output cap, no tools. Manual review required." };
  for (const item of cases) {
    for (const variant of (randomInt(2) ? ["boolean", "editing"] : ["editing", "boolean"])) {
      const row = { id: item.id, variant };
      report.results.push(row);
      const provider = new DeepSeekChatService(config, { logger: { log() {}, warn() {}, error() {} }, fetch: async (url, options) => {
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        row.usage = payload.usage; row.status = response.status; row.finishReason = payload.choices?.[0]?.finish_reason;
        return response;
      } });
      const started = Date.now();
      try {
        row.answer = await provider.createCompletion([{ role: "system", content: variant === "editing" ? editingPrompt : item.baselinePrompt },
          { role: "user", content: JSON.stringify(item.input) }], { thinking: false, decisionOnly: true, webSearch: false,
          responseFormat: { type: "json_object" }, maxOutputTokens: 180, temperature: 0 });
        const parsed = JSON.parse(row.answer);
        if (variant === "boolean") {
          assert.equal(typeof parsed.should_reply, "boolean");
          row.finalReply = parsed.should_reply ? item.input.draft : null;
        } else {
          assert.ok(["send", "edit", "skip"].includes(parsed.action));
          if (parsed.action === "edit") assert.ok(typeof parsed.text === "string" && parsed.text.trim());
          row.finalReply = parsed.action === "send" ? item.input.draft : parsed.action === "edit" ? parsed.text.trim() : null;
          row.action = parsed.action;
        }
      } catch (error) { row.error = String(error.message).split(config.deepseekApiKey).join("[REDACTED]"); }
      row.elapsedMs = Date.now() - started;
      fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify({ id: item.id, variant, action: row.action, reply: row.finalReply, error: row.error }));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(["boolean", "editing"].map(variant => {
    const rows = report.results.filter(r => r.variant === variant);
    return [variant, { requests: rows.length, errors: rows.filter(r => r.error).length,
      input: rows.reduce((n, r) => n + (r.usage?.prompt_tokens || 0), 0), output: rows.reduce((n, r) => n + (r.usage?.completion_tokens || 0), 0),
      elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0) }];
  }));
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary));
  if (report.results.some(r => r.error)) process.exitCode = 1;
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
