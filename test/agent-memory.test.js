const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { AgentMemory, createMemoryTools } = require("../src/agent-memory");
const { MessageArchive, createEmbeddingEncoder } = require("../src/message-archive");
const { GroupConversationContext } = require("../src/group-context");
const { scoreImportance, halfLifeDays, memoryStrength, selectTraits, timeOfDayMood, formatMoodHint } = require("../src/memory-policy");

const quiet = { error() {}, warn() {}, info() {} };
function fixture(t, overrides = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-memory-test-"));
  const resolved = fs.realpathSync(directory), resources = [];
  const config = { memoryStateDir: directory, memoryRotationCooldownHours: 0, memoryRotationTokenLimit: 100, ...overrides };
  const open = () => { const memory = new AgentMemory(config, { logger: quiet, ...options }); resources.push(memory); return memory; };
  const memory = open();
  t.after(async () => {
    for (const resource of resources) await resource.close();
    assert.equal(fs.realpathSync(directory), resolved);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("sandstorm-memory-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, memory, open };
}
const entry = (i, text = `聊天${i}`) => ({ messageId: `m${i}`, userId: "11", role: "user", senderName: "小甲", text, timestamp: i + 1 });

test("recent memory survives restart, keeps group boundaries and archives messages outside the ring", async t => {
  const { memory, open } = fixture(t);
  const context = new GroupConversationContext({ memory });
  for (let i = 0; i < 130; i++) context.append("1001", entry(i, i === 0 ? "约定周五吃火锅" : `聊天${i}`));
  context.append("1002", entry(999, "另一个群的秘密"));
  const restored = open();
  assert.equal(restored.recent("group:1001").length, 100);
  assert.equal(restored.recent("group:1001")[0].messageId, "m30");
  assert.equal(restored.recent("group:1002").length, 1);
  const hits = await restored.search("group:1001", "火锅");
  assert.equal(hits[0].text, "约定周五吃火锅");
  assert.deepEqual(await restored.search("group:1001", "另一个群的秘密"), []);
  assert.deepEqual(await restored.search("group:1002", "火锅"), []);
});

test("message enrichment and bot echoes update one archive row without changing chronology", async t => {
  const { memory } = fixture(t);
  memory.record("group:1", entry(1, "原文"));
  memory.record("group:1", { ...entry(1, "原文和引用内容"), timestamp: 999 });
  assert.equal(memory.recent("group:1").length, 1);
  assert.equal(memory.recent("group:1")[0].timestamp, 2);
  assert.equal(memory.archive.db.prepare("SELECT count(*) n FROM messages").get().n, 1);
  assert.equal((await memory.search("group:1", "引用内容"))[0].text, "原文和引用内容");
});

test("rotation uses latest input usage, retires only at next entry and preserves social memory and diary", async t => {
  const { memory, open } = fixture(t);
  memory.record("group:1", entry(1, "记住周五的约定"));
  memory.writeDiary("group:1", "约定", "今天他又提起了周五吃火锅，我有点期待。");
  let lease = memory.beginTurn("group:1");
  const original = lease.id;
  memory.recordUsage(lease, { prompt_tokens: 120 });
  memory.finishTurn(lease);
  assert.equal(memory.status("group:1").stage, "notified");
  lease = memory.beginTurn("group:1");
  assert.equal(lease.id, original);
  assert.match(await memory.buildPrompt(lease, "你好"), /窗口交接.*不用道别/u);
  memory.recordUsage(lease, { prompt_tokens: 10 });
  memory.finishTurn(lease);
  assert.equal(memory.status("group:1").stage, "pending");
  assert.equal(memory.status("group:1").lastInputTokens, 10);
  const restored = open();
  const next = restored.beginTurn("group:1");
  assert.notEqual(next.id, original);
  assert.equal(next.bootstrap, true);
  assert.match(await restored.buildPrompt(next), /火锅/);
  assert.equal(restored.recent("group:1").length, 1);
  assert.equal(fs.existsSync(path.join(restored.directory, "diary", "group-1")), true);
});

test("private memory does not auto rotate; manual rotation retains archives", async t => {
  const { memory } = fixture(t);
  const lease = memory.beginTurn("private:11");
  memory.recordUsage(lease, { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 50 });
  memory.finishTurn(lease);
  assert.equal(memory.status("private:11").stage, "active");
  memory.record("private:11", entry(1, "私聊记忆"));
  memory.requestRotation("private:11");
  assert.notEqual(memory.beginTurn("private:11").id, lease.id);
  assert.equal(memory.recent("private:11").length, 1);
});

test("stateless rotation shrinks the actual working window while retaining the durable 100-message ring", t => {
  const { memory } = fixture(t);
  for (let i = 0; i < 120; i++) memory.record("group:1", entry(i));
  let lease = memory.beginTurn("group:1");
  assert.equal(memory.contextForTurn(lease).length, 100);
  memory.finishTurn(lease);
  memory.requestRotation("group:1");
  lease = memory.beginTurn("group:1");
  assert.equal(memory.contextForTurn(lease).length, 20);
  assert.equal(memory.recent("group:1").length, 100);
  memory.record("group:1", entry(121));
  assert.equal(memory.contextForTurn(lease).length, 21);
});

test("declining ambient participation does not consume a pending handoff or bootstrap", async t => {
  const { memory } = fixture(t);
  let lease = memory.beginTurn("group:1");
  memory.finishTurn(lease, false);
  lease = memory.beginTurn("group:1");
  assert.equal(lease.bootstrap, true);
  memory.recordUsage(lease, { prompt_tokens: 120 }); memory.finishTurn(lease);
  lease = memory.beginTurn("group:1");
  memory.finishTurn(lease, false);
  assert.equal(memory.status("group:1").stage, "notified");
  lease = memory.beginTurn("group:1");
  assert.match(await memory.buildPrompt(lease), /窗口交接/);
});

test("corrupted state is read only and never overwritten by a new conversation", async t => {
  const { directory, open } = fixture(t);
  fs.writeFileSync(path.join(directory, "sessions.json"), "broken-session-state");
  fs.writeFileSync(path.join(directory, "social-v2.json"), '{"schemaVersion":2,"conversations":{"group:1":{}}}');
  const restored = open();
  assert.equal(restored.status("group:1").readOnly, true);
  restored.record("group:1", entry(1));
  restored.beginTurn("group:1");
  assert.equal(fs.readFileSync(path.join(directory, "sessions.json"), "utf8"), "broken-session-state");
  assert.equal(fs.readFileSync(path.join(directory, "social-v2.json"), "utf8"), '{"schemaVersion":2,"conversations":{"group:1":{}}}');
});

test("memory tools are scoped, require human evidence and reject retired or reset leases", async t => {
  const { memory } = fixture(t);
  memory.record("group:1", entry(1, "我喜欢白饭"));
  memory.record("group:2", entry(2, "另一群"));
  const lease = memory.beginTurn("group:1"), tools = createMemoryTools(memory, lease);
  const call = (name, args) => tools.runToolCall({ function: { name, arguments: JSON.stringify(args) } });
  assert.ok((await call("search_history", { query: "另一群", key: "group:2" })).error);
  assert.ok((await call("remember_context", { brief: "无依据的事", evidence: ["unknown"] })).error);
  assert.equal((await call("remember_context", { brief: "他喜欢白饭", evidence: ["m1"] })).saved, true);
  assert.ok((await call("remember_context", { impression: { userId: "12", traits: ["不喜欢白饭"] }, evidence: ["m1"] })).error);
  const diary = await call("write_diary", { title: "../../越界", body: "他说起白饭，我也想吃了。" });
  assert.equal(diary.saved, true);
  memory.clearRecent("group:1");
  assert.ok((await call("write_diary", { title: "旧请求", body: "不应写入" })).error);
  assert.equal((await memory.search("group:1", "喜欢白饭"))[0].text, "我喜欢白饭");
});

test("topics and thoughts expire independently and only relevant profiles enter the prompt", async t => {
  let now = 1000;
  const { memory } = fixture(t, {}, { now: () => now });
  memory.record("group:1", entry(1, "记住我喜欢白饭"));
  memory.remember("group:1", { topics: ["周五火锅"], thought: "想问一下辣度", evidence: ["m1"], impression: { userId: "11", traits: ["喜欢白饭"] } });
  memory.conversation("group:1").memberImpressions["999"] = ["未出现的人"];
  now += 31 * 60000;
  let lease = memory.beginTurn("group:1");
  let prompt = await memory.buildPrompt(lease);
  assert.match(prompt, /已搁置/); assert.match(prompt, /辣度/); assert.match(prompt, /喜欢白饭/);
  assert.doesNotMatch(prompt, /未出现的人/);
  memory.finishTurn(lease);
  now += 2 * 3600000;
  lease = memory.beginTurn("group:1");
  assert.doesNotMatch(await memory.buildPrompt(lease), /辣度/);
});

test("hybrid search finds paraphrases, short Chinese words and handles embedding failure", async t => {
  let fail = false;
  const encode = async texts => {
    if (fail) throw new Error("offline");
    return texts.map(text => /争执|不对劲/u.test(text) ? [1, 0] : [0, 1]);
  };
  const { memory } = fixture(t, {}, { encode });
  memory.record("group:1", entry(1, "我们是不是有点不对劲"));
  memory.record("group:1", entry(2, "已经烧了11亿token"));
  memory.record("group:2", entry(3, "另一个群的争执"));
  await memory.archive.indexBatch();
  const semantic = await memory.search("group:1", "那次争执");
  assert.equal(semantic[0].text, "我们是不是有点不对劲");
  assert.equal((await memory.search("group:1", "烧了"))[0].text, "已经烧了11亿token");
  fail = true;
  assert.equal((await memory.search("group:1", "token"))[0].text, "已经烧了11亿token");
  assert.deepEqual(await memory.search("group:1", '" OR * --'), []);
});

test("embedding transport prefixes queries only and validates model vectors", async () => {
  const inputs = [];
  const encode = createEmbeddingEncoder({ memoryEmbeddingUrl: "http://127.0.0.1:8766/v1/embeddings" }, async (_url, options) => {
    inputs.push(JSON.parse(options.body).input);
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [3, 4] }] }) };
  });
  await encode(["原文"]); await encode(["换个说法"], { query: true });
  assert.deepEqual(inputs[0], ["原文"]);
  assert.match(inputs[1][0], /^为这个句子生成表示以用于检索相关文章：/);
  assert.throws(() => createEmbeddingEncoder({ memoryEmbeddingUrl: "file:///secret" }));
});

