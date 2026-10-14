// Exercise the packaged snapshot, without starting index.js, QQ or a network request.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

async function snapshotSmoke(expected) {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  assert.ok(process.pkg);
  const src = path.dirname(process.pkg.defaultEntrypoint);
  const { AiChatService, isRepeatedOwnReply } = require(path.join(src, "ai.js"));
  const { DeepSeekChatService } = require(path.join(src, "deepseek.js"));
  const { DeepSeekHarnessWebToolRunner } = require(path.join(src, "deepseek-harness-web.js"));
  const { AmbientReplyGuard, AmbientReplyScheduler } = require(path.join(src, "ambient-chat.js"));
  const { GroupConversationContext } = require(path.join(src, "group-context.js"));
  const { GroupChatLearning, resolveGroupChatLearningDir } = require(path.join(src, "group-chat-learning.js"));
  const { querySandstormStatus } = require(path.join(src, "sandstorm.js"));
  const { buildHelpText } = require(path.join(src, "help.js"));
  assert.equal(typeof querySandstormStatus, "function");
  assert.doesNotMatch(buildHelpText(), /人格(?:列表|切换|设置|查询)|自定义人格/);
  const learningPrompts = require(path.join(src, "group-chat-learning-prompt.js"));
  const persona = require(path.join(src, "persona.js"));
  for (const [key, hash] of Object.entries(expected.prompts)) {
    assert.equal(createHash("sha256").update(persona[key]).digest("hex"), hash);
  }
  for (const [key, hash] of Object.entries(expected.learningPrompts)) {
    assert.equal(createHash("sha256").update(learningPrompts[key]).digest("hex"), hash);
  }
  assert.equal(resolveGroupChatLearningDir(), path.join(path.dirname(process.execPath), "data", "group-chat-learning"));
  const config = { aiPrimaryProvider: "deepseek", localQwenEnabled: false,
    deepseekApiKey: "synthetic-package-test", deepseekModel: "deepseek-flash", deepseekThinkingEnabled: false,
    deepseekSystemPrompt: persona.DEFAULT_AI_PERSONA_PROMPT, personaFlexibilityPrompt: "",
    naturalChatPrompt: "", ambientChatSystemPrompt: persona.DEFAULT_AMBIENT_CHAT_SYSTEM_PROMPT,
    ambientChatDraftReviewEnabled: true, // Explicitly exercise optional review in this package smoke.
    groupChatSelfRepeatCheckEnabled: false,
    deepseekMaxOutputTokens: 1600, deepseekTemperature: 0.9,
    chatMaxContextChars: 64000, chatMaxHistoryMessages: 50,
    ambientChatInstantMaxMessages: 50, ambientChatIdleMaxMessages: 50,
    ambientChatMaxOutputTokens: 180, ambientChatJudgeMaxOutputTokens: 64,
    webSearchAutoEnabled: true, webSearchProvider: "deepseek-official",
    webSearchMaxToolRounds: 2, webSearchMaxToolCallsPerRound: 2, webSearchDiagnosticsEnabled: false };
  const call = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const replies = [{ tool_calls: [call("web_search", { queries: ["synthetic public release"] })] },
    { content: "Premature unverified answer" }, { tool_calls: [call("web_fetch", { url: "https://example.com/release" })] },
    { content: "Verified source: https://example.com/release" }];
  const requests = [], executed = [];
  const service = new DeepSeekChatService(config, { webToolRunnerFactory() {
    const runner = new DeepSeekHarnessWebToolRunner(config, {
      searchProvider: { async search() { return { sources: [{ url: "https://example.com/release", title: "Release" }], truncated: false }; } },
      fetchProvider: { async fetch({ url }) { return { url, statusCode: 200, body: { kind: "html", content: "<h1>Release</h1><p>Export was added.</p>" }, truncated: false }; } },
    });
    const run = runner.runToolCall.bind(runner);
    runner.runToolCall = async item => { executed.push(item.function.name); return run(item); };
    return runner;
  } });
  service.requestCompletion = async body => {
    const message = replies[requests.length];
    assert.ok(message, "Unexpected model call"); requests.push(structuredClone(body));
    return { choices: [{ message }] };
  };
  assert.match(await service.createCompletion([{ role: "user", content: "Synthetic release question" }], { webSearch: "auto" }), /^Verified/);
  assert.deepEqual(executed, ["web_search", "web_fetch"]);
  assert.equal(requests.length, 4);
  assert.match(requests[1].messages.at(-1).content, /discovery_only/);
  assert.ok(requests.every(body => body.thinking.type === "disabled"));
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /Premature unverified answer/);

  const ai = new AiChatService(config);
  const decisionCalls = [];
  const answers = ['{"should_reply":true}', "Unsupported draft", '{"action":"skip"}',
    '{"should_reply":true}', "Sounds good. Remember next time.", '{"action":"edit","text":"Sounds good."}'];
  ai.deepseek.requestCompletion = async body => {
    const content = answers[decisionCalls.length];
    assert.ok(content); decisionCalls.push(body);
    return { choices: [{ message: { content } }] };
  };
  const context = [{ role: "user", text: "Synthetic question", userId: "member", messageId: "one", timestamp: 1 }];
  const skipped = [];
  assert.equal(await ai.ambientReplyIfAppropriate(context, { ambientMode: "instant" }, {
    onSkip: reason => skipped.push(reason),
  }), null);
  assert.deepEqual(skipped, ["draft_rejected"]);
  assert.equal(decisionCalls.length, 3);
  assert.equal(decisionCalls[0].messages.length, 2);
  assert.equal(JSON.parse(decisionCalls[0].messages[1].content.split("\n")[1]).messages.length, 1);
  assert.ok(decisionCalls[0].messages[1].content.includes(persona.DEFAULT_AMBIENT_TURN_REMINDER));
  assert.ok(decisionCalls[1].messages[0].content.includes(persona.DEFAULT_AI_PERSONA_PROMPT));
  assert.equal(decisionCalls[1].messages.filter(message => message.role === "system").length, 1);
  assert.equal(JSON.parse(decisionCalls[2].messages[1].content).draft, "Unsupported draft");
  assert.equal(await ai.ambientReplyIfAppropriate(context, { ambientMode: "instant" }), "Sounds good.");
  assert.equal(decisionCalls.length, 6);
  assert.equal(decisionCalls[5].max_tokens, 180);
  assert.ok(decisionCalls.every(body => body.thinking.type === "disabled"));
  assert.ok(!decisionCalls[0].tools && !decisionCalls[2].tools);
  assert.equal(ai.sessions.size, 0);

  const timeline = new GroupConversationContext();
  for (let i = 69; i >= 0; i--) timeline.append("g", { messageId: String(i), timestamp: i, text: `row-${i}`, role: i % 4 ? "user" : "assistant" });
  assert.deepEqual(timeline.get("g").map(x => x.messageId), Array.from({ length: 50 }, (_, i) => String(i + 20)));
  const groupWindow = timeline.get("g");
  timeline.append("g", { messageId: "69", timestamp: 999, text: "echo", role: "user" });
  assert.equal(timeline.get("g").length, 50);
  assert.equal(timeline.get("g").at(-1).timestamp, 69);
  config.ambientChatInstantMaxMessages = 4;
  config.ambientChatIdleMaxMessages = 6;
  config.localQwenMaxHistoryMessages = 8;
  for (const ambientMode of ["instant", "idle"]) {
    const offset = decisionCalls.length;
    answers.push('{"should_reply":true}', "A connected reply.", '{"action":"send"}');
    assert.equal(await ai.ambientReplyIfAppropriate(groupWindow, {
      ambientMode, personaPrompt: "Current member persona",
    }), "A connected reply.");
    const judgement = JSON.parse(decisionCalls[offset].messages[1].content.split("\n")[1]).messages;
    const generation = decisionCalls[offset + 1].messages.filter(message => message.role !== "system");
    const review = JSON.parse(decisionCalls[offset + 2].messages[1].content).history;
    for (const records of [judgement, generation, review]) {
      assert.equal(records.length, 50);
      assert.deepEqual(records.map(message => message.content.match(/row-\d+/)[0]),
        Array.from({ length: 50 }, (_, i) => `row-${i + 20}`));
      assert.equal(records.filter(message => message.role === "assistant").length, 13);
    }
  }
  const hint = "Contextual words can express a complete reaction without added explanations.";
  answers.push(JSON.stringify({ rules: [{ text: hint, evidence: ["m1"] }] }));
  const learning = new GroupChatLearning({ ...config, groupChatLearningDir: expected.learningDir,
    groupChatLearningMinMessages: 2, groupChatLearningEveryMessages: 2, groupChatLearningMinIntervalMs: 0 }, {
    learn: (context, previous) => ai.learnGroupChatStyle(context, previous), logger: { info() {}, warn() {} },
  });
  const learningHistory = [{ role: "user", messageId: "a", text: "A short reaction", timestamp: 1 },
    { role: "user", messageId: "b", text: "Another reaction", timestamp: 2 }];
  learning.observe("1001", learningHistory); await learning.flush();
  assert.equal(learning.getStatus("1001").revision, 1);
  const restored = new GroupChatLearning({ groupChatLearningDir: expected.learningDir });
  assert.deepEqual(restored.getRules("1001"), learning.getRules("1001"));
  const learnedCall = decisionCalls.at(-1);
  assert.equal(learnedCall.thinking.type, "enabled"); assert.ok(!learnedCall.tools);
  assert.equal(learnedCall.reasoning_effort, "high");
  assert.equal(learnedCall.max_tokens, 8192);
  answers.push('{"should_reply":true}', "OK", '{"action":"send"}');
  assert.equal(await ai.ambientReplyIfAppropriate(learningHistory, {
    groupChatStyle: restored.getRules("1001"),
  }), "OK");
  assert.ok(!decisionCalls.at(-3).messages.some(message => message.role === "system" && message.content.includes(hint)));
  for (const body of decisionCalls.slice(-2)) {
    assert.ok(body.messages.some(message => message.role === "system" && message.content.includes(hint)));
  }
  answers.push('{"rules":[]}');
  learning.observe("1001", [...learningHistory,
    { role: "user", messageId: "c", text: "New feedback", timestamp: 3 },
    { role: "user", messageId: "d", text: "More feedback", timestamp: 4 }]);
  await learning.flush();
  assert.equal(learning.getStatus("1001").revision, 2);
  assert.deepEqual(learning.getRules("1001"), []);
  learning.stop();

  const scheduler = new AmbientReplyScheduler();
  const order = [];
  let release, entered, finished;
  const firstWait = new Promise(resolve => { release = resolve; });
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const latestDone = new Promise(resolve => { finished = resolve; });
  scheduler.schedule("g", async () => { order.push("first"); entered(); await firstWait; });
  await firstEntered;
  scheduler.schedule("g", () => order.push("superseded"));
  scheduler.schedule("g", () => { order.push("latest"); finished(); });
  release(); await latestDone; await new Promise(setImmediate);
  assert.deepEqual(order, ["first", "latest"]); assert.equal(scheduler.groups.size, 0);

  const guard = new AmbientReplyGuard();
  const advancing = [{ role: "user", messageId: "u1", text: "Food chat", timestamp: 1 }];
  const ticket = guard.begin("g", advancing);
  advancing.push({ role: "user", messageId: "u2", text: "More food chat", timestamp: 2 });
  assert.equal(guard.canContinue(ticket, advancing), true);
  assert.equal(guard.canSend(ticket, advancing), false);
  assert.equal(guard.refresh(ticket, advancing), true);
  assert.equal(guard.canSend(ticket, advancing), true);
  guard.cancel("g"); assert.equal(guard.canContinue(ticket, advancing), false);
  assert.equal(isRepeatedOwnReply([{ role: "user", text: "哈哈" }], "哈哈"), false);
  assert.equal(isRepeatedOwnReply([{ role: "assistant", text: "哈哈" }], "哈哈！"), true);

  const proactive = new AiChatService({ ...config, ambientChatDraftReviewEnabled: false });
  const advancingDraft = [{ role: "user", messageId: "p1", text: "Rice", timestamp: 1 }];
  let phases = 0, reviewed;
  proactive.deepseek.requestCompletion = async body => {
    phases++;
    if (phases === 1) advancingDraft.push({ role: "user", messageId: "p2", text: "More eggs", timestamp: 2 });
    if (phases === 2) advancingDraft.push({ role: "user", messageId: "p3", text: "More rice", timestamp: 3 });
    if (phases === 3) {
      const data = JSON.parse(body.messages[1].content.split("\n")[1]);
      assert.equal(data.draft, "Eggs and rice");
      assert.match(JSON.stringify(data.messages), /More rice/);
      advancingDraft.push({ role: "user", messageId: "p4", text: "Late news", timestamp: 4 });
    }
    return { choices: [{ message: { content: phases === 2 ? "Eggs and rice" : '{"should_reply":true}' } }] };
  };
  assert.equal(await proactive.ambientReplyIfAppropriate(advancingDraft, {}, {
    getCurrentContext: () => advancingDraft, onContextReviewed: context => { reviewed = context; },
  }), "Eggs and rice");
  assert.equal(phases, 3);
  assert.equal(reviewed.at(-1).messageId, "p3");
  assert.equal(advancingDraft.at(-1).messageId, "p4");
  proactive.stop();
  scheduler.clear(); ai.stop();
  console.log(JSON.stringify({ passed: true, runtime: process.version,
    searchRecovery: true, structuredJudgement: true, rejectedDraftNotDelivered: true, extractiveReview: true,
    fixedDefaultPersonaReminder: true, chronological50WithEchoDedup: true, ambientPhasesShare50DespiteLegacyLimits: true, serializedLatestScheduling: true,
    groupLearningPersists: true, learnedStyleAppliedToRepliesWithoutGatingInterest: true,
    learningWithThinkingWithoutTools: true, learningBudget8192: true, learningDirBesideExe: true, obsoleteHintsCanBeRetired: true,
    ongoingPublicChatDoesNotInvalidateInference: true, messagesDuringFinalInferenceRetained: true,
    humanEchoAllowedOwnExactRepeatBlocked: true,
    promptHashesMatchSource: true, noNetwork: true, noQQConnection: true }));
}

