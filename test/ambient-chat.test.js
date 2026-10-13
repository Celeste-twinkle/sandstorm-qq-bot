const assert = require("node:assert/strict");
const test = require("node:test");
const { AmbientReplyGuard, getAmbientRecipientHint, parseAmbientDecision } = require("../src/ambient-chat");

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

test("recipient hints preserve who an @ message addresses without deciding whether to reply", () => {
  const message = (qq) => ({ self_id: 123, message: [{ type: "at", data: { qq } }] });
  assert.equal(getAmbientRecipientHint(message(123)), "艾特了 bot");
  assert.equal(getAmbientRecipientHint(message(456)), "艾特其他群成员");
  assert.equal(getAmbientRecipientHint(message("all")), "艾特全体群成员");
  assert.equal(getAmbientRecipientHint({ self_id: 123, raw_message: "[CQ:at,qq=456] hello" }), "艾特其他群成员");
  assert.equal(getAmbientRecipientHint({ self_id: 123, message: "hello" }), "");
});
