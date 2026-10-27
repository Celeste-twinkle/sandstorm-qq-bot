// Exercise the packaged snapshot, without starting index.js, QQ or a network request.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

async function snapshotSmoke(expected) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  assert.ok(process.pkg);
  const src = path.dirname(process.pkg.defaultEntrypoint);
  for (const [file, digest] of Object.entries(expected.sourceHashes)) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(src, file))).digest("hex"), digest, `Packaged source differs: ${file}`);
  }
  const { AiChatService, isRepeatedOwnReply } = require(path.join(src, "ai.js"));
  const { DeepSeekChatService } = require(path.join(src, "deepseek.js"));
  const { DeepSeekHarnessWebToolRunner } = require(path.join(src, "deepseek-harness-web.js"));
  const { AmbientReplyGuard, AmbientReplyScheduler } = require(path.join(src, "ambient-chat.js"));
  const { GroupConversationContext } = require(path.join(src, "group-context.js"));
  const { GroupChatLearning, resolveGroupChatLearningDir } = require(path.join(src, "group-chat-learning.js"));
  const { GroupBotLoopGuard } = require(path.join(src, "group-bot-loop-guard.js"));
  const { GroupBotPolicy, parseBotControlCommand, resolveBotPolicyFile } = require(path.join(src, "group-bot-policy.js"));
  const { querySandstormStatus } = require(path.join(src, "sandstorm.js"));
  const { buildHelpText, isLearningResetCommand } = require(path.join(src, "help.js"));
  assert.equal(typeof querySandstormStatus, "function");
  assert.doesNotMatch(buildHelpText(), /人格(?:列表|切换|设置|查询)|自定义人格/);
  assert.match(buildHelpText(), /BOT_ADMIN_IDS/);
  for (const command of ["重置学习模块", "清空学习模块", "重置群聊学习"]) assert.equal(isLearningResetCommand(command), true);
  assert.equal(resolveBotPolicyFile(), path.join(path.dirname(process.execPath), "data", "group-bot-policy.json"));
  const botId = "99000001", peerId = "99000002";
  for (const [text, action] of [["忽视一下", "ignore"], ["无视", "ignore"], ["别理", "ignore"], ["解除屏蔽", "allow"], ["不要忽略", "allow"]]) {
    assert.deepEqual(parseBotControlCommand({ self_id: botId, message: `[CQ:at,qq=${botId}] ${text} [CQ:at,qq=${peerId}]` }),
      { action, targets: [peerId] });
  }
  const policyConfig = { groupChatBotPolicyFile: expected.botPolicyFile };
  const botPolicy = new GroupBotPolicy(policyConfig);
  await botPolicy.set("1001", [peerId], "ignore");
  assert.equal(new GroupBotPolicy(policyConfig).decision("1001", peerId), "ignore");
  assert.equal(botPolicy.decision("1002", peerId), null);
  const botLoopGuard = new GroupBotLoopGuard({ botAdminIds: new Set(["631978355"]) }, {
    accountDecision: (group, user) => botPolicy.decision(group, user),
  });
  const incomingBot = id => ({ group_id: "1001", user_id: peerId, message_id: id });
  assert.equal(botLoopGuard.inspect(incomingBot(1)).allowed, false);
  await botPolicy.set("1001", [peerId], "allow");
  assert.equal(botLoopGuard.inspect(incomingBot(2)).allowed, true);
  for (let turn = 1; turn <= 4; turn++) {
    botLoopGuard.recordReply("1001", peerId);
    assert.equal(botLoopGuard.inspect(incomingBot(turn + 2)).allowed, turn < 4);
  }
  assert.equal(botLoopGuard.canRespond("1001", peerId), false);
  assert.equal(botLoopGuard.inspect({ group_id: "1001", user_id: "631978355", message_id: 100 }).allowed, true);
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
    chatMaxContextChars: 64000, chatMaxHistoryMessages: 100,
    ambientChatInstantMaxMessages: 100, ambientChatIdleMaxMessages: 100,
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
  for (let i = 119; i >= 0; i--) timeline.append("g", { messageId: String(i), timestamp: i, text: `row-${i}`, role: i % 4 ? "user" : "assistant" });
  assert.deepEqual(timeline.get("g").map(x => x.messageId), Array.from({ length: 100 }, (_, i) => String(i + 20)));
  const groupWindow = timeline.get("g");
  timeline.append("g", { messageId: "119", timestamp: 999, text: "echo", role: "user" });
  assert.equal(timeline.get("g").length, 100);
  assert.equal(timeline.get("g").at(-1).timestamp, 119);
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
      assert.equal(records.length, 100);
      assert.deepEqual(records.map(message => message.content.match(/row-\d+/)[0]),
        Array.from({ length: 100 }, (_, i) => `row-${i + 20}`));
      assert.equal(records.filter(message => message.role === "assistant").length, 25);
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
  await learning.reset("1001");
  assert.equal(learning.getStatus("1001").revision, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expected.learningDir, "1001.json"))).rules, []);
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

  const { AgentMemory, createMemoryTools } = require(path.join(src, "agent-memory.js"));
  const { StickerLibrary } = require(path.join(src, "sticker-library.js"));
  const { parseSlangResult, buildSlangPrompt } = require(path.join(src, "group-slang.js"));
  const { scoreImportance, selectTraits, timeOfDayMood } = require(path.join(src, "memory-policy.js"));
  const logger = { info() {}, warn() {}, error() {} };
  const memoryConfig = { memoryStateDir: expected.memoryDir, memoryRecentMessages: 100,
    memoryRotationTokenLimit: 100, memoryRotationCooldownHours: 0 };
  const memory = new AgentMemory(memoryConfig, { logger });
  let stickers;
  try {
    for (let index = 0; index < 130; index++) memory.record("group:1001", {
      role: "user", messageId: `memory-${index}`, userId: peerId, senderName: "Synthetic member", timestamp: index + 1,
      text: index === 0 ? "Our promise is Friday rice." : `Ordinary message ${index}`,
    });
    memory.record("group:1002", { role: "user", messageId: "other", userId: peerId, timestamp: 200, text: "Other group only" });
    const recovered = new AgentMemory(memoryConfig, { logger });
    try {
      assert.equal(recovered.recent("group:1001").length, 100);
      assert.equal((await recovered.search("group:1001", "promise"))[0].text, "Our promise is Friday rice.");
      assert.deepEqual(await recovered.search("group:1001", "Other group only"), []);
    } finally { await recovered.close(); }
    let lease = memory.beginTurn("group:1001");
    const previousId = lease.id;
    memory.recordUsage(lease, { prompt_tokens: 120 }); memory.finishTurn(lease);
    lease = memory.beginTurn("group:1001");
    const tools = createMemoryTools(memory, lease);
    assert.ok((await tools.runToolCall(call("search_history", { query: "promise", key: "group:1002" }))).error);
    assert.equal((await tools.runToolCall(call("write_diary", { title: "A promise", body: "I remember our Friday rice promise." }))).saved, true);
    memory.finishTurn(lease);
    lease = memory.beginTurn("group:1001");
    assert.notEqual(lease.id, previousId);
    assert.equal(memory.contextForTurn(lease).length, 20);
    assert.equal(memory.recent("group:1001").length, 100);
    assert.match(memory.readDiaryPreview("group:1001"), /Friday rice/);
    memory.finishTurn(lease);
    assert.ok(scoreImportance({ text: "记住，约定明天见" }) > scoreImportance({ text: "哈哈哈哈" }));
    assert.equal(timeOfDayMood(new Date("2026-10-27T18:00:00Z"), "Asia/Shanghai").slot, "凌晨");
    assert.ok(selectTraits(["他答应每周五陪我聊天", ...Array.from({ length: 12 }, (_, i) => `他刚才安装了工具${i}`)], 12).kept.includes("他答应每周五陪我聊天"));

    const slang = parseSlangResult([{ term: "寄", meaning: "这局没戏了", usage: "游戏失利时自嘲", avoid: "认真求助", confidence: 0.99, evidence: ["m1", "m2"] }], [
      { role: "user", messageId: "slang-a", userId: peerId, text: "这局寄了" },
      { role: "user", messageId: "slang-b", userId: "99000003", text: "寄，打不过了" },
    ]);
    assert.equal(slang[0].status, "confirmed");
    assert.match(buildSlangPrompt(slang, "寄了"), /认真求助/);

    let now = 1000000;
    stickers = new StickerLibrary({ memoryStateDir: expected.memoryDir, stickerEnabled: true, stickerMaxPerGroup: 1 }, {
      logger, now: () => now,
      download: async source => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(source)]),
      analyze: async () => ({ transcription: "好耶", uncertain_text: [], description: "猫猫庆祝", emotions: ["开心"], usage: ["胜利"], avoid: ["悲伤"], confidence: 0.99 }),
      choose: async candidates => ({ sticker_id: candidates[0].id, context_match: true, confidence: 0.99 }),
    });
    const stickerContext = [{ messageId: "victory", userId: peerId, role: "user", text: "赢了", timestamp: 1 }];
    const collect = async name => {
      stickers.observe("1001", { message_id: name, user_id: peerId, self_id: botId, time: now / 1000,
        message: [{ type: "image", data: { sub_type: 1, url: `https://qpic.cn/${name}` } }] }, stickerContext);
      await stickers.flush();
    };
    await collect("first");
    const first = Object.values(stickers.state("1001").value.items)[0];
    assert.equal(first.ocr.imageSha256, first.image.sha256);
    assert.equal(first.ocr.transcription, "好耶");
    now += 2 * 86400000;
    await collect("second");
    assert.equal(stickers.status("1001").total, 1);
    assert.equal(fs.existsSync(path.join(expected.memoryDir, "stickers", "assets", first.image.file)), false);
    const selected = await stickers.select("1001", stickerContext, "好耶");
    assert.ok(selected); assert.equal(selected.segment.type, "image"); selected.release();
  } finally { await stickers?.close(); await memory.close(); }
  console.log(JSON.stringify({ passed: true, runtime: process.version,
    searchRecovery: true, structuredJudgement: true, rejectedDraftNotDelivered: true, extractiveReview: true,
    fixedDefaultPersonaReminder: true, chronological100WithEchoDedup: true, ambientPhasesShare100DespiteLegacyLimits: true, serializedLatestScheduling: true,
    groupLearningPersists: true, learnedStyleAppliedToRepliesWithoutGatingInterest: true,
    learningWithThinkingWithoutTools: true, learningBudget8192: true, learningDirBesideExe: true, obsoleteHintsCanBeRetired: true,
    ongoingPublicChatDoesNotInvalidateInference: true, messagesDuringFinalInferenceRetained: true,
    humanEchoAllowedOwnExactRepeatBlocked: true,
    botIgnoreAllowPersistsByGroup: true, looseAdminCommandAliases: true,
    unknownBotLoopStopsLocally: true, learningResetPersists: true,
    promptHashesMatchSource: true, sourceHashesMatch: true, durableMemoryRecovers: true,
    archiveSearchIsScoped: true, diaryAndRotationPreserveMemory: true, confirmedSlangUsesHumanEvidence: true,
    stickerOcrImagePairing: true, stickerCapacityEvictsPairsAndAssets: true, contextualStickerSelection: true,
    noNetwork: true, noQQConnection: true }));
}

