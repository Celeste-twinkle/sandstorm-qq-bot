// Opt-in live interest A/B and serial runtime checks. Synthetic chats, fake QQ.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { config } = require("../src/config");
const aiModule = require("../src/ai");
const ambient = require("../src/ambient-chat");
const { DeepSeekChatService } = require("../src/deepseek");

const output = path.resolve(process.argv[2]);
const oldRun = JSON.parse(fs.readFileSync("reports/whale-group-learning-20261014/npc/round-06-accepted/run.json", "utf8"));
const oldRequest = oldRun.requests.find(row => row.decision && row.messages[0].content.includes("should_reply"));
const oldLines = oldRequest.messages[1].content.split("\n");
const report = { method: "Real DeepSeek, frozen human-only interest A/B, then actual index.js with synthetic messages accumulated during controlled API waits. Fake QQ delivery and virtual time; no real group connection, learning writes or web tools. Serial API calls; no reply quota.",
  startedAt: new Date().toISOString(), model: config.deepseekModel, requests: [], decisions: [], runtime: [], checks: [] };
const hash = text => createHash("sha256").update(text).digest("hex");
const save = () => fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
let stage = "", hook, active = 0;
const logger = { log() {}, info() {}, warn(...args) { report.warnings ||= []; report.warnings.push(args.map(String).join(" ")); }, error(...args) { report.errors ||= []; report.errors.push(args.map(String).join(" ")); } };
const testConfig = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false,
  groupChatLearningEnabled: false, webSearchAutoEnabled: false,
  ambientChatDraftReviewEnabled: false, groupChatSelfRepeatCheckEnabled: false };
function makeAi() {
  return new aiModule.AiChatService(testConfig, { logger, deepseekService: new DeepSeekChatService(testConfig, { logger, fetch: async (url, options) => {
    assert.equal(++active, 1, "Do not run concurrent model requests in this test");
    const row = { stage, body: JSON.parse(options.body), startedAt: Date.now() };
    report.requests.push(row);
    try {
      await hook?.(row);
      const response = await fetch(url, options);
      const payload = await response.clone().json();
      row.status = response.status; row.answer = payload.choices?.[0]?.message?.content;
      row.usage = payload.usage; row.finishReason = payload.choices?.[0]?.finish_reason;
      return response;
    } catch (error) { row.error = String(error.message).split(config.deepseekApiKey).join("[REDACTED]"); throw error; }
    finally { row.elapsedMs = Date.now() - row.startedAt; active--; save(); }
  } }) });
}

const cases = [
  ["food", "public", ["下班我点蛋炒饭", "阿青，你昨天不也吃这个", "炒饭才是主食之王", "加两个蛋，再来根火腿", "你这是蛋里加饭", "白饭其实也行，有点菜就能炫"]],
  ["game", "public", ["昨晚那局开门就倒", "灰灰你那个闪把自己闪了", "我知道门后有人，就是手滑", "我们在后面看你表演", "门开得挺好，下次别开了", "今晚接着打，争取参与两秒以上"]],
  ["work", "public", ["主管还没走，我先假装看表", "阿青你表都看反了", "已经开始灵魂下班", "工资没加，班倒是天天加", "我去茶水间站五分钟", "今天也是假装很忙的一天"]],
  ["cat", "public", ["灰灰你那只猫又坐打印机了", "它可能想当主管", "你们给它发工资啊", "猫粮从管理费里扣", "它负责卡纸，我负责清理", "现在整个部门给它打工"]],
  ["keyboard", "public", ["蓝色外壳白色键帽到货了", "阿青你终于买了", "摆桌上挺好看", "灰灰那把空格还是锅盖声", "刚敲两下邻居就以为我炒菜", "以后键盘直接放灶台"]],
  ["mention-other", "public", ["[CQ:at,qq=810002] 灰灰今天外卖又点错了", "我点黄焖鸡，送来白米饭", "老板让你先吃主食", "吃饱了才有力气投诉", "阿青你别笑，你昨天还没筷子", "今天全员白饭冠军"]],
  ["private", "private", ["阿青，房间密码我私聊发你", "收到，我自己去看", "其他人不用接，我们两个人处理", "灰灰你别把密码发群里"]],
  ["stop", "quiet", ["刚才炒饭那事到这", "机器人这条不用回", "我们先停一下，别再接"]],
  ["finished", "quiet", ["都散了吧，今晚不玩了", "晚安", "今天聊完了，不用再开话题"]],
  ["followup", "direct-control", ["大肥鱼你喜欢蓝白还是黑灰", "还是问你，哪个更耐看"]],
];
function context(rows, prefix) {
  return rows.map((text, i) => ({ role: "user", messageId: `${prefix}-${i}`, timestamp: i + 1,
    userId: String(810001 + i % 3), senderName: ["阿青", "灰灰", "丸子"][i % 3], text,
    ...(text.includes("[CQ:at") ? { recipientHint: "艾特其他群成员" } : {}) }));
}

