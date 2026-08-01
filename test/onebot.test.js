const assert = require("node:assert/strict");
const test = require("node:test");

const { OneBotActionError } = require("../src/onebot");

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