test("faded records remain searchable and recalls reinforce without changing relevance ranking", async t => {
  let now = 200 * 86400000;
  const { memory } = fixture(t, {}, { now: () => now });
  memory.record("group:1", entry(1, "普通聊天青菜"));
  memory.record("group:1", entry(2, "记住，周五约定去吃火锅"));
  memory.archive.decayTick();
  assert.equal(memory.archive.db.prepare("SELECT faded FROM messages WHERE message_id='m1'").get().faded, 1);
  const first = await memory.search("group:1", "青菜");
  assert.equal(first.length, 1);
  const recalled = memory.archive.db.prepare("SELECT faded,recalls FROM messages WHERE message_id='m1'").get();
  assert.equal(recalled.faded, 0); assert.equal(recalled.recalls, 1);
  await memory.search("group:1", "青菜");
  assert.equal(memory.archive.db.prepare("SELECT recalls FROM messages WHERE message_id='m1'").get().recalls, 1);
  now += 3600001;
  await memory.search("group:1", "青菜");
  assert.equal(memory.archive.db.prepare("SELECT recalls FROM messages WHERE message_id='m1'").get().recalls, 2);
});

test("importance preserves promises and demotes low value impressions into searchable events", async t => {
  assert.ok(scoreImportance({ text: "记住，约定明天见" }) > scoreImportance({ text: "哈哈哈哈" }));
  assert.ok(halfLifeDays(0.9) > halfLifeDays(0.2));
  assert.equal(memoryStrength({ importance: 0.2, ts: 0 }, 100 * 86400000).faded, 1);
  const selected = selectTraits(["他答应每周五陪我聊天", ...Array.from({ length: 12 }, (_, i) => `他刚才安装了工具${i}`)], 12);
  assert.ok(selected.kept.includes("他答应每周五陪我聊天"));
  assert.equal(selected.demoted.length, 1);
  const { memory } = fixture(t);
  memory.record("group:1", entry(1));
  memory.remember("group:1", { evidence: ["m1"], impression: { userId: "11", traits: ["他答应每周五陪我聊天", ...Array.from({ length: 14 }, (_, i) => `他刚才安装了工具${i}`)] } });
  assert.equal(memory.conversation("group:1").memberImpressions["11"].length, 12);
  assert.equal(memory.archive.db.prepare("SELECT count(*) n FROM memory_events").get().n, 3);
  assert.ok((await memory.search("group:1", "安装了工具")).some(hit => hit.type === "archived_impression"));
});

