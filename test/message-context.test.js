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

test("face-only messages are retained as semantic group context", () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 3000 });
  const entry = cache.add({
    group_id: "100",
    message_id: "face-1",
    user_id: "202",
    sender: { nickname: "Carol" },
    message: [{ type: "face", data: { id: "76" } }],
  });

  assert.equal(entry.text, "[QQ表情：赞]");
  assert.deepEqual(entry.images, []);
  assert.equal(cache.get("100", "face-1"), entry);
});

test("market-face image keeps both visual source and readable summary", () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 4000 });
  const entry = cache.add({
    group_id: "100",
    message_id: "mface-1",
    user_id: "203",
    message: [
      {
        type: "image",
        data: {
          file: "marketface",
          summary: "[猫猫大哭]",
          url: "https://img.example/cat-cry.gif",
        },
      },
    ],
  });

  assert.equal(entry.text, "[QQ表情包：猫猫大哭]");
  assert.deepEqual(entry.images, ["https://img.example/cat-cry.gif"]);
});

test("nested merged chat records are recursively fetched and flattened for Qwen", async () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 5000 });
  const calls = [];
  const nestedImage = "https://img.example/nested.png";
  const client = {
    async getForwardMessage(forwardId) {
      calls.push(forwardId);
      if (forwardId === "root-forward") {
        return {
          messages: [
            {
              sender: { nickname: "Alice" },
              message: [{ type: "text", data: { text: "第一层开始" } }],
            },
            {
              sender: { nickname: "Bob" },
              message: [
                { type: "text", data: { text: "准备展开内层" } },
                {
                  type: "forward",
                  data: {
                    id: "inline-forward",
                    content: [
                      {
                        sender: { nickname: "Carol" },
                        message: [
                          { type: "text", data: { text: "内层图片" } },
                          { type: "image", data: { url: nestedImage } },
                        ],
                      },
                      {
                        sender: { nickname: "Dan" },
                        message: [
                          {
                            type: "forward",
                            data: { id: "deep-forward" },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              sender: { nickname: "Eve" },
              message: [{ type: "text", data: { text: "第一层结束" } }],
            },
          ],
        };
      }

      assert.equal(forwardId, "deep-forward");
      return {
        message: [
          {
            type: "node",
            data: {
              nickname: "Frank",
              content: [
                { type: "face", data: { id: "14" } },
                { type: "text", data: { text: "最深层" } },
              ],
            },
          },
        ],
      };
    },
  };
  const message = {
    group_id: "100",
    message_id: "forward-message-1",
    user_id: "204",
    sender: { nickname: "Grace" },
    message: [
      {
        type: "forward",
        data: { id: "root-forward", content: [] },
      },
    ],
  };

  const forwarded = await cache.resolveForwardedMessage(message, client);
  assert.deepEqual(calls, ["root-forward", "deep-forward"]);
  assert.deepEqual(forwarded.images, [nestedImage]);
  assert.equal(forwarded.recordCount, 5);
  assert.match(forwarded.text, /合并转发聊天记录（嵌套内容已展平）/);

  const expectedOrder = [
    "Alice：第一层开始",
    "Bob：准备展开内层",
    "Carol：内层图片 [图片×1]",
    "Frank：[QQ表情：微笑] 最深层",
    "Eve：第一层结束",
  ];
  let previousIndex = -1;
  for (const expected of expectedOrder) {
    const index = forwarded.text.indexOf(expected);
    assert.equal(index > previousIndex, true, `${expected} should keep its order`);
    previousIndex = index;
  }

  const entry = cache.add(message, "", "", { forwarded });
  assert.equal(entry.text, "");
  assert.deepEqual(entry.images, []);
  assert.equal(entry.qwenOnly, true);
  assert.equal(entry.hasForwardedContent, true);
  assert.match(entry.qwenText, /Frank：\[QQ表情：微笑\] 最深层/);
  assert.deepEqual(entry.qwenImages, [nestedImage]);
});

test("replying to a cached merged chat record reuses its Qwen-only expansion", async () => {
  const cache = new GroupMessageCache(createConfig(), { now: () => 6000 });
  const forwardedMessage = {
    group_id: "100",
    message_id: "forward-message-2",
    user_id: "205",
    sender: { nickname: "Helen" },
    message: [{ type: "forward", data: { id: "cached-forward" } }],
  };
  const forwarded = {
    text: "[合并转发聊天记录（嵌套内容已展平）]\nIvan：需要总结的内容",
    images: [],
    recordCount: 1,
    omittedCount: 0,
  };
  cache.add(forwardedMessage, "", "", { forwarded });

  const reply = {
    group_id: "100",
    message_id: "question-4",
    message: [
      { type: "reply", data: { id: "forward-message-2" } },
      { type: "text", data: { text: "总结一下" } },
    ],
  };
  const client = {
    async getMessage() {
      throw new Error("cached message must not call get_msg");
    },
    async getForwardMessage() {
      throw new Error("cached expansion must not call get_forward_msg");
    },
  };

  const resolved = await cache.resolveRepliedMessage(reply, client);
  assert.equal(resolved.qwenOnly, true);
  assert.match(resolved.qwenText, /Ivan：需要总结的内容/);
});
