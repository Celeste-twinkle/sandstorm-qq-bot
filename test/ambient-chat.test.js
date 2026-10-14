const assert = require("node:assert/strict");
const test = require("node:test");
const { AmbientReplyGuard, AmbientReplyScheduler, getAmbientReplyDelay, getAmbientRecipientHint, parseAmbientDecision, parseAmbientDraftReview } = require("../src/ambient-chat");

function user(messageId, text = "hello", timestamp = 1) {
  return { messageId, role: "user", userId: "alice", text, timestamp };
}

test("ambient guard allows closing messages to reach AI judgement", () => {
  const guard = new AmbientReplyGuard();
  const ticket = guard.begin("group", [user("one", "晚安")]);
  assert.ok(ticket);
  assert.equal(guard.canSend(ticket, [user("one", "晚安")]), true);
});

test("AI can inspect a finished exchange including the bot's last reply", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one"), { role: "assistant", messageId: "bot", text: "answered", timestamp: 2 }];
  const ticket = guard.begin("group", context);
  assert.ok(ticket);
  assert.equal(guard.canSend(ticket, context), true);
});

test("only one ambient judgement or reply can run per group", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const ticket = guard.begin("group", context);
  assert.equal(guard.begin("group", context), null);
  assert.ok(guard.begin("other-group", context));
  guard.finish(ticket);
  assert.ok(guard.begin("group", context));
});

test("new member messages invalidate an old ambient decision", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const ticket = guard.begin("group", context);
  assert.equal(guard.canSend(ticket, [...context, user("two", "next", 2)]), false);
});

test("a bot reply delivered while judging invalidates the pending ambient response", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const ticket = guard.begin("group", context);
  assert.equal(guard.canSend(ticket, [...context, { role: "assistant", messageId: "bot", text: "already answered", timestamp: 2 }]), false);
});

test("ordinary conversation may advance while its draft awaits fresh judgement", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const ticket = guard.begin("group", context);
  context.push(user("two", "public conversation continues", 2));
  assert.equal(guard.canContinue(ticket, context), true);
  assert.equal(guard.canSend(ticket, context), false);
  assert.equal(guard.refresh(ticket, context), true);
  assert.equal(guard.canSend(ticket, context), true);
  context.push({ role: "assistant", messageId: "bot", text: "a direct reply", timestamp: 3 });
  assert.equal(guard.canContinue(ticket, context), false);
  assert.equal(guard.refresh(ticket, context), false);
});

test("explicit handling cancels in-flight tickets before its own reply is delivered", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const ticket = guard.begin("group", context);
  guard.cancel("group");
  assert.equal(guard.canContinue(ticket, context), false);
  assert.equal(guard.refresh(ticket, context), false);
  const next = guard.begin("group", context);
  guard.finish(ticket);
  assert.equal(guard.canContinue(next, context), true);
});

test("released tickets cannot send or release a later operation", () => {
  const guard = new AmbientReplyGuard();
  const context = [user("one")];
  const first = guard.begin("group", context);
  guard.finish(first);
  const second = guard.begin("group", context);
  guard.finish(first);
  assert.equal(guard.canSend(first, context), false);
  assert.equal(guard.canSend(second, context), true);
  assert.equal(guard.begin("group", context), null);
});

test("no member context means no ambient decision", () => {
  const guard = new AmbientReplyGuard();
  assert.equal(guard.begin("group", []), null);
  assert.equal(guard.begin("group", [{ role: "assistant", messageId: "bot", text: "hi" }]), null);
});

test("ambient decision parser accepts only a JSON boolean", () => {
  assert.equal(parseAmbientDecision('{"should_reply":true}'), true);
  assert.equal(parseAmbientDecision(' {"should_reply":false} '), false);
  for (const text of ['yes', '{"should_reply":"false"}', 'null', '[]', '{"reply":true}']) {
    assert.throws(() => parseAmbientDecision(text), /Ambient decision/);
  }
});

