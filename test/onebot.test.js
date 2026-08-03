const assert = require("node:assert/strict");
const test = require("node:test");

const { createOneBotClient, OneBotActionError } = require("../src/onebot");

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
