// Opt-in live generation A/B. Both arms receive identical frozen conversations,
// persona and learned guidance. It neither connects to QQ nor updates learning.
// Usage: node scripts/compare-group-restrictions.js reports/.../restriction-ab
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { buildLearnedGroupStylePrompt } = require("../src/group-chat-learning");
const { DEFAULT_GROUP_CONTEXT_PROMPT, DEFAULT_DIRECT_GROUP_CONTEXT_PROMPT,
  DEFAULT_AMBIENT_INSTANT_CONTEXT_PROMPT } = require("../src/persona");

const output = path.resolve(process.argv[2] || "reports/whale-group-learning-20261014/npc/restriction-ab");
const compact = process.argv[3] === "compact";
const freeChat = process.argv[3] === "free-chat";
const casualPace = process.argv[3] === "casual-pace";
const frozenBaseline = freeChat || casualPace ? JSON.parse(fs.readFileSync(path.resolve(casualPace
  ? "reports/whale-group-learning-20261014/npc/free-chat-ab/results.json"
  : "reports/whale-group-learning-20261014/npc/restriction-ab/results.json"), "utf8")) : null;
// A compact factual boundary, without the previous expression-rule catalogue.
const factualBoundary = "你通过文字和已提供的工具参与群聊，不能实际上线游戏、赴约、操作实物或有现实生活习惯。关于他人和现实的事实只依据群友记录和已读资料；旧 assistant 的猜测和虚构经历不算证据。";
const source = path.resolve("reports/whale-group-learning-20261014/npc/round-01/run.json");
const original = JSON.parse(fs.readFileSync(source, "utf8"));
const service = new AiChatService(config);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conversation = messages => messages.filter(message => message.role !== "system");

const replayAnchors = [3, 7, 9, 25, 35, 39, 55, 67, 77, 94, 44, 49, 61, 75];
let cases = replayAnchors.map(number => {
  const op = original.operations.find(item => ["ambient", "direct"].includes(item.kind) && item.anchor === `h${number}`);
  assert.ok(op, `Missing frozen context h${number}`);
  const context = op.context.map(item => ({ ...original.events.find(event => event.messageId === item.id) }));
  const tail = original.requests.find(request => request.operation === op.id)?.messages.at(-1)?.content || "";
  const rules = tail.includes('"learned_guidance"') ? original.learning.rules : [];
  return { id: `replay-h${number}`, source: "round-01 frozen conversation", mode: op.kind === "direct" ? "direct" : "instant", context, rules };
});

const heldout = [
  { id: "new-small-mishap", mode: "instant", rows: [
    ["user", "阿青", "新买的伞刚撑开就被风翻了"],
    ["user", "灰灰", "人没湿，伞先趴下了"],
    ["user", "阿青", "现在拿着一朵倒着开的花往回走"]] },
  { id: "new-good-news", mode: "instant", rows: [
    ["user", "阿青", "面试结果出来了"],
    ["user", "阿青", "拿到 offer 了！！"],
    ["user", "灰灰", "我靠恭喜！！你前两天还紧张成那样"]] },
  { id: "new-disappointment", mode: "direct", rows: [
    ["user", "阿青", "准备了两周的面试还是没过"],
    ["user", "阿青", "大肥鱼，我现在有点难受，就陪我说两句，暂时不想听建议"]] },
  { id: "new-game-invite", mode: "direct", rows: [
    ["user", "灰灰", "八点打两局，差一个人"],
    ["user", "阿青", "大肥鱼你能上线一起玩吗？"]] },
  { id: "new-code-help", mode: "direct", rows: [
    ["user", "阿青", "const result = users.find(x => x.id === id); console.log(result.name);"],
    ["user", "阿青", "大肥鱼，这行报 Cannot read properties of undefined (reading 'name')，什么原因，怎么改？给能用的代码"]] },
  { id: "new-search-teaching", mode: "direct", rows: [
    ["user", "灰灰", "大肥鱼的人设是什么？"],
    ["assistant", "大肥鱼", "根据资料，大肥鱼是蓝色鲸鱼娘，有傲娇、爱吃白饭和摸鱼的设定。来源：https://github.com/K0nd1us/QQ-agent/blob/main/src/personas.js"],
    ["user", "灰灰", "这个像照着念稿。读完材料以后用平时群聊的语气说，可以保留来源。你重说一遍"]] },
];
for (const item of heldout) cases.push({ id: item.id, source: "new conversation, no repeated padding", mode: item.mode,
  context: item.rows.map(([role, senderName, text], index) => ({ role, senderName, text, messageId: `new-${index}`, timestamp: index + 1 })),
  rules: original.learning.rules });
if (casualPace) cases = cases.filter(item => item.id.startsWith("new-") ||
  [7,25,35,55,67,77].some(number => item.id === `replay-h${number}`));

