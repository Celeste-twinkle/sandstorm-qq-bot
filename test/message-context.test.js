const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GroupMessageCache,
  getReplyMessageId,
} = require("../src/message-context");

function createConfig() {
  return {
    ambientChatContextSeconds: 7200,
    chatSessionTtlMinutes: 120,
    localQwenMaxHistoryMessages: 100,
    ambientChatInstantMaxMessages: 100,
    ambientChatIdleMaxMessages: 100,
  };
}

test("quoted image is recovered from the group message cache", async () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 1000 });
  const imageUrl = "https://img.example/original.png";
  cache.add({
    group_id: "100",
    message_id: "image-1",
    user_id: "200",
    sender: { card: "Alice" },
    message: [{ type: "image", data: { url: imageUrl } }],
  });
  const reply = {
    group_id: "100",
    message_id: "question-2",
    message: [
      { type: "reply", data: { id: "image-1" } },
      { type: "at", data: { qq: "bot" } },
      { type: "text", data: { text: "上面这张图是什么？" } },
    ],
  };

  assert.equal(getReplyMessageId(reply), "image-1");
  assert.deepEqual(await cache.collectRelatedImages(reply, {}), [imageUrl]);
});

test("quoted image cache miss falls back to OneBot get_msg and caches the result", async () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 2000 });
  const calls = [];
  const reply = {
    group_id: "100",
    message_id: "question-3",
    message: [
      { type: "reply", data: { id: "remote-image" } },
      { type: "text", data: { text: "识别这张图" } },
    ],
  };
  const client = {
    async getMessage(messageId) {
      calls.push(messageId);
      return {
        message_id: messageId,
        user_id: "201",
        sender: { nickname: "Bob" },
        message: [
          {
            type: "image",
            data: { file: "remote.png", url: "https://img.example/remote.png" },
          },
        ],
      };
    },
  };

  const resolved = await cache.resolveRepliedMessage(reply, client);
  assert.deepEqual(calls, ["remote-image"]);
  assert.equal(resolved.senderName, "Bob");
  assert.deepEqual(resolved.images, ["https://img.example/remote.png"]);
  assert.equal(cache.get("100", "remote-image"), resolved);

  await cache.resolveRepliedMessage(reply, client);
  assert.deepEqual(calls, ["remote-image"]);
});