test("draft review preserves original replies and accepts only its action schema", () => {
  assert.equal(parseAmbientDraftReview('{"action":"send"}', "原话"), "原话");
  assert.equal(parseAmbientDraftReview('{"action":"skip"}', "原话"), null);
  for (const value of ["no", "null", "[]", '{"should_reply":true}', '{"action":"send","text":"other"}',
    '{"action":"edit","text":" "}', '{"action":"edit","text":42}', '{"action":"edit","text":"x","reason":"secret"}']) {
    assert.throws(() => parseAmbientDraftReview(value, "草稿"), /Ambient draft review/);
  }
});

test("draft edits can remove an unsolicited tail but cannot invent or reorder words", () => {
  const edit = text => JSON.stringify({ action: "edit", text });
  const draft = "敲着挺解压，就是别在半夜用。";
  assert.equal(parseAmbientDraftReview(edit("敲着挺解压。"), draft), "敲着挺解压。");
  assert.equal(parseAmbientDraftReview(edit("敲着舒服。"), draft), null);
  assert.equal(parseAmbientDraftReview(edit("解压挺敲着。"), draft), null);
  assert.equal(parseAmbientDraftReview(edit("😀挺好。"), "😀这个挺好，顺便问一句。"), "😀挺好。");
});

test("draft edits preserve numbers, sources, uncertainty and negation", () => {
  const edit = text => JSON.stringify({ action: "edit", text });
  for (const [draft, changed] of [
    ["17:30 到，别晚了。", "17:3 到。"],
    ["温度 -5 度，注意。", "温度 5 度。"],
    ["看这里 https://example.com/a ，先读。", "看这里。"],
    ["可能能找回来，再看看。", "能找回来。"],
    ["不喜欢红色，偏蓝色。", "喜欢红色。"],
  ]) assert.equal(parseAmbientDraftReview(edit(changed), draft), null);
  assert.equal(parseAmbientDraftReview(edit("可能要 20 分钟。"), "可能要 20 分钟。耐心等吧。"), "可能要 20 分钟。");
});

test("recipient hints preserve who an @ message addresses without deciding whether to reply", () => {
  const message = (qq) => ({ self_id: 123, message: [{ type: "at", data: { qq } }] });
  assert.equal(getAmbientRecipientHint(message(123)), "艾特了 bot");
  assert.equal(getAmbientRecipientHint(message(456)), "艾特其他群成员");
  assert.equal(getAmbientRecipientHint(message("all")), "艾特全体群成员");
  assert.equal(getAmbientRecipientHint({ self_id: 123, raw_message: "[CQ:at,qq=456] hello" }), "艾特其他群成员");
  assert.equal(getAmbientRecipientHint({ self_id: 123, message: "hello" }), "");
});

function schedulerFixture() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const errors = [];
  const scheduler = new AmbientReplyScheduler({ now: () => now,
    setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimer: (id) => timers.delete(id), onError: (error) => errors.push(error.message) });
  const flush = () => new Promise(setImmediate);
  const tick = async (ms) => {
    const target = now + ms;
    let turns = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++turns < 100, "Scheduler must not busy-loop");
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = target;
    await flush();
  };
  return { scheduler, tick, flush, errors, now: () => now };
}

test("ambient bursts coalesce without moving the first judgement deadline", async () => {
  const f = schedulerFixture();
  const judged = [];
  f.scheduler.schedule("g", () => judged.push("one"), 600);
  await f.tick(200);
  f.scheduler.schedule("g", () => judged.push("two"), 600);
  await f.tick(200);
  f.scheduler.schedule("g", () => judged.push("three"), 600);
  await f.tick(199);
  assert.deepEqual(judged, []);
  await f.tick(1);
  assert.deepEqual(judged, ["three"]);
  await f.tick(60000);
  assert.deepEqual(judged, ["three"], "No repeated polling after an AI decision");
});