test("mood uses the configured timezone and does not turn into a hard participation gate", () => {
  const date = new Date("2026-10-27T18:00:00Z");
  assert.equal(timeOfDayMood(date, "Asia/Shanghai").slot, "凌晨");
  assert.equal(timeOfDayMood(date, "UTC").slot, "傍晚");
  assert.match(formatMoodHint(date.getTime(), "Asia/Shanghai", true), /机会可以不用/);
  assert.doesNotMatch(formatMoodHint(date.getTime(), "Asia/Shanghai", false), /机会可以不用/);
});

for (const automaticWeb of [false, true]) {
  test(`real provider memory tools complete across multiple rounds with automatic web=${automaticWeb}`, async t => {
    const { memory } = fixture(t);
    memory.record("group:1", entry(1, "我们约定周五吃火锅"));
    const lease = memory.beginTurn("group:1"), bodies = [];
    const { DeepSeekChatService } = require("../src/deepseek");
    const provider = new DeepSeekChatService({ deepseekApiKey: "fake", deepseekBaseUrl: "http://model.invalid",
      deepseekTimeoutMs: 1000, deepseekMaxOutputTokens: 500, deepseekTemperature: 0,
      webSearchAutoEnabled: automaticWeb, webSearchDiagnosticsEnabled: false, webSearchMaxToolRounds: 4,
      webSearchMaxToolCallsPerRound: 3 }, {
      logger: quiet,
      webToolRunnerFactory: () => ({ setUserQuery() {}, getToolDefinitions: () => [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
        runToolCall() { throw new Error("No web request should be needed for a memory question"); } }),
      fetch: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        const calls = [
          { id: "search-1", type: "function", function: { name: "search_history", arguments: '{"query":"火锅"}' } },
          { id: "diary-1", type: "function", function: { name: "write_diary", arguments: '{"title":"周五约定","body":"今天又说起周五吃火锅，我挺期待。"}' } },
        ];
        return { ok: true, json: async () => ({ usage: { prompt_tokens: bodies.length * 10 }, choices: [{ message:
          bodies.length <= 2 ? { role: "assistant", content: null, tool_calls: [calls[bodies.length - 1]] }
            : { role: "assistant", content: "记得，约了周五吃火锅。" } }] }) };
      },
    });
    const reply = await provider.createCompletion([{ role: "system", content: "角色卡" }, { role: "user", content: "还记得火锅吗" }], {
      memoryTools: createMemoryTools(memory, lease), onUsage: usage => memory.recordUsage(lease, usage),
    });
    assert.equal(reply, "记得，约了周五吃火锅。");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].tools.some(tool => tool.function.name === "search_history"), true);
    assert.equal(bodies[0].tools.some(tool => tool.function.name === "web_search"), automaticWeb);
    assert.equal(bodies[2].messages.filter(message => message.role === "tool").length, 2);
    assert.equal(lease.inputTokens, 30);
    assert.match(memory.readDiaryPreview("group:1"), /周五吃火锅/);
  });
}
