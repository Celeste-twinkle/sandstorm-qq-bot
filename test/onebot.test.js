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
  });

  const longReply = client.sendGroupMessage("group-1", "第一段。第二段。第三段。");
  const laterReply = client.sendGroupMessage("group-1", "最后一条");
  await Promise.all([longReply, laterReply]);

  assert.equal(maxActiveActions, 1);
  assert.deepEqual(
    sent.map((entry) => entry.params.message),
    ["第一段。", "第二段。", "第三段。", "最后一条"],
  );
});

test("OneBot client stops a long reply when a chunk fails", async () => {
  const sent = [];
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
});