function buildArms(item) {
  const base = item.mode === "direct"
    ? service.buildDeepSeekMessages({ messages: [] }, { role: "user", content: item.context.at(-1).text }, item.context)
    : service.buildDeepSeekAmbientMessages(item.context, item.mode);
  const current = service.withGroupReplyGuidance(base, service.deepseek, 1, item.rules);
  if (freeChat || casualPace) {
    const A = frozenBaseline.cases.find(row => row.id === item.id).arms[casualPace ? "B" : "A"];
    assert.deepEqual(conversation(A), conversation(current));
    return { A, B: current };
  }
  const A = current;
  const prefix = [config.deepseekSystemPrompt, config.responseNeutralityPrompt, DEFAULT_GROUP_CONTEXT_PROMPT,
    ...(compact ? [factualBoundary] : []),
    item.mode === "direct" ? DEFAULT_DIRECT_GROUP_CONTEXT_PROMPT : DEFAULT_AMBIENT_INSTANT_CONTEXT_PROMPT]
    .filter(part => String(part || "").trim()).join("\n\n");
  const learned = buildLearnedGroupStylePrompt(item.rules);
  // Use the exact conversation seen by A, including its budget trimming.
  const B = [{ role: "system", content: prefix }, ...conversation(A),
    ...(learned ? [{ role: "system", content: learned }] : [])];
  assert.deepEqual(conversation(A), conversation(B));
  assert.ok(A[0].content.includes(config.deepseekSystemPrompt) && B[0].content.includes(config.deepseekSystemPrompt));
  assert.equal(A.at(-1).content.includes(learned), true);
  return { A, B };
}

async function main() {
  assert.ok(config.deepseekApiKey && !config.deepseekThinkingEnabled);
  assert.ok(!fs.existsSync(path.join(output, "results.json")), "Preserve previous experiments");
  fs.mkdirSync(output, { recursive: true });
  const experiment = { startedAt: new Date().toISOString(), source, sourceHash: hash(original),
    model: config.deepseekModel, thinking: false, temperature: config.deepseekTemperature, maxOutputTokens: 1600,
    rounds: 2, variants: { A: casualPace ? "archived casual persona with restrictions removed" : freeChat ? "archived full production prompt before user clarified playful-nonsense preference" : "full current production generation prompt", B: casualPace
      ? "same casual persona with an informal, lazy-typing preference; no new expression restrictions or factual checks"
      : freeChat
      ? "current casual whale persona; no duplicate persona or built-in expression/factual catalogues; same learned rule content"
      : compact
      ? "same persona, group context, task and learned rules; compact factual boundary replaces expression restrictions and duplicate persona"
      : "same persona, group context, task and learned rules; omit supplementary expression restrictions and duplicate persona" },
    method: "Compare raw generated replies; no participation/review filtering, tools, QQ or learning writes. Alternating request order; random X/Y labels for a single Codex review, not human ratings or statistical proof.",
    attributionLimit: casualPace ? "Only the persona's typing-style paragraph changes; evaluate liveliness, not joke truthfulness or shortness alone."
      : freeChat ? "Persona wording and prompt layers changed together after user steering; this comparison cannot isolate the cause to one built-in restriction. Evaluate liveliness, not truthfulness of casual jokes." : "Tests one bundle of supplementary restrictions, not each rule separately.",
    cases: cases.map(item => { const arms = buildArms(item); return { ...item, arms, conversationHash: hash(conversation(arms.A)),
      promptChars: Object.fromEntries(Object.entries(arms).map(([key, messages]) => [key, messages.filter(x => x.role === "system").reduce((n,x)=>n+x.content.length,0)])) }; }),
    results: [], blindMapping: [] };
  const save = () => fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(experiment, null, 2) + "\n");
  save();
  for (let round = 1; round <= experiment.rounds; round++) {
    for (const [index, item] of experiment.cases.entries()) {
      for (const variant of (round + index) % 2 ? ["A", "B"] : ["B", "A"]) {
        const row = { caseId: item.id, round, variant, conversationHash: item.conversationHash };
        const started = Date.now();
        try {
          const body = service.deepseek.buildCompletionBody(item.arms[variant], false, { maxOutputTokens: experiment.maxOutputTokens, temperature: experiment.temperature });
          const payload = await service.deepseek.requestCompletion(body, { timeoutMs: 60000 });
          row.reply = String(payload.choices?.[0]?.message?.content || "").trim();
          row.finishReason = payload.choices?.[0]?.finish_reason;
          row.usage = payload.usage;
          assert.ok(row.reply, "Empty reply");
        } catch (error) { row.error = String(error.message || error).split(config.deepseekApiKey).join("[REDACTED]"); }
        row.elapsedMs = Date.now() - started;
        experiment.results.push(row); save();
        console.log(JSON.stringify({ completed: experiment.results.length, planned: experiment.cases.length * 4, caseId: item.id, round, variant, error: row.error }));
      }
    }
  }
  const reviews = [];
  for (let round = 1; round <= experiment.rounds; round++) for (const item of experiment.cases) {
    const pair = experiment.results.filter(row => row.caseId === item.id && row.round === round);
    if (pair.some(row => row.error)) continue;
    const order = randomInt(2) ? ["A", "B"] : ["B", "A"];
    const reviewId = `pair-${reviews.length + 1}`;
    reviews.push({ reviewId, caseId: item.id, round, context: item.context.slice(-8).map(({role,senderName,text})=>({role,senderName,text})),
      replies: Object.fromEntries(["X", "Y"].map((slot,i)=>[slot,pair.find(row=>row.variant===order[i]).reply])) });
    experiment.blindMapping.push({ reviewId, X: order[0], Y: order[1] });
  }
  fs.writeFileSync(path.join(output,"blind-review.json"), JSON.stringify({ rubric: "NPC感0自然具体，1轻微不合场合或多余，2明显旁白/复述/硬凑段子/客服，3严重模板，4机械。短和俏皮不自动更好；认真问题须完整、事实须有根据。另记切题0-2和具体事实/能力/格式问题。", reviews },null,2)+"\n");
  experiment.finishedAt = new Date().toISOString(); save();
  service.stop();
  if (experiment.results.some(row=>row.error || row.finishReason === "length")) process.exitCode = 1;
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
