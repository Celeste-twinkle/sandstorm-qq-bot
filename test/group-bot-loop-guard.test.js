const assert = require("node:assert/strict");
const test = require("node:test");
const { GroupBotLoopGuard } = require("../src/group-bot-loop-guard");

function fixture(config = {}, options = {}) {
  let now = 1000000, id = 0;
  const guard = new GroupBotLoopGuard(config, { ...options, now: () => now });
  const incoming = (user = "90000002", group = "1001", extra = {}) => guard.inspect({
    group_id: group, user_id: user, message_id: ++id, ...extra,
  });
  return { guard, incoming, advance: ms => { now += ms; } };
}

test("unknown accounts repeatedly reacting to delivered replies are stopped before a fifth AI turn", () => {
  const { guard, incoming, advance } = fixture();
  assert.equal(incoming().allowed, true);
  for (let turn = 1; turn <= 4; turn++) {
    guard.recordReply("1001", "90000002"); advance(1000);
    const result = incoming();
    assert.equal(result.allowed, turn < 4);
    if (turn === 4) assert.equal(result.justBlocked, true);
  }
  assert.equal(guard.canRespond("1001", "90000002"), false);
  assert.equal(incoming("90000003").allowed, true);
  assert.equal(incoming("90000002", "1002").allowed, true);
});

test("multiple bots cannot reset each other's counters by alternating", () => {
  const { guard, incoming } = fixture();
  for (const user of ["90000002", "90000003"]) incoming(user);
  for (let i = 0; i < 4; i++) {
    for (const user of ["90000002", "90000003"]) {
      guard.recordReply("1001", user);
      assert.equal(incoming(user).allowed, i < 3);
    }
  }
});

test("replies to someone else, duplicates and split text do not inflate a member's counter", () => {
  const { guard, incoming } = fixture({ groupChatLoopMaxTurns: 2 });
  incoming();
  for (let i = 0; i < 10; i++) { guard.recordReply("1001", "90000003"); assert.equal(incoming().allowed, true); }
  for (let i = 0; i < 5; i++) guard.recordReply("1001", "90000002");
  assert.equal(incoming().allowed, true);
  assert.equal(incoming().allowed, true);
  const duplicate = { message_id: "replay" };
  assert.equal(incoming("90000002", "1001", duplicate).allowed, true);
  assert.equal(incoming("90000002", "1001", duplicate).reason, "duplicate");
  guard.recordReply("1001", "90000002");
  assert.equal(incoming().allowed, false);
});

test("a blocked account must be quiet for the full period; time alone never restarts work", () => {
  const { guard, incoming, advance } = fixture({ groupChatLoopMaxTurns: 2 });
  incoming(); guard.recordReply("1001", "90000002"); incoming();
  guard.recordReply("1001", "90000002"); incoming();
  for (let i = 0; i < 5; i++) { advance(599000); assert.equal(incoming().allowed, false); }
  advance(600001);
  assert.equal(guard.canRespond("1001", "90000002"), false);
  incoming("90000003");
  assert.equal(guard.canRespond("1001", "90000002"), false);
  assert.equal(incoming().allowed, true);
});

test("slow human follow-ups and explicitly trusted users do not trip the heuristic", () => {
  const { guard, incoming, advance } = fixture({ groupChatLoopMaxTurns: 2,
    groupChatTrustedUserIds: new Set(["90000003"]), botAdminIds: new Set(["631978355"]) });
  incoming();
  for (let i = 0; i < 8; i++) {
    guard.recordReply("1001", "90000002"); advance(121000); assert.equal(incoming().allowed, true);
    for (const user of ["90000003", "631978355"]) { incoming(user); guard.recordReply("1001", user); assert.equal(incoming(user).allowed, true); }
  }
});

test("explicit ignore wins over trust, and allowing a bot retains loop protection", () => {
  let decision = null;
  const { guard, incoming } = fixture({ groupChatBotIds: new Set(["90000002"]), groupChatLoopMaxTurns: 2 },
    { accountDecision: () => decision });
  assert.equal(incoming().reason, "known_bot");
  assert.equal(incoming("90000003", "1001", { sender: { is_bot: true } }).reason, "known_bot");
  decision = "allow";
  assert.equal(incoming().allowed, true);
  guard.recordReply("1001", "90000002"); incoming(); guard.recordReply("1001", "90000002");
  assert.equal(incoming().reason, "reply_loop");
  decision = "ignore";
  assert.equal(guard.canRespond("1001", "90000002"), false);
});

test("resetting and allowing an account cannot resurrect an old response ticket", () => {
  const { guard, incoming } = fixture();
  incoming();
  const old = guard.responseCheck("1001", "90000002");
  assert.equal(old(), true);
  guard.resetAccount("1001", "90000002");
  assert.equal(old(), false);
  incoming();
  assert.equal(old(), false);
  assert.equal(guard.responseCheck("1001", "90000002")(), true);
});