async function runtimeScenario(id, rows, lateText) {
  stage = `runtime:${id}`;
  const timers = new Map(); let now = Date.parse("2026-10-14T12:00:00Z"), timerId = 0;
  const clock = { now: () => now, setTimer(fn, delay) { const n = ++timerId; timers.set(n, { fn, at: now + delay }); return n; }, clearTimer(n) { timers.delete(n); } };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Scheduler extends ambient.AmbientReplyScheduler { constructor() { super({ ...clock, onError: error => logger.error(error.message) }); } }
  const ai = makeAi(); const groupId = "99007701", botId = "99007702";
  let handler, sentHandler, incoming = 0;
  const run = { id, events: [], queuedAfterFirstReply: false, sourceHashes: {} };
  report.runtime.push(run);
  const root = path.resolve(__dirname, ".."); const indexPath = path.join(root, "src/index.js");
  const source = fs.readFileSync(indexPath, "utf8"); const actualRequire = createRequire(indexPath);
  for (const file of ["src/index.js", "src/ai.js", "src/persona.js", "src/ambient-chat.js"]) run.sourceHashes[file] = hash(fs.readFileSync(path.join(root, file)));
  const runtimeConfig = { ...testConfig, allowedGroupIds: new Set([groupId]) };
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(indexPath), __filename: indexPath,
    console: logger, Date: ClockDate, setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    process: { on() {}, exit() { throw new Error("No shutdown allowed"); } }, require(name) {
      if (name === "./config") return { config: runtimeConfig };
      if (name === "./ai") return { ...aiModule, AiChatService: class { constructor() { return ai; } } };
      if (name === "./ambient-chat") return { ...ambient, AmbientReplyScheduler: Scheduler,
        getAmbientReplyDelay: (mode, last, cfg) => ambient.getAmbientReplyDelay(mode, last, cfg, now) };
      if (name === "./onebot") return { createOneBotServer(_cfg, onMessage, onSent) { handler = onMessage; sentHandler = onSent; return { listen() {}, close() {} }; } };
      return actualRequire(name);
    } };
  vm.runInNewContext(`${source}\nmodule.exports={groupConversationContext,ambientReplyScheduler,chatService,groupChatLearning};`, sandbox, { filename: indexPath });
  const runtime = sandbox.module.exports;
  const client = { async sendGroupMessage(group, message) {
    const response = { status: "ok", retcode: 0, data: { message_id: `b-${id}-${run.events.filter(e=>e.role==='assistant').length + 1}` } };
    run.events.push({ role: "assistant", text: message, atHuman: incoming });
    const pending = runtime.ambientReplyScheduler.groups.get(group)?.operation;
    run.queuedAfterFirstReply ||= Boolean(pending);
    sentHandler(group, message, response); return response;
  } };
  const deliver = async text => {
    now += 400; incoming++;
    run.events.push({ role: "user", text, number: incoming });
    await handler({ post_type: "message", message_type: "group", group_id: groupId, self_id: botId,
      user_id: String(810001 + incoming % 3), message_id: `h-${id}-${incoming}`, time: now / 1000,
      message: [{ type: "text", data: { text } }], sender: { nickname: ["阿青", "灰灰", "丸子"][incoming % 3] } }, client);
  };
  let initialInjected = false, draftInjected = false, checkInjected = false;
  hook = async request => {
    const structured = request.body.response_format?.type === "json_object";
    if (!initialInjected) {
      initialInjected = true;
      for (const text of rows.slice(2, 8)) await deliver(text);
    } else if (!structured && !draftInjected) {
      draftInjected = true;
      for (const text of rows.slice(8)) await deliver(text);
    } else if (structured && draftInjected && !checkInjected && lateText) {
      checkInjected = true; await deliver(lateText);
    }
  };
  await deliver(rows[0]); await deliver(rows[1]);
  const runDue = async () => {
    const due = [...timers.entries()].filter(([,t])=>t.at <= now).sort((a,b)=>a[1].at-b[1].at)[0];
    if (!due) return false; timers.delete(due[0]); due[1].fn(); return true;
  };
  now += 600; await runDue();
  const deadline = Date.now() + 120000;
  while (runtime.ambientReplyScheduler.groups.get(groupId)?.running || active) {
    assert.ok(Date.now() < deadline, "Runtime scenario timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const firstReplies = run.events.filter(e=>e.role==='assistant').length;
  if (lateText) {
    now += (config.ambientChatCooldownSeconds + 1) * 1000;
    while (await runDue()) {
      while (runtime.ambientReplyScheduler.groups.get(groupId)?.running || active) {
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  hook = undefined;
  run.firstCycleReplies = firstReplies; run.context = runtime.groupConversationContext.get(groupId);
  report.checks.push({ name: `${id}:no-at`, pass: run.events.filter(e=>e.role==='user').every(e=>!e.text.includes(botId) && !/大肥鱼|机器人|bot/i.test(e.text)) });
  report.checks.push({ name: `${id}:proactive-send`, pass: firstReplies > 0 });
  if (lateText) report.checks.push({ name: `${id}:later-messages-stay-queued`, pass: run.queuedAfterFirstReply });
  runtime.ambientReplyScheduler.clear(); runtime.groupChatLearning.stop(); ai.stop();
  for (const n of timers.keys()) clock.clearTimer(n);
  save(); console.log(JSON.stringify({ runtime: id, replies: run.events.filter(e=>e.role==='assistant').length, queuedAfterFirstReply: run.queuedAfterFirstReply }));
}

async function main() {
  assert.ok(config.deepseekApiKey && !config.deepseekThinkingEnabled);
  assert.ok(!fs.existsSync(path.join(output, "run.json")), "Preserve earlier reports"); fs.mkdirSync(output, { recursive: true });
  const baseline = makeAi(), candidate = makeAi();
  const buildCurrent = baseline.buildAmbientDecisionMessages.bind(baseline);
  baseline.buildAmbientDecisionMessages = (...args) => {
    const current = buildCurrent(...args); const data = JSON.parse(current[1].content.split("\n")[1]);
    return [{ role: "system", content: oldRequest.messages[0].content }, { role: "user", content: [oldLines[0], JSON.stringify(data), ...oldLines.slice(2)].join("\n") }];
  };
  report.baselineSystemPrompt = oldRequest.messages[0].content;
  report.candidateSystemPrompt = candidate.buildAmbientDecisionMessages(context(cases[0][2], "probe"))[0].content;
  for (let round = 1; round <= 2; round++) for (const [id, kind, rows] of cases) {
    const history = context(rows, id);
    for (const variant of round % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
      stage = `ab:${id}:${round}:${variant}`;
      const decision = await (variant === "baseline" ? baseline : candidate).shouldAmbientReply(history, { ambientMode: "instant" });
      report.decisions.push({ id, kind, round, variant, decision, context: history }); save();
      console.log(JSON.stringify({ done: report.decisions.length, planned: 40, id, variant, decision }));
    }
  }
  baseline.stop(); candidate.stop();
  await runtimeScenario("food-busy", ["下班点蛋炒饭", "阿青昨天也吃这个", "炒饭多加两个蛋", "火腿也加一根", "这不就是蛋里拌饭", "白饭其实也能炫", "灰灰你那份有没有锅气", "没有，锅都没上班", "老板今天也摸鱼", "我们饭要比老板先下班", "辣椒别加，刚才那家微辣都岩浆了", "丸子已经准备五瓶水"], "我刚拿到饭，老板居然忘了放蛋");
  await runtimeScenario("game-busy", ["昨天那局我开门就倒", "阿青你那个闪闪到自己了", "手滑，真手滑", "我们在后面看你表演", "门开得挺好", "下次门都别开", "灰灰你倒得也没慢到哪去", "我至少有走路动画", "开场动画组集合了", "今天争取玩过两秒", "哈哈哈哈还得先把门学会", "丸子负责截图"], "刚才录像找到了，灰灰其实比我先倒");
  report.summary = Object.fromEntries(["baseline", "candidate"].map(variant => [variant, Object.fromEntries(["public", "private", "quiet", "direct-control"].map(kind => {
    const rows = report.decisions.filter(r=>r.variant===variant && r.kind===kind);
    return [kind, { samples: rows.length, interested: rows.filter(r=>r.decision).length }];
  }))]));
  report.checks.push({ name: "all-api-success", pass: report.requests.every(r=>r.status===200 && !r.error && r.finishReason!=="length") });
  report.checks.push({ name: "no-runtime-errors", pass: !report.errors?.length });
  report.passed = report.checks.every(c=>c.pass); report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: report.passed, summary: report.summary, checks: report.checks }));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { report.error = String(error.stack || error).split(config.deepseekApiKey).join("[REDACTED]"); if (fs.existsSync(output)) save(); console.error(report.error); process.exitCode=1; });
