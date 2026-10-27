// Exercise the real entrypoint, policy store, learning store, ambient pipeline,
// scheduler and OneBot send queue. Models and QQ transport stay entirely local.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const aiModule = require("../src/ai");
const ambient = require("../src/ambient-chat");
const { GroupBotLoopGuard } = require("../src/group-bot-loop-guard");
const { GroupBotPolicy } = require("../src/group-bot-policy");
const { createOneBotClient } = require("../src/onebot");

const ADMIN = "631978355", BOT = "90000001", MEMBER = "90000002", GROUP = "1001";
const at = qq => ({ type: "at", data: { qq } });
const flush = () => new Promise(setImmediate);
async function fixture(t, overrides = {}, hooks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-bot-integration-"));
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  let now = 1000000, timerId = 0, messageId = 0, outgoingId = 0, handler, sentHandler, runtime;
  const timers = new Map(), pending = new Map();
  const calls = { direct: [], judge: 0, generate: 0, learning: 0, prewarm: 0, actions: [] };
  const config = {
    botName: "大肥鱼", botAdminIds: new Set([ADMIN]), groupChatBotIds: new Set(), groupChatTrustedUserIds: new Set(),
    groupChatBotPolicyFile: path.join(directory, "policy.json"),
    groupChatLearningDir: path.join(directory, "learning"), groupChatLearningEnabled: true,
    memoryStateDir: path.join(directory, "memory"),
    groupChatLearningMinMessages: 20, groupChatLearningEveryMessages: 30, groupChatLearningMinIntervalMs: 600000,
    allowedGroupIds: new Set(), requireAt: true, triggerKeywords: ["ins"], cooldownSeconds: 0,
    chatEnabled: true, chatRequireAt: true, chatCooldownSeconds: 0, chatMaxHistoryMessages: 50,
    ambientChatEnabled: true, ambientChatDebounceMs: 600, ambientChatCooldownSeconds: 0, ambientChatIdleSeconds: 60,
    ambientChatContextSeconds: 7200, bilibiliEnabled: false, webSearchAutoEnabled: false, webSearchTriggerKeywords: [],
    ...overrides,
  };
  const clock = {
    now: () => now,
    setTimer(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + Math.max(0, delay) }); return id; },
    clearTimer(id) { timers.delete(id); },
  };
  class VirtualDate extends Date { static now() { return now; } }
  class FakeAi {
    async start() {}
    stop() {}
    isConfigured() { return true; }
    async prewarmImages() { calls.prewarm++; return 0; }
    async learnGroupChatStyle() { calls.learning++; return '{"rules":[]}'; }
    async analyzeSticker() { return hooks.analyze?.() || { transcription: "好耶", uncertain_text: [], description: "开心庆祝", emotions: ["开心"], usage: ["胜利"], avoid: ["悲伤"], confidence: 0.99 }; }
    async chooseSticker(candidates) { return hooks.choose?.(candidates) || { sticker_id: null, context_match: false, confidence: 1 }; }
    async chat(session, text, meta) {
      calls.direct.push({ session, text, meta });
      await hooks.direct?.();
      return `回复${calls.direct.length}`;
    }
    resetSession() {}
    async shouldAmbientReply() { calls.judge++; await hooks.judge?.(); return true; }
    async ambientReply() { return `插话${++calls.generate}`; }
    async reviewAmbientReply(_context, draft) { return draft; }
    async checkOwnReplyRepeat() { return false; }
    ambientReplyIfAppropriate(...args) { return aiModule.AiChatService.prototype.ambientReplyIfAppropriate.apply(this, args); }
  }
  const sourcePath = path.resolve(__dirname, "../src/index.js");
  const actualRequire = createRequire(sourcePath);
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(sourcePath), __filename: sourcePath,
    console: { log() {}, warn() {}, error() {} }, Date: VirtualDate,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer, process: { on() {} },
    require(name) {
      if (name === "./config") return { config };
      if (name === "./ai") return { ...aiModule, AiChatService: FakeAi };
      if (name === "./group-bot-loop-guard") return { GroupBotLoopGuard: class extends GroupBotLoopGuard {
        constructor(cfg, options) { super(cfg, { ...options, now: clock.now }); }
      } };
      if (name === "./ambient-chat") return { ...ambient,
        getAmbientReplyDelay: (mode, last, cfg) => ambient.getAmbientReplyDelay(mode, last, cfg, now),
        AmbientReplyScheduler: class extends ambient.AmbientReplyScheduler { constructor() { super(clock); } },
      };
      if (name === "./onebot") return { createOneBotServer(_cfg, onMessage, onSent) {
        handler = onMessage; sentHandler = onSent; return { listen() {}, close() {} };
      } };
      return actualRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8") + `\nmodule.exports = {
    tryAmbientReply, groupConversationContext, groupChatLearning, groupBotPolicy, groupBotLoopGuard,
    agentMemory, stickerLibrary,
    ambientReplyScheduler, ambientChatBuffers, clearAmbientChatBuffer };`, sandbox, { filename: sourcePath });
  runtime = sandbox.module.exports;
  const client = createOneBotClient({ OPEN: 1, readyState: 1, send(raw) {
    const action = JSON.parse(raw);
    assert.equal(action.action, "send_group_msg", "Unexpected QQ lookup or network action");
    calls.actions.push(action);
    queueMicrotask(() => {
      const request = pending.get(action.echo);
      clearTimeout(request.timeout); pending.delete(action.echo);
      request.resolve({ status: "ok", retcode: 0, data: { message_id: `out-${++outgoingId}` } });
    });
  } }, pending, { onGroupMessageSent: (...args) => sentHandler(...args), logger: { log() {} } });
  t.after(async () => {
    runtime.ambientReplyScheduler.clear();
    for (const group of runtime.ambientChatBuffers.keys()) runtime.clearAmbientChatBuffer(group);
    runtime.groupChatLearning.stop(); await runtime.groupChatLearning.flush();
    await runtime.agentMemory.close(); await runtime.stickerLibrary.close();
    await runtime.groupBotPolicy.writeChain.catch(() => undefined);
    assert.equal(fs.realpathSync(directory), resolved);
    assert.ok(path.basename(resolved).startsWith("sandstorm-bot-integration-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await flush();
  function message(text, userId = MEMBER, options = {}) {
    const { mentioned = true, targets = [], groupId = GROUP, segments = [], ...extra } = options;
    return handler({ post_type: "message", message_type: "group", self_id: BOT, user_id: userId,
      group_id: groupId, message_id: ++messageId, time: now / 1000,
      message: [...(mentioned ? [at(BOT)] : []), { type: "text", data: { text } }, ...targets.map(at), ...segments], ...extra,
    }, client);
  }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; timers.delete(id); now = timer.at; await timer.fn(); await flush();
    }
    now = end; await flush();
  }
  return { calls, config, runtime, client, message, advance, directory };
}

test("the real entrypoint shares durable group memory across members and rotates without losing records", async t => {
  const h = await fixture(t, { memoryEnabled: true, groupSlangEnabled: true });
  await h.message("记住周五一起玩");
  await h.message("我也来", "90000003");
  assert.equal(h.calls.direct[0].session, `group:${GROUP}`);
  assert.equal(h.calls.direct[1].session, `group:${GROUP}`);
  assert.match(h.calls.direct[1].meta.memoryPrompt, /记住周五一起玩/);
  assert.equal(h.calls.direct[1].meta.memoryTools.has("search_history"), true);
  const count = h.runtime.agentMemory.recent(`group:${GROUP}`).length;
  await h.message("轮换会话");
  await h.message("继续聊");
  assert.ok(h.runtime.agentMemory.recent(`group:${GROUP}`).length > count);
  assert.equal(h.calls.direct.length, 3);
  assert.ok(fs.existsSync(path.join(h.directory, "memory", "messages.db")));
  await h.message("学黑话 开摆=先休息不卷了；场景=轻松自嘲；禁用=认真求助");
  assert.equal(h.runtime.groupChatLearning.getSlang(GROUP)[0].term, "开摆");
  await h.message("黑话列表", "90000004");
  assert.match(h.calls.actions.at(-1).params.message, /先休息不卷了/);
});

test("the real entrypoint collects paired OCR, sends a matching image and never re-collects its own image", async t => {
  let analyzed = 0, chosen = 0;
  const h = await fixture(t, { memoryEnabled: true, stickerEnabled: true }, { analyze: () => {
    analyzed++; return { transcription: "好耶", uncertain_text: [], description: "猫猫庆祝", emotions: ["开心"], usage: ["胜利"], avoid: ["悲伤"], confidence: 0.99 };
  }, choose: candidates => { chosen++; return { sticker_id: candidates[0].id, context_match: true, confidence: 0.99 }; } });
  h.runtime.stickerLibrary.download = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  await h.message("收集表情", MEMBER, { segments: [{ type: "image", data: { url: "https://qpic.cn/test" } }] });
  await h.runtime.stickerLibrary.flush();
  assert.equal(analyzed, 1);
  const item = Object.values(h.runtime.stickerLibrary.state(GROUP).value.items)[0];
  assert.equal(item.ocr.imageSha256, item.image.sha256);
  await h.message("赢了！");
  const imageAction = h.calls.actions.find(action => Array.isArray(action.params.message) && action.params.message[0].type === "image");
  assert.ok(imageAction); assert.equal(chosen, 1);
  assert.equal(item.sendCount, 1);
  await h.message("", BOT, { segments: imageAction.params.message, post_type: "message_sent" });
  await h.runtime.stickerLibrary.flush();
  assert.equal(analyzed, 1);
  await h.message("清空表情库");
  assert.equal(h.runtime.stickerLibrary.status(GROUP).total, 1);
  await h.message("清空表情库", ADMIN);
  assert.equal(h.runtime.stickerLibrary.status(GROUP).total, 0);
});

test("only the configured administrator can manage ignores; group owners have no implicit authority", async t => {
  const h = await fixture(t);
  await h.message("忽略", MEMBER, { targets: ["90000003"], sender: { role: "owner" } });
  assert.equal(h.runtime.groupBotPolicy.decision(GROUP, "90000003"), null);
  assert.match(h.calls.actions.at(-1).params.message, /只有机器人管理员/);
  await h.message("忽视一下", ADMIN, { targets: [MEMBER] });
  assert.equal(h.runtime.groupBotPolicy.decision(GROUP, MEMBER), "ignore");
  assert.equal(new GroupBotPolicy(h.config).decision(GROUP, MEMBER), "ignore");
  const actionCount = h.calls.actions.length;
  for (let i = 0; i < 30; i++) await h.message("继续聊", MEMBER, { segments: [
    { type: "image", data: { url: "https://example.com/image.png" } }, { type: "forward", data: { id: "never-read" } },
  ] });
  await h.advance(120000);
  assert.equal(h.calls.actions.length, actionCount);
  assert.equal(h.calls.direct.length + h.calls.judge + h.calls.learning + h.calls.prewarm, 0);
  assert.equal(h.runtime.groupChatLearning.state(GROUP).pendingHumans, 0);
  assert.equal(h.runtime.groupConversationContext.get(GROUP).some(entry => entry.role === "user"), false);
  await h.message("解除忽视", ADMIN, { targets: [MEMBER] });
  await h.message("你好");
  assert.equal(h.calls.direct.length, 1);
  assert.equal(h.runtime.groupBotPolicy.decision(GROUP, MEMBER), "allow");
});

test("management requires a real bot mention, protects administrators, and lists saved ignores", async t => {
  const h = await fixture(t);
  await h.message("忽略", ADMIN, { targets: [MEMBER], mentioned: false });
  assert.equal(h.runtime.groupBotPolicy.decision(GROUP, MEMBER), null);
  await h.message("屏蔽", ADMIN, { targets: [ADMIN] });
  assert.match(h.calls.actions.at(-1).params.message, /不能忽略.*管理员/);
  await h.message("拉黑", ADMIN, { targets: [MEMBER, "90000003"] });
  await h.message("查看忽略列表", ADMIN);
  assert.match(h.calls.actions.at(-1).params.message, /90000002、90000003/);
  assert.equal(h.calls.direct.length + h.calls.judge, 0);
});

test("unknown direct and ambient bot loops stop without new model requests or automatic wakeups", async t => {
  for (const mentioned of [true, false]) {
    const h = await fixture(t);
    for (let i = 0; i < 30; i++) {
      await h.message(`接着说${i}`, MEMBER, { mentioned });
      await h.advance(1000);
    }
    assert.equal(h.runtime.groupBotLoopGuard.canRespond(GROUP, MEMBER), false);
    assert.equal(mentioned ? h.calls.direct.length : h.calls.generate, 4);
    assert.equal(h.runtime.groupConversationContext.get(GROUP).some(entry => entry.userId === MEMBER), false);
    const calls = h.calls.direct.length + h.calls.judge;
    await h.advance(700000);
    await h.runtime.tryAmbientReply(GROUP, "idle", h.client);
    assert.equal(h.calls.direct.length + h.calls.judge, calls);
    await h.message("新群友的问题", "90000003");
    assert.equal(h.calls.direct.length, mentioned ? 5 : 1);
  }
});

test("ignoring an account invalidates a pending direct reply even if it is immediately allowed again", async t => {
  let release;
  const h = await fixture(t, {}, { direct: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.message("问题"); await flush();
  assert.equal(h.calls.direct.length, 1);
  await h.message("屏蔽", ADMIN, { targets: [MEMBER] });
  await h.message("允许", ADMIN, { targets: [MEMBER] });
  release(); await pending;
  assert.equal(h.calls.actions.length, 2);
  assert.equal(h.calls.actions.some(action => /^回复/.test(action.params.message)), false);
});

test("ignoring an account during ambient judgement prevents draft generation", async t => {
  let release;
  const h = await fixture(t, {}, { judge: () => new Promise(resolve => { release = resolve; }) });
  await h.message("来聊聊", MEMBER, { mentioned: false });
  await h.advance(600);
  assert.equal(h.calls.judge, 1);
  await h.message("不要回复", ADMIN, { targets: [MEMBER] });
  release(); await flush();
  assert.equal(h.calls.generate, 0);
  assert.equal(h.calls.actions.length, 1);
});

test("all learning-reset aliases require admin rights and clear saved rules for the current group", async t => {
  const h = await fixture(t);
  const learning = h.runtime.groupChatLearning;
  const rule = { text: "用自然口语表达。", evidence: ["m1"] };
  const other = learning.state("1002"); other.record.rules = [rule];
  const state = learning.state(GROUP);
  for (const alias of ["重置学习模块", "清空学习模块", "重置群聊学习", "清空群聊学习"]) {
    state.record.rules = [rule]; state.record.revision = 1;
    await learning.write(state, state.record);
    await h.message(alias, MEMBER);
    assert.equal(learning.getRules(GROUP).length, 1);
    assert.match(h.calls.actions.at(-1).params.message, /只有机器人管理员/);
    await h.message(alias, ADMIN);
    assert.equal(learning.getRules(GROUP).length, 0);
    assert.equal(learning.getStatus(GROUP).revision, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.directory, "learning", `${GROUP}.json`))).rules, []);
    assert.equal(learning.getRules("1002").length, 1);
  }
  assert.equal(h.calls.direct.length + h.calls.judge + h.calls.learning, 0);
});
