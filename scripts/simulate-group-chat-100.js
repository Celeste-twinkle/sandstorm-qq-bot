// Opt-in live integration run: real index.js, scheduler, context, learning store,
// OneBot client and DeepSeek; isolated fake QQ transport and a virtual clock.
// Usage: node scripts/simulate-group-chat-100.js reports/.../round-01
// Deliberately outside test/: npm test never spends tokens or connects to QQ.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { AsyncLocalStorage } = require("node:async_hooks");
const { config } = require("../src/config");
const aiModule = require("../src/ai");
const ambientModule = require("../src/ambient-chat");
const { DeepSeekChatService } = require("../src/deepseek");
const { WebToolRunner } = require("../src/webtools");
const { createOneBotClient } = require("../src/onebot");
const { members, messages } = require("./fixtures/group-chat-100");

const output = path.resolve(process.argv[2] || "reports/group-chat-100-20261014/round-01");
const report = { startedAt: new Date().toISOString(), status: "running",
  method: "100 fixed synthetic human messages, 12 people; live model and web requests. Actual index.js and OneBot client; fake WebSocket acknowledgements, isolated learning store, virtual time. No QQ connection or delivery. No fixed ambient reply quota.",
  configuration: { model: config.deepseekModel, thinking: config.deepseekThinkingEnabled,
    instantContextSetting: config.ambientChatInstantMaxMessages,
    idleContextSetting: config.ambientChatIdleMaxMessages,
    localHistorySetting: config.localQwenMaxHistoryMessages,
    groupLearning: { enabled: config.groupChatLearningEnabled, minimum: config.groupChatLearningMinMessages,
      every: config.groupChatLearningEveryMessages, intervalMs: config.groupChatLearningMinIntervalMs,
      reasoningEffort: config.groupChatLearningReasoningEffort, maxTokens: config.groupChatLearningMaxOutputTokens },
    draftReviewEnabled: config.ambientChatDraftReviewEnabled,
    selfRepeatCheckEnabled: config.groupChatSelfRepeatCheckEnabled,
    judgeTemperature: config.ambientChatJudgeTemperature, cooldownSeconds: config.ambientChatCooldownSeconds,
    debounceMs: config.ambientChatDebounceMs, idleSeconds: config.ambientChatIdleSeconds },
  members, fixture: messages, events: [], operations: [], requests: [], tools: [], nativeSearchUsage: [], logs: [], checks: [], diagnostics: [],
};
let now = Date.parse("2026-10-14T08:00:00.000Z");
let timerId = 0;
const timers = new Map();
const clock = {
  now: () => now,
  setTimer(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + Math.max(0, delay) }); return id; },
  clearTimer(id) { timers.delete(id); },
};
class VirtualDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const groupId = "99000001";
const botId = "99000002";
const expected = new Map();
const rawMessages = new Map();
const local = new AsyncLocalStorage();
const sanitize = (value) => String(value).split(config.deepseekApiKey).join("[REDACTED]");
const save = () => fs.writeFileSync(path.join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
const log = (level, args) => { report.logs.push({ at: now, level, text: sanitize(args.map(String).join(" ")) }); };
const logger = Object.fromEntries(["log", "warn", "error", "info"].map(level => [level, (...args) => log(level, args)]));
const flush = () => new Promise(resolve => setImmediate(resolve));
let runtime, handler, sentHandler, client, currentHuman = 0, gate = null;

function check(name, condition, detail = "") {
  report.checks.push({ name, pass: Boolean(condition), atHuman: currentHuman, detail });
}
function diagnose(name, condition, detail = "") {
  // QA probes remain visible, but do not rank the user's casual-chat preference.
  report.diagnostics.push({ name, pass: Boolean(condition), atHuman: currentHuman, detail });
}
function expectedWindow() {
  return [...expected.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-50);
}
function verifyContext(label) {
  const actual = runtime.groupConversationContext.get(groupId);
  const wanted = expectedWindow();
  check(`context:${label}`, JSON.stringify(actual.map(x => [x.messageId, x.role, x.timestamp, x.text])) ===
    JSON.stringify(wanted.map(x => [x.messageId, x.role, x.timestamp, x.text])),
  { count: actual.length, assistantCount: actual.filter(x => x.role === "assistant").length });
}
function newOperation(kind, context, meta) {
  const anchor = context.filter(x => x.role === "user").at(-1);
  const row = { id: report.operations.length + 1, kind, at: now, anchor: anchor?.messageId,
    personaName: "大肥鱼", mode: meta.ambientMode,
    context: context.map(x => ({ id: x.messageId, role: x.role, timestamp: x.timestamp })),
    requestIds: [], toolIds: [] };
  report.operations.push(row);
  if (kind !== "learning") check(`fixed-persona:${row.id}`, !meta.personaPrompt && !meta.personaId);
  check(`snapshot:${row.id}`, JSON.stringify(context.map(x => x.messageId)) === JSON.stringify(expectedWindow().map(x => x.messageId)));
  return row;
}
async function observe(kind, context, meta, invoke) {
  const row = newOperation(kind, context, meta);
  return local.run(row, async () => {
    try { row.result = await invoke(); return row.result; }
    catch (error) { row.error = sanitize(error.message); throw error; }
    finally { row.finishedAt = now; save(); }
  });
}

async function trackedFetch(url, options) {
  const body = JSON.parse(options.body);
  const op = local.getStore();
  const row = { id: report.requests.length + 1, operation: op?.id, model: body.model,
    thinking: body.thinking, temperature: body.temperature, maxTokens: body.max_tokens,
    decision: body.response_format?.type === "json_object", messages: body.messages };
  report.requests.push(row);
  op?.requestIds.push(row.id);
  check(`thinking:${row.id}`, body.thinking?.type === (op?.kind === "learning" ? "enabled" : "disabled"));
  if (row.decision) check(`judge-tools:${row.id}`, !body.tools);
  const start = Date.now();
  if (gate && op?.anchor === "h46" && row.decision) { gate.started = true; }
  try {
    const response = await fetch(url, options);
    const payload = await response.clone().json();
    row.status = response.status;
    row.usage = payload.usage;
    row.answer = payload.choices?.[0]?.message?.content;
    row.toolCalls = payload.choices?.[0]?.message?.tool_calls;
    row.finishReason = payload.choices?.[0]?.finish_reason;
    if (row.decision) {
      let valid = false;
      try {
        const decision = JSON.parse(row.answer);
        if (op?.kind === "learning") {
          valid = Array.isArray(decision.rules) && Object.keys(decision).join(",") === "rules";
        } else if (op?.kind === "self-repeat") {
          valid = typeof decision?.self_repeat === "boolean" && Object.keys(decision).join(",") === "self_repeat";
        } else if (op?.kind === "review") {
          row.reviewAction = decision?.action;
          valid = decision && !Array.isArray(decision) && (decision.action === "edit"
            ? typeof decision.text === "string" && Boolean(decision.text.trim()) && Object.keys(decision).length === 2
            : ["send", "skip"].includes(decision.action) && Object.keys(decision).length === 1);
        } else {
          valid = typeof decision?.should_reply === "boolean" && Object.keys(decision).length === 1;
        }
      } catch {}
      check(`valid-${op?.kind === "learning" ? "learning" : op?.kind === "review" ? "review" : op?.kind === "self-repeat" ? "self-repeat" : "judge"}-json:${row.id}`, valid, { operation: op?.id, answer: row.answer });
    }
    if (gate && op?.anchor === "h46" && row.decision) await gate.promise;
    return response;
  } catch (error) { row.error = sanitize(error.message); throw error; }
  finally { row.elapsedMs = Date.now() - start; save(); }
}

class ObservedAi extends aiModule.AiChatService {
  constructor(testConfig) {
    const provider = new DeepSeekChatService(testConfig, { fetch: trackedFetch, logger,
      webToolRunnerFactory(runnerConfig) {
        const runner = new WebToolRunner(runnerConfig, { logger,
          recordSearchResponse(payload) { report.nativeSearchUsage.push({ operation: local.getStore()?.id, model: payload.model, usage: payload.usage }); },
        });
        const execute = runner.runToolCall.bind(runner);
        runner.runToolCall = async call => {
          const op = local.getStore();
          const row = { id: report.tools.length + 1, operation: op?.id, name: call.function.name, arguments: call.function.arguments };
          report.tools.push(row); op?.toolIds.push(row.id);
          const result = await execute(call);
          Object.assign(row, { usableEvidence: runner.hasUsableEvidence(call, result), code: result.code,
            error: result.error, url: result.url, statusCode: result.statusCode, sources: result.sources,
            rendered: runner.formatToolResult(call, result) });
          save(); return result;
        };
        return runner;
      },
    });
    super(testConfig, { deepseekService: provider, logger });
  }
  shouldAmbientReply(context, meta) { return observe("judge", context, meta, () => super.shouldAmbientReply(context, meta)); }
  ambientReply(context, meta) { return observe("ambient", context, meta, () => super.ambientReply(context, meta)); }
  async reviewAmbientReply(context, draft, meta) {
    if (!this.config.ambientChatDraftReviewEnabled) return super.reviewAmbientReply(context, draft, meta);
    const original = report.operations.findLast(op => op.kind === "ambient" && op.result === draft);
    const result = await observe("review", context, {},
      () => super.reviewAmbientReply(context, draft, meta));
    if (original) original.finalReply = result;
    return result;
  }
  async checkOwnReplyRepeat(context, draft) {
    const anchor = context.filter(x => x.role === "user").at(-1)?.messageId;
    const op = local.getStore() || report.operations.findLast(row => row.kind === "ambient" && row.anchor === anchor && row.result === draft);
    if (op) op.draft = draft;
    if (this.config.groupChatSelfRepeatCheckEnabled === false || aiModule.isRepeatedOwnReply(context, draft) || !context.some(x => x.role === "assistant")) return super.checkOwnReplyRepeat(context, draft);
    const result = await observe("self-repeat", context, {}, () => super.checkOwnReplyRepeat(context, draft));
    if (op) op.selfRepeat = result;
    return result;
  }
  chat(session, text, meta) { return observe("direct", meta.groupContextMessages, meta, () => super.chat(session, text, meta)); }
  learnGroupChatStyle(context, previous) { return observe("learning", context, {}, () => super.learnGroupChatStyle(context, previous)); }
}
class VirtualScheduler extends ambientModule.AmbientReplyScheduler {
  constructor() { super({ ...clock, onError: error => logger.error(error.message) }); }
}

async function settle() {
  const start = Date.now();
  while ([...runtime.ambientReplyScheduler.groups.values()].some(x => x.running) || runtime.groupChatLearning?.isBusy()) {
    assert.ok(Date.now() - start < 240000, "Ambient operation exceeded four-minute integration watchdog");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await flush();
}
async function advanceTo(target, wait = true) {
  let count = 0;
  for (;;) {
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    assert.ok(++count < 500, "Unexpected timer spin");
    timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].fn();
    await flush();
    if (wait) await settle();
  }
  now = Math.max(now, target);
}

async function main() {
  assert.equal(messages.length, 100);
  assert.equal(new Set(messages.map(x => x.member)).size, 12);
  assert.ok(config.deepseekApiKey, "DeepSeek API key is required");
  assert.ok(!config.deepseekThinkingEnabled, "This test must preserve non-thinking default");
  assert.ok(config.chatEnabled && config.ambientChatEnabled, "Ambient and direct chat must be enabled");
  assert.ok(!fs.existsSync(path.join(output, "run.json")), "Keep earlier rounds; choose a new output directory");
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-group-simulation-"));
  const testConfig = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false,
    allowedGroupIds: new Set([groupId]), groupChatLearningDir: path.join(temp, "group-chat-learning") };
  const indexPath = path.resolve(__dirname, "../src/index.js");
  const source = fs.readFileSync(indexPath, "utf8");
  report.sourceHashes = {};
  for (const file of ["src/index.js", "src/ai.js", "src/ambient-chat.js", "src/group-context.js", "src/persona.js", "src/group-chat-learning.js", "src/group-chat-learning-prompt.js", "src/deepseek.js", "src/deepseek-harness-web.js", "scripts/fixtures/group-chat-100.js", "scripts/simulate-group-chat-100.js"]) {
    report.sourceHashes[file] = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex");
  }
  const actualRequire = createRequire(indexPath);
  function isolatedRequire(name) {
    if (name === "./config") return { config: testConfig };
    if (name === "./ai") return { ...aiModule, AiChatService: ObservedAi };
    if (name === "./ambient-chat") return { ...ambientModule, AmbientReplyScheduler: VirtualScheduler,
      getAmbientReplyDelay: (mode, last, cfg) => ambientModule.getAmbientReplyDelay(mode, last, cfg, now) };
    if (name === "./onebot") return { createOneBotServer(_cfg, onMessage, onSent) {
      handler = onMessage; sentHandler = onSent;
      return { listen() {}, close(callback) { callback?.(); } };
    } };
    return actualRequire(name);
  }
  const sandbox = { require: isolatedRequire, module: { exports: {} }, __dirname: path.dirname(indexPath),
    __filename: indexPath, console: logger, Date: VirtualDate,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    process: { on() {}, exit() { throw new Error("Unexpected runtime exit"); } },
  };
  vm.runInNewContext(`${source}\nmodule.exports = { groupConversationContext, ambientReplyScheduler, ambientChatBuffers, chatService, groupChatLearning };`, sandbox, { filename: indexPath });
  runtime = sandbox.module.exports;
  const pending = new Map();
  let outgoingId = 0;
  const ws = { OPEN: 1, readyState: 1, send(raw) {
    const action = JSON.parse(raw);
    assert.ok(["send_group_msg", "get_msg"].includes(action.action), "Unexpected OneBot action");
    queueMicrotask(() => {
      const call = pending.get(action.echo);
      assert.ok(call, "Fake acknowledgement must use the actual client's pending action");
      clearTimeout(call.timeout); pending.delete(action.echo);
      const data = action.action === "get_msg" ? rawMessages.get(String(action.params.message_id)) : { message_id: `b${++outgoingId}` };
      call.resolve({ status: "ok", retcode: 0, data, echo: action.echo });
    });
  } };
  client = createOneBotClient(ws, pending, { logger, textChunkMaxChars: config.oneBotTextChunkMaxChars,
    async onGroupMessageSent(group, message, response) {
      const text = aiModule.extractSemanticMessageText({ message });
      const outgoingText = op => Object.hasOwn(op, "finalReply") ? op.finalReply : op.result;
      const operation = report.operations.findLast(op => ["ambient", "direct"].includes(op.kind) &&
        typeof outgoingText(op) === "string" && aiModule.extractSemanticMessageText({ message: outgoingText(op) }).includes(text) && !op.delivered);
      const row = { role: "assistant", messageId: String(response.data.message_id), text, timestamp: now,
        senderName: config.botName, afterHuman: currentHuman, operation: operation?.id };
      check(`sent-attribution:${row.messageId}`, Boolean(operation));
      if (operation && aiModule.extractSemanticMessageText({ message: outgoingText(operation) }).endsWith(text)) operation.delivered = true;
      report.events.push(row); expected.set(row.messageId, row);
      sentHandler(group, message, response);
      verifyContext(`sent:${row.messageId}`);
      // QQ can echo successful sends. It must not create a second history entry.
      await handler({ post_type: "message_sent", group_id: groupId, user_id: botId, self_id: botId,
        message_id: row.messageId, time: now / 1000, message: text, sender: { nickname: config.botName } }, client);
      verifyContext(`echo:${row.messageId}`);
      console.log(JSON.stringify({ botAfter: currentHuman, kind: operation?.kind, reply: text }));
      save();
    },
  });
  for (const item of messages) {
    // During the controlled busy-judge case, do not wait for the blocked request.
    await advanceTo(now + item.gap, !item.releaseJudge);
    currentHuman = item.id;
    const member = members[item.member];
    const segments = [];
    if (item.at) segments.push({ type: "at", data: { qq: botId } });
    if (item.atOther !== undefined) segments.push({ type: "at", data: { qq: members[item.atOther].id } });
    segments.push({ type: "text", data: { text: item.text } });
    const event = { post_type: "message", message_type: "group", group_id: groupId,
      user_id: member.id, self_id: botId, message_id: `h${item.id}`, time: now / 1000,
      sender: { nickname: member.name }, message: segments };
    rawMessages.set(event.message_id, event);
    const row = { role: "user", messageId: event.message_id, userId: member.id, senderName: member.name,
      text: aiModule.extractSemanticMessageText(event), timestamp: now, number: item.id };
    report.events.push(row); expected.set(row.messageId, row);
    if (item.holdJudge) {
      let release; const promise = new Promise(resolve => { release = resolve; });
      gate = { promise, release, started: false };
    }
    await handler(event, client);
    verifyContext(`human:${item.id}`);
    if (item.releaseJudge) { gate.release(); await settle(); }
    if (item.holdJudge) {
      await advanceTo(now + config.ambientChatDebounceMs, false);
      check("busy-judge-started", gate.started);
    } else if (item.flush !== false) {
      await advanceTo(now + config.ambientChatDebounceMs + 1);
    }
    if (item.idle) await advanceTo(now + config.ambientChatIdleSeconds * 1000 + 1000);
    save();
    const decisions = report.operations.filter(x => x.kind === "judge" && x.anchor === event.message_id).map(x => ({ mode: x.mode, decision: x.result }));
    console.log(JSON.stringify({ human: item.id, name: member.name, text: item.text, decisions }));
  }
  await advanceTo(now + Math.max(120000, config.ambientChatIdleSeconds * 1000 + 1000));
  await settle();
  for (const item of messages) {
    const operations = report.operations.filter(op => op.anchor === `h${item.id}`);
    const replies = report.events.filter(event => event.role === "assistant" && operations.some(op => op.id === event.operation));
    if (item.at || item.followup) {
      const ownRepeatSuppressed = operations.some(op => {
        if (!["direct", "ambient"].includes(op.kind)) return false;
        const semanticCheck = operations.find(row => row.kind === "self-repeat" && row.result === true);
        if (op.result !== null && op.selfRepeat !== true && !semanticCheck) return false;
        const draft = op.draft || op.requestIds.map(id => report.requests.find(row => row.id === id)).filter(row => !row?.decision).at(-1)?.answer;
        return op.selfRepeat || Boolean(semanticCheck) || aiModule.isRepeatedOwnReply(op.context.map(x => report.events.find(event => event.messageId === x.id)), draft);
      });
      check(`direct-delivery-or-own-repeat-suppressed:${item.id}`, replies.length > 0 || ownRepeatSuppressed);
    }
    if (item.quiet || item.private) check(`boundary:${item.id}`, replies.length === 0, { replies: replies.map(x => x.text) });
    if (item.noSearch) check(`no-search:${item.id}`, operations.every(op => op.toolIds.length === 0));
    if (item.check) {
      const answer = replies.map(x => x.text).join(" ");
      const patterns = {
        "updated-plan": [/西门/, /八点|8点|8:00/, /红/],
        "five-bottles": [/五瓶|5瓶/],
        "speaker-identity": [/(木木[^，。；]*工卡|工卡[^，。；]*木木)/, /(团子[^，。；]*闹钟|闹钟[^，。；]*团子)/],
        "default-identity-a": [/^(?:大肥鱼|小鲸鱼)[。.!！]?$/],
        "default-identity-b": [/^(?:大肥鱼|小鲸鱼)[。.!！]?$/],
        "default-identity-c": [/^(?:大肥鱼|小鲸鱼)[。.!！]?$/],
        "default-identity-d": [/^(?:大肥鱼|小鲸鱼)[。.!！]?$/],
        "arithmetic": [/^391[。.!！]?$/],
        "unknown": [/不知道|不清楚|猜不(?:到|出来)|[看查]不到|哪(?:里)?知道|怎么(?:会)?知道|不晓得/],
        "boiling": [/100|一百/],
        "no-invented-memory": [/不知道|不清楚|没.{0,6}告诉|猜不(?:到|出来)/],
        "latest-plan": [/北门/, /九点|9点|9:00/, /绿/],
      };
      if (patterns[item.check]) diagnose(`answer:${item.check}`, patterns[item.check].every(pattern => pattern.test(answer)), answer);
      if (item.check === "deepseek-search") {
        const tools = operations.flatMap(op => op.toolIds.map(id => report.tools.find(tool => tool.id === id)));
        const hasEvidence = tools.some(tool => tool?.usableEvidence);
        check("search-attempted", tools.some(tool => tool?.name === "web_search"));
        check("search-evidence-or-honest-uncertainty", hasEvidence || /不确定|不清楚|没查到|没有.{0,6}可靠|无法.{0,6}核实/.test(answer), answer);
      }
    }
  }
  check("stale-judge-does-not-generate", !report.operations.some(op => op.anchor === "h46" && op.kind === "ambient"));
  check("queued-latest-rechecked", report.operations.some(op => op.anchor === "h47" && op.kind === "judge"));
  check("debounce-coalesces-burst", !report.operations.some(op => ["h21", "h22"].includes(op.anchor)) && report.operations.some(op => op.anchor === "h23"));
  check("no-runtime-errors", !report.logs.some(entry => entry.level === "error"), report.logs.filter(entry => entry.level === "error"));
  check("no-judge-failures", !report.logs.some(entry => entry.text.includes("ambient decision failed")));
  check("no-review-failures", !report.logs.some(entry => entry.text.includes("ambient draft review failed")));
  check("no-self-repeat-check-failures", !report.logs.some(entry => entry.text.includes("self-repeat check failed")));
  check("all-api-requests-successful", report.requests.every(row => row.status === 200 && !row.error));
  check("no-truncated-replies", report.requests.every(row => row.finishReason !== "length"));
  check("final-context-50", runtime.groupConversationContext.get(groupId).length === 50);
  check("onebot-actions-settled", pending.size === 0);
  check("no-own-reply-echoes", report.events.every((event, index) => event.role !== "assistant" ||
    !aiModule.isRepeatedOwnReply(report.events.slice(Math.max(0, index - 50), index), event.text)));
  await runtime.groupChatLearning.flush();
  report.learning = runtime.groupChatLearning.getStatus(groupId);
  check("learning-file-persisted", fs.existsSync(path.join(testConfig.groupChatLearningDir, `${groupId}.json`)));
  check("learning-completed", report.learning.revision > 0 && report.learning.rules.length > 0);
  check("learning-all-attempts-saved", report.learning.revision === report.operations.filter(x => x.kind === "learning").length);
  const appliedRules = report.learning.rules.map(rule => rule.text);
  check("learned-style-used", report.requests.some(row => !row.decision && row.messages.some(message =>
    message.role === "system" && appliedRules.some(rule => message.content.includes(rule)))));
  runtime.groupChatLearning.stop();
  runtime.ambientReplyScheduler.clear();
  for (const buffer of runtime.ambientChatBuffers.values()) clock.clearTimer(buffer.timer);
  runtime.chatService.stop();
  report.summary = {
    humans: messages.length, members: members.length,
    botMessages: report.events.filter(x => x.role === "assistant").length,
    decisions: report.operations.filter(x => x.kind === "judge").length,
    acceptedDecisions: report.operations.filter(x => x.kind === "judge" && x.result === true).length,
    reviewedDrafts: report.operations.filter(x => x.kind === "review").length,
    selfRepeatChecks: report.operations.filter(x => x.kind === "self-repeat").length,
    semanticOwnRepeatsBlocked: report.operations.filter(x => x.kind === "self-repeat" && x.result === true).length,
    rejectedDrafts: report.operations.filter(x => x.kind === "review" && x.result === null).length,
    editedDrafts: report.operations.filter(x => x.kind === "ambient" && typeof x.finalReply === "string" && x.finalReply !== x.result).length,
    learningRequests: report.operations.filter(x => x.kind === "learning").length,
    mainInputTokens: report.requests.reduce((sum, x) => sum + (x.usage?.prompt_tokens || 0), 0),
    mainOutputTokens: report.requests.reduce((sum, x) => sum + (x.usage?.completion_tokens || 0), 0),
    searchInputTokens: report.nativeSearchUsage.reduce((sum, x) => sum + (x.usage?.input_tokens || 0) + (x.usage?.cache_read_input_tokens || 0), 0),
    searchOutputTokens: report.nativeSearchUsage.reduce((sum, x) => sum + (x.usage?.output_tokens || 0), 0),
    networkLimitations: report.tools.filter(x => x.code === "WEB_BLOCKED_URL").map(x => ({ name: x.name, code: x.code, reason: x.error })),
    failedChecks: report.checks.filter(x => !x.pass),
    answerDiagnostics: report.diagnostics.filter(x => !x.pass),
  };
  report.finishedAt = new Date().toISOString();
  report.status = report.summary.failedChecks.length ? "automated-checks-failed" : "awaiting-transcript-review";
  save();
  fs.writeFileSync(path.join(output, "transcript.txt"), report.events.map(event => {
    const op = report.operations.find(x => x.id === event.operation);
    return event.role === "user" ? `\n[${String(event.number).padStart(3, "0")}] ${event.senderName}: ${event.text}`
      : `  -> AI (${op?.kind}, ${op?.personaName}, anchor=${op?.anchor}): ${event.text}`;
  }).join("\n") + "\n");
  console.log(JSON.stringify({ status: report.status, ...report.summary }));
  if (report.summary.failedChecks.length) process.exitCode = 1;
}
main().catch(error => {
  report.status = "incomplete"; report.error = sanitize(error.stack || error);
  if (fs.existsSync(output)) save();
  console.error(report.error); process.exitCode = 1;
});