const root = path.resolve(__dirname, "..");
const exe = path.join(root, "deploy", "SandstormQQBot-Deploy", "sandstorm-qq-bot.exe");
const reportPath = path.resolve(process.argv[2] || "reports/group-chat-100-20261014/package-smoke.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const persona = require("../src/persona");
const expected = { prompts: Object.fromEntries([
  "DEFAULT_AI_PERSONA_PROMPT",
  "DEFAULT_AMBIENT_CHAT_JUDGE_PROMPT", "DEFAULT_AMBIENT_TURN_REMINDER", "DEFAULT_AMBIENT_DRAFT_REVIEW_PROMPT",
  "DEFAULT_OWN_REPLY_REVIEW_PROMPT",
  "DEFAULT_GROUP_CONTEXT_PROMPT", "DEFAULT_AMBIENT_INSTANT_CONTEXT_PROMPT", "DEFAULT_AMBIENT_IDLE_CONTEXT_PROMPT", "DEFAULT_DIRECT_GROUP_CONTEXT_PROMPT", "DEFAULT_AMBIENT_DECISION_REQUEST",
].map(key => [key, hash(persona[key])])) };
expected.learningPrompts = Object.fromEntries(Object.entries(require("../src/group-chat-learning-prompt")).map(([key, value]) => [key, hash(value)]));
const exeSha256 = hash(fs.readFileSync(exe));
for (const folder of ["dist", "release"]) assert.equal(hash(fs.readFileSync(path.join(root, folder, "sandstorm-qq-bot.exe"))), exeSha256);
for (const folder of ["release", path.join("deploy", "SandstormQQBot-Deploy")]) {
  assert.equal(fs.existsSync(path.join(root, folder, "config", "azur-lane-personas.json")), false);
  assert.equal(fs.existsSync(path.join(root, folder, ".env")), false);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-full-deploy-check-"));
expected.learningDir = path.join(temp, "group-chat-learning");
const script = path.join(temp, "check.cjs");
fs.writeFileSync(script, `(${snapshotSmoke.toString()})(${JSON.stringify(expected)}).catch(error => { console.error(error); process.exitCode = 1; });`);
const output = execFileSync(exe, [script], { cwd: temp, env: { ...process.env, PKG_EXECPATH: exe },
  windowsHide: true, timeout: 20000, encoding: "utf8" });
const report = { ...JSON.parse(output.trim().split(/\r?\n/).at(-1)), exeSha256, date: new Date().toISOString() };
assert.equal(report.passed, true);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
