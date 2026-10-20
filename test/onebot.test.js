const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOneBotClient,
  OneBotActionError,
  splitTextMessage,
} = require("../src/onebot");

test("OneBotActionError preserves the complete action response for diagnostics", () => {
  const payload = {
    status: "failed",
    retcode: 1200,
    data: null,
    message: "EventChecker Failed: rich media transfer failed",
    wording: "complete wording that must not be truncated",
    echo: "send_group_msg-test",
  };

  const error = new OneBotActionError("send_group_msg", payload, 4321);

  assert.equal(error.name, "OneBotActionError");
  assert.equal(error.action, "send_group_msg");
  assert.equal(error.retcode, 1200);
  assert.equal(error.durationMs, 4321);
  assert.equal(error.response, payload);
  assert.match(error.message, /rich media transfer failed/);
});

test("OneBot client resolves a quoted message through get_msg", async () => {
  const sent = [];
  const pendingActions = new Map();
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const client = createOneBotClient(ws, pendingActions);

  const resultPromise = client.getMessage("quoted-42");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "get_msg");
  assert.deepEqual(sent[0].params, { message_id: "quoted-42" });

  const pending = pendingActions.get(sent[0].echo);
  clearTimeout(pending.timeout);
  pendingActions.delete(sent[0].echo);
  pending.resolve({
    status: "ok",
    retcode: 0,
    data: {
      message_id: "quoted-42",
      message: [{ type: "image", data: { url: "https://img.example/quoted.png" } }],
    },
  });

  assert.deepEqual(await resultPromise, {
    message_id: "quoted-42",
    message: [{ type: "image", data: { url: "https://img.example/quoted.png" } }],
  });
});

test("OneBot client resolves merged chat records through get_forward_msg", async () => {
  const sent = [];
  const pendingActions = new Map();
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const client = createOneBotClient(ws, pendingActions);

  const resultPromise = client.getForwardMessage("forward-42");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "get_forward_msg");
  assert.deepEqual(sent[0].params, {
    id: "forward-42",
    message_id: "forward-42",
  });

  const pending = pendingActions.get(sent[0].echo);
  clearTimeout(pending.timeout);
  pendingActions.delete(sent[0].echo);
  pending.resolve({
    status: "ok",
    retcode: 0,
    data: {
      messages: [
        {
          sender: { nickname: "Alice" },
          message: [{ type: "text", data: { text: "hello" } }],
        },
      ],
    },
  });

  assert.deepEqual(await resultPromise, {
    messages: [
      {
        sender: { nickname: "Alice" },
        message: [{ type: "text", data: { text: "hello" } }],
      },
    ],
  });
});

test("long text messages split on sentence boundaries without changing order", () => {
  assert.deepEqual(splitTextMessage("第一段。第二段。第三段。", 6), [
    "第一段。",
    "第二段。",
    "第三段。",
  ]);
});

test("OneBot client waits for each long-text chunk and serializes later group messages", async () => {
  const sent = [];
  const recorded = [];
  const pendingActions = new Map();
  let activeActions = 0;
  let maxActiveActions = 0;
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload) {
      const parsed = JSON.parse(payload);
      sent.push(parsed);
      activeActions += 1;
      maxActiveActions = Math.max(maxActiveActions, activeActions);
      setImmediate(() => {
        const pending = pendingActions.get(parsed.echo);
        clearTimeout(pending.timeout);
        pendingActions.delete(parsed.echo);
        activeActions -= 1;
        pending.resolve({ status: "ok", retcode: 0, data: { message_id: sent.length } });
      });
    },
  };
  const client = createOneBotClient(ws, pendingActions, {
    textChunkMaxChars: 6,
    logger: { log() {} },
    onGroupMessageSent(groupId, message, response, metadata) {
      recorded.push({ groupId, message, messageId: response.data.message_id, metadata });
    },
  });

  const longReply = client.sendGroupMessage("group-1", "第一段。第二段。第三段。", { replyToUserId: "alice" });
  const laterReply = client.sendGroupMessage("group-1", "最后一条", { replyToUserId: "bob" });
  await Promise.all([longReply, laterReply]);

  assert.equal(maxActiveActions, 1);
  assert.deepEqual(
    sent.map((entry) => entry.params.message),
    ["第一段。", "第二段。", "第三段。", "最后一条"],
  );
  assert.deepEqual(recorded.map((entry) => entry.message), ["第一段。", "第二段。", "第三段。", "最后一条"]);
  assert.deepEqual(recorded.map((entry) => entry.messageId), [1, 2, 3, 4]);
  assert.equal(recorded.every((entry) => entry.groupId === "group-1"), true);
  assert.deepEqual(recorded.map(entry => entry.metadata.replyToUserId), ["alice", "alice", "alice", "bob"]);
  assert.equal(sent.every(entry => Object.keys(entry.params).sort().join(",") === "group_id,message"), true);
});

test("an ignored recipient stops remaining chunks and queued replies before sending", async () => {
  const sent = [], pending = new Map();
  let allowed = true;
  const client = createOneBotClient({ OPEN: 1, readyState: 1, send(raw) {
    const action = JSON.parse(raw); sent.push(action);
    queueMicrotask(() => {
      const request = pending.get(action.echo);
      clearTimeout(request.timeout); pending.delete(action.echo);
      request.resolve({ status: "ok", retcode: 0 });
    });
  } }, pending, { textChunkMaxChars: 6, logger: { log() {} }, onGroupMessageSent() { allowed = false; } });
  const metadata = { canSend: () => allowed };
  await Promise.all([client.sendGroupMessage("group", "第一段。第二段。第三段。", metadata),
    client.sendGroupMessage("group", "queued", metadata)]);
  assert.deepEqual(sent.map(action => action.params.message), ["第一段。"]);
});

test("OneBot client stops a long reply when a chunk fails", async () => {
  const sent = [];
  const recorded = [];
  const pendingActions = new Map();
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload) {
      const parsed = JSON.parse(payload);
      sent.push(parsed);
      setImmediate(() => {
        const pending = pendingActions.get(parsed.echo);
        clearTimeout(pending.timeout);
        pendingActions.delete(parsed.echo);
        if (sent.length === 2) {
          pending.reject(
            new OneBotActionError(
              "send_group_msg",
              {
                status: "failed",
                retcode: 1200,
                message: "Timeout",
              },
              100,
            ),
          );
          return;
        }
        pending.resolve({ status: "ok", retcode: 0 });
      });
    },
  };
  const client = createOneBotClient(ws, pendingActions, {
    textChunkMaxChars: 6,
    logger: { log() {} },
    onGroupMessageSent(_groupId, message) { recorded.push(message); },
  });

  await assert.rejects(
    client.sendGroupMessage("group-1", "第一段。第二段。第三段。"),
    (error) => {
      assert.equal(error.chunkIndex, 1);
      assert.equal(error.chunkCount, 3);
      assert.equal(error.deliveredChunks, 1);
      return true;
    },
  );
  assert.deepEqual(
    sent.map((entry) => entry.params.message),
    ["第一段。", "第二段。"],
  );
  assert.deepEqual(recorded, ["第一段。"]);
});