test("sustained traffic cannot indefinitely postpone an interest judgement", async () => {
  const f = schedulerFixture();
  const judged = [];
  for (let i = 0; i < 18; i += 1) {
    f.scheduler.schedule("g", () => judged.push(i), 600);
    await f.tick(100);
  }
  assert.deepEqual(judged, [5, 11, 17]);
});

test("messages arriving during AI judgement are retained and re-evaluated with the latest anchor", async () => {
  const f = schedulerFixture();
  const guard = new AmbientReplyGuard();
  let context = [user("one")];
  const judged = [];
  const sent = [];
  let release;
  const firstDecision = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    const snapshot = [...context];
    const ticket = guard.begin("g", snapshot);
    assert.ok(ticket, "Do not start concurrent judgements in a group");
    judged.push(snapshot.at(-1).messageId);
    if (judged.length === 1) await firstDecision;
    if (guard.canSend(ticket, context)) sent.push(snapshot.at(-1).messageId);
    guard.finish(ticket);
  };
  f.scheduler.schedule("g", operation);
  await f.tick(0);
  context.push(user("two", "next", 2));
  f.scheduler.schedule("g", operation, 600);
  context.push(user("three", "latest", 3));
  f.scheduler.schedule("g", operation, 600);
  await f.tick(1000);
  assert.deepEqual(judged, ["one"]);
  release();
  await f.flush();
  await f.tick(0);
  assert.deepEqual(judged, ["one", "three"]);
  assert.deepEqual(sent, ["three"], "Discard stale output and process the newest context");
});

test("cooldown postpones a pending judgement instead of losing new messages", async () => {
  const f = schedulerFixture();
  const judged = [];
  const config = { ambientChatCooldownSeconds: 30, ambientChatDebounceMs: 600 };
  await f.tick(1000);
  f.scheduler.schedule("g", () => judged.push("first"), getAmbientReplyDelay("instant", 0, config, f.now()));
  await f.tick(19000);
  f.scheduler.schedule("g", () => judged.push("latest"), getAmbientReplyDelay("instant", 0, config, f.now()));
  await f.tick(9999);
  assert.deepEqual(judged, []);
  await f.tick(1);
  assert.deepEqual(judged, ["latest"]);
  assert.equal(getAmbientReplyDelay("instant", undefined, config, f.now()), 600);
  assert.equal(getAmbientReplyDelay("idle", undefined, config, f.now()), 0);
});

test("explicit conversation handling can cancel both waiting and queued ambient work", async () => {
  const f = schedulerFixture();
  const ran = [];
  f.scheduler.schedule("g", () => ran.push("waiting"), 600);
  f.scheduler.cancel("g");
  await f.tick(600);
  assert.deepEqual(ran, []);
  let release;
  f.scheduler.schedule("g", () => new Promise((resolve) => { release = resolve; }));
  await f.tick(0);
  f.scheduler.schedule("g", () => ran.push("queued"));
  f.scheduler.cancel("g");
  release();
  await f.flush();
  await f.tick(1000);
  assert.deepEqual(ran, []);
});

test("a failed ambient task releases its group and does not discard its queued successor", async () => {
  const f = schedulerFixture();
  let reject;
  const ran = [];
  f.scheduler.schedule("g", () => new Promise((_resolve, fail) => { reject = fail; }));
  await f.tick(0);
  f.scheduler.schedule("g", () => ran.push("latest"));
  f.scheduler.schedule("other", () => ran.push("other"));
  await f.tick(0);
  assert.deepEqual(ran, ["other"]);
  reject(new Error("provider unavailable"));
  await f.flush();
  await f.tick(0);
  assert.deepEqual(ran, ["other", "latest"]);
  assert.deepEqual(f.errors, ["provider unavailable"]);
  f.scheduler.schedule("shutdown", () => ran.push("cancelled"), 100);
  f.scheduler.clear();
  await f.tick(100);
  assert.deepEqual(ran, ["other", "latest"]);
});
