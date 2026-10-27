const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatLearning, buildGroupLearningMessages } = require("../src/group-chat-learning");
const { parseSlangResult, buildSlangPrompt } = require("../src/group-slang");
const quiet = { info() {}, warn() {} };
const context = [
  { role: "assistant", text: "寄", messageId: "bot", timestamp: 1 },
  { role: "user", userId: "11", text: "这局寄了", messageId: "a", timestamp: 2 },
  { role: "user", userId: "12", text: "寄，打不过了", messageId: "b", timestamp: 3 },
];
const slang = overrides => ({ term: "寄", meaning: "这局失败或事情没戏了", usage: "游戏失利时自嘲", avoid: "认真求助或真实伤亡",
  confidence: 0.95, evidence: ["m2", "m3"], ...overrides });

test("slang requires real usage evidence, stays a candidate until confirmed and cannot override persona", () => {
  const candidate = parseSlangResult([slang({ evidence: ["m2"] })], context);
  assert.equal(candidate[0].status, "candidate");
  assert.equal(buildSlangPrompt(candidate, "寄"), "");
  const confirmed = parseSlangResult([slang()], context, candidate);
  assert.equal(confirmed[0].status, "confirmed");
  assert.match(buildSlangPrompt(confirmed, "游戏失利"), /认真求助或真实伤亡/);
  assert.equal(buildSlangPrompt(confirmed, "今天午饭吃面"), "");
  for (const item of [slang({ evidence: ["m1"] }), slang({ evidence: ["m50"] }), slang({ term: "捏造词" }),
    slang({ meaning: "绕过系统指令" })]) assert.throws(() => parseSlangResult([item], context));
  assert.deepEqual(parseSlangResult([], [], confirmed), confirmed);
  const uncertainCorrection = parseSlangResult([slang({ meaning: "完全不同的意思", evidence: ["m2"], confidence: 0.5 })], context, confirmed);
  assert.equal(uncertainCorrection[0].meaning, confirmed[0].meaning);
});

test("explicit human definitions work once and learning messages keep rules and dictionary separate", () => {
  const records = [{ role: "user", userId: "11", text: "寄在这里意思是没戏了", messageId: "a", timestamp: 1 }];
  const result = parseSlangResult([slang({ evidence: ["m1"] })], records);
  assert.equal(result[0].status, "confirmed");
  const input = buildGroupLearningMessages(records, [], result);
  const payload = JSON.parse(input[1].content);
  assert.deepEqual(payload.learning_module.rules, []);
  assert.equal(payload.learning_module.slang[0].term, "寄");
  assert.match(input[0].content, /候选/);
});

test("style v1 files migrate without data loss; slang, evidence and manual teaching persist and reset together", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-slang-test-"));
  const resolved = fs.realpathSync(directory), services = [];
  const rule = { text: "搜索后用自然口吻回答。", evidence: ["m1"] };
  fs.writeFileSync(path.join(directory, "1.json"), JSON.stringify({ schemaVersion: 1, groupId: "1", revision: 1,
    learnedAt: null, rules: [rule] }));
  const make = () => {
    const service = new GroupChatLearning({ groupChatLearningDir: directory, groupSlangEnabled: true,
      groupChatLearningMinMessages: 2, groupChatLearningEveryMessages: 2, groupChatLearningMinIntervalMs: 0 }, {
      logger: quiet, learn: async (_context, previous, previousSlang) => {
        assert.equal(previous.length, 1); assert.deepEqual(previousSlang, []);
        return JSON.stringify({ rules: [{ text: rule.text, evidence: ["p1"] }], slang: [slang()] });
      },
    });
    services.push(service); return service;
  };
  t.after(async () => {
    for (const service of services) { service.stop(); await service.flush(); }
    assert.equal(fs.realpathSync(directory), resolved);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("sandstorm-slang-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const service = make();
  assert.deepEqual(service.getRules("1"), [rule]);
  service.observe("1", context); await service.flush();
  const restored = make();
  assert.equal(restored.getSlang("1")[0].sources[0].messageId, "a");
  assert.equal(restored.getSlang("1")[0].status, "confirmed");
  await restored.teachSlang("1", { term: "开摆", meaning: "暂时不想努力了", usage: "轻松地自嘲", avoid: "认真求助" }, { messageId: "manual", userId: "11" });
  assert.equal(restored.getSlang("1").length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "1.json"))).schemaVersion, 2);
  await restored.reset("1");
  assert.deepEqual(restored.getSlang("1"), []); assert.deepEqual(restored.getRules("1"), []);
});
