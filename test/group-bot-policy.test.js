const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { GroupBotPolicy, parseBotControlCommand, resolveBotPolicyFile } = require("../src/group-bot-policy");

const bot = "90000001", target = "90000002";
const at = qq => ({ type: "at", data: { qq } });
const command = text => ({ self_id: bot, message: [at(bot), { type: "text", data: { text } }, at(target)] });
const quiet = { warn() {} };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-bot-policy-"));
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  t.after(() => {
    assert.equal(fs.realpathSync(directory), resolved);
    assert.ok(path.basename(resolved).startsWith("sandstorm-bot-policy-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const config = { groupChatBotPolicyFile: path.join(directory, "policy.json") };
  return { directory, config, policy: new GroupBotPolicy(config, { logger: quiet }) };
}

test("loose ignore commands accept synonyms and natural phrases with explicit targets", () => {
  for (const text of ["忽略", "忽视一下", "无视这个账号吧", "把这个屏蔽掉", "拉黑", "不要理他", "别搭理它了", "不理", "不要回复", "别回了", "加入黑名单", "不要取消忽略"]) {
    assert.deepEqual(parseBotControlCommand(command(text)), { action: "ignore", targets: [target] }, text);
  }
  for (const text of ["允许", "取消忽略", "解除忽视", "不要忽略他", "别再无视他", "取消屏蔽", "解除拉黑", "恢复回复", "重新回复", "从黑名单移除", "移出黑名单"]) {
    assert.deepEqual(parseBotControlCommand(command(text)), { action: "allow", targets: [target] }, text);
  }
});

test("CQ strings, mention ordering, numeric targets and multiple accounts are supported", () => {
  assert.deepEqual(parseBotControlCommand({ self_id: bot,
    message: `[CQ:at,qq=${target},name=test] 请忽视一下 [CQ:at,qq=${bot}]` }), { action: "ignore", targets: [target] });
  assert.deepEqual(parseBotControlCommand({ self_id: bot,
    raw_message: `[CQ:at,qq=${bot}] 恢复回复 ${target},90000003` }), { action: "allow", targets: [target, "90000003"] });
  const message = command("屏蔽");
  message.message.push(at(target), at("90000003"), at("all"));
  assert.deepEqual(parseBotControlCommand(message), { action: "ignore", targets: [target, "90000003"] });
});

test("a real bot mention and an explicit target are required for natural commands", () => {
  assert.equal(parseBotControlCommand({ ...command("忽略"), message: [at(target), { type: "text", data: { text: "忽略" } }] }), null);
  assert.equal(parseBotControlCommand({ self_id: bot, message: `[CQ:at,qq=${bot}] 这个报错可以忽略吗` }), null);
  assert.equal(parseBotControlCommand({ self_id: bot, message: `[CQ:at,qq=${bot}] 允许我问个问题吗` }), null);
  assert.deepEqual(parseBotControlCommand({ self_id: bot, message: `[CQ:at,qq=${bot}] 忽视` }), { action: "ignore", targets: [] });
  assert.deepEqual(parseBotControlCommand({ self_id: bot, message: `[CQ:at,qq=${bot}] 查看忽略列表` }), { action: "list", targets: [] });
});

test("ignore and allow persist across restarts and remain isolated by group", async t => {
  const { policy, config } = fixture(t);
  await policy.set("1001", [target], "ignore");
  let restored = new GroupBotPolicy(config);
  assert.equal(restored.decision("1001", target), "ignore");
  assert.equal(restored.decision("1002", target), null);
  await restored.set("1001", [target], "allow");
  restored = new GroupBotPolicy(config);
  assert.equal(restored.decision("1001", target), "allow");
  assert.deepEqual(restored.ignoredIds("1001", [target, "90000003"]), ["90000003"]);
  assert.equal(resolveBotPolicyFile(), path.resolve(__dirname, "../data/group-bot-policy.json"));
});

test("concurrent updates do not overwrite each other", async t => {
  const { policy, config } = fixture(t);
  await Promise.all([policy.set("1001", [target], "ignore"), policy.set("1002", ["90000003"], "ignore"),
    policy.set("1001", ["90000004"], "ignore")]);
  const restored = new GroupBotPolicy(config);
  assert.deepEqual(restored.ignoredIds("1001"), [target, "90000004"]);
  assert.deepEqual(restored.ignoredIds("1002"), ["90000003"]);
});

test("failed writes leave live settings unchanged and corrupt files are preserved", async t => {
  const { directory, config } = fixture(t);
  const blockedParent = path.join(directory, "blocked");
  const policy = new GroupBotPolicy({ groupChatBotPolicyFile: path.join(blockedParent, "policy.json") });
  fs.writeFileSync(blockedParent, "file");
  await assert.rejects(policy.set("1001", [target], "ignore"));
  assert.equal(policy.decision("1001", target), null);
  fs.writeFileSync(config.groupChatBotPolicyFile, "corrupt");
  const corrupt = new GroupBotPolicy(config, { logger: quiet });
  await assert.rejects(corrupt.set("1001", [target], "ignore"));
  assert.equal(fs.readFileSync(config.groupChatBotPolicyFile, "utf8"), "corrupt");
});
