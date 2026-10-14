const assert = require("node:assert/strict");
const test = require("node:test");
const {
  GroupConversationContext,
  getGroupMessageTimestamp,
  getGroupReplyMeta,
} = require("../src/group-context");

test("group history keeps the newest 50 chronological messages including bot replies", () => {
  const context = new GroupConversationContext();
  // Delayed events arrive in reverse order; retention follows event time.
  for (let index = 69; index >= 0; index -= 1) {
    context.append("group-1", {
      messageId: String(index),
      role: index % 4 === 0 ? "assistant" : "user",
      text: `message-${index}`,
      timestamp: index * 1000,
    });
  }
  const messages = context.get("group-1", 100);
  assert.equal(messages.length, 50);
  assert.deepEqual(messages.map((message) => message.messageId),
    Array.from({ length: 50 }, (_, index) => String(index + 20)));
  assert.equal(messages.filter((message) => message.role === "assistant").length, 13);
  assert.equal(context.get("group-1", 3)[0].messageId, "67");
});

test("self-message echoes and enrichment update one record without moving it", () => {
  const context = new GroupConversationContext();
  context.append("group-1", { messageId: "bot-1", role: "assistant", text: "reply", timestamp: 10 });
  context.append("group-1", { messageId: "user-2", role: "user", text: "next", timestamp: 20 });
  context.append("group-1", {
    messageId: "bot-1", role: "assistant", text: "reply", timestamp: 30, senderName: "Bot",
  });
  const messages = context.get("group-1");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].messageId, "bot-1");
  assert.equal(messages[0].timestamp, 10);
  assert.equal(messages[0].senderName, "Bot");
});

test("old messages remain until count trimming or an explicit group reset", () => {
  const context = new GroupConversationContext();
  context.append("group-1", { messageId: "old", role: "user", timestamp: 1 });
  context.append("group-1", { messageId: "new", role: "user", timestamp: Date.now() });
  context.append("group-2", { messageId: "other", role: "user", timestamp: 1 });
  assert.equal(context.get("group-1").length, 2);
  context.clear("group-1");
  assert.deepEqual(context.get("group-1"), []);
  assert.equal(context.get("group-2").length, 1);
});

test("messages with the same timestamp retain their arrival order", () => {
  const context = new GroupConversationContext();
  for (const messageId of ["a", "b", "c"]) {
    context.append("group-1", { messageId, role: "user", timestamp: 1000 });
  }
  assert.deepEqual(context.get("group-1").map((message) => message.messageId), ["a", "b", "c"]);
});

test("reply metadata follows the latest member without selecting a persona", () => {
  const context = new GroupConversationContext();
  const meta = () => getGroupReplyMeta(context.get("group-1"));

  context.append("group-1", { messageId: "a", role: "user", userId: "alice", senderName: "Alice", timestamp: 10 });
  assert.deepEqual(meta(), { senderName: "Alice" });
  context.append("group-1", { messageId: "b", role: "user", userId: "bob", senderName: "Bob", timestamp: 20 });
  context.append("group-1", { messageId: "bot", role: "assistant", text: "Enterprise reply", timestamp: 30 });
  assert.deepEqual(meta(), { senderName: "Bob" });
  context.append("group-1", { messageId: "late", role: "user", userId: "alice", senderName: "Alice", timestamp: 15 });
  assert.deepEqual(meta(), { senderName: "Bob" });
  context.append("group-1", { messageId: "c", role: "user", userId: "carol", senderName: "Carol", timestamp: 40 });
  assert.deepEqual(meta(), { senderName: "Carol" });
  assert.deepEqual(getGroupReplyMeta([]), { senderName: "" });
});

test("OneBot timestamps determine order and missing event time uses receive time", () => {
  assert.equal(getGroupMessageTimestamp({ time: 100 }, 999999), 100000);
  assert.equal(getGroupMessageTimestamp({}, 999999), 999999);
  assert.equal(getGroupMessageTimestamp({ time: "invalid" }, 999999), 999999);
});