const root = path.resolve(__dirname, "..");
const exe = path.join(root, "deploy", "SandstormQQBot-Deploy", "sandstorm-qq-bot.exe");
const reportPath = path.resolve(process.argv[2] || "reports/deploy/package-smoke.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const persona = require("../src/persona");
const expected = { prompts: Object.fromEntries([
  "DEFAULT_AI_PERSONA_PROMPT",
  "DEFAULT_AMBIENT_CHAT_JUDGE_PROMPT", "DEFAULT_AMBIENT_TURN_REMINDER", "DEFAULT_AMBIENT_DRAFT_REVIEW_PROMPT",
  "DEFAULT_OWN_REPLY_REVIEW_PROMPT",
  "DEFAULT_GROUP_CONTEXT_PROMPT", "DEFAULT_AMBIENT_INSTANT_CONTEXT_PROMPT", "DEFAULT_AMBIENT_IDLE_CONTEXT_PROMPT", "DEFAULT_DIRECT_GROUP_CONTEXT_PROMPT", "DEFAULT_AMBIENT_DECISION_REQUEST",
].map(key => [key, hash(persona[key])])) };
expected.learningPrompts = Object.fromEntries(Object.entries(require("../src/group-chat-learning-prompt")).map(([key, value]) => [key, hash(value)]));
expected.sourceHashes = Object.fromEntries([
  "agent-memory.js", "ai.js", "config.js", "deepseek.js", "group-chat-learning.js", "group-context.js",
  "group-slang.js", "index.js", "memory-policy.js", "message-archive.js", "message-context.js", "persistent-state.js", "qwen.js", "sticker-library.js",
].map(file => [file, hash(fs.readFileSync(path.join(root, "src", file)))]));
const exeSha256 = hash(fs.readFileSync(exe));
for (const folder of ["dist", "release"]) assert.equal(hash(fs.readFileSync(path.join(root, folder, "sandstorm-qq-bot.exe"))), exeSha256);
for (const folder of ["release", path.join("deploy", "SandstormQQBot-Deploy")]) {
  assert.equal(fs.existsSync(path.join(root, folder, "config", "azur-lane-personas.json")), false);
  assert.equal(fs.existsSync(path.join(root, folder, ".env")), false);
  assert.equal(hash(fs.readFileSync(path.join(root, folder, ".env.example"))), hash(fs.readFileSync(path.join(root, ".env.example"))));
  assert.equal(hash(fs.readFileSync(path.join(root, folder, "scripts", "serve-memory-embeddings.py"))),
    hash(fs.readFileSync(path.join(root, "scripts", "serve-memory-embeddings.py"))));
  assert.equal(hash(fs.readFileSync(path.join(root, folder, "README.md"))), hash(fs.readFileSync(path.join(root, "README.md"))));
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-full-deploy-check-"));
expected.learningDir = path.join(temp, "group-chat-learning");
expected.botPolicyFile = path.join(temp, "group-bot-policy.json");
expected.memoryDir = path.join(temp, "agent-memory");
const script = path.join(temp, "check.cjs");
fs.writeFileSync(script, `(${snapshotSmoke.toString()})(${JSON.stringify(expected)}).catch(error => { console.error(error); process.exitCode = 1; });`);
const output = execFileSync(exe, [script], { cwd: temp, env: { ...process.env, PKG_EXECPATH: exe },
  windowsHide: true, timeout: 20000, encoding: "utf8" });
const report = { ...JSON.parse(output.trim().split(/\r?\n/).at(-1)), exeSha256, date: new Date().toISOString() };
assert.equal(report.passed, true);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
