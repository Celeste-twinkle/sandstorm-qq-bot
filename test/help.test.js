const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HELP_COMMAND_ALIASES,
  buildHelpText,
  isHelpCommand,
  LEARNING_RESET_COMMAND_ALIASES,
  isLearningResetCommand,
} = require("../src/help");

test("all documented help aliases open the complete command menu", () => {
  for (const alias of HELP_COMMAND_ALIASES) {
    assert.equal(isHelpCommand(alias), true);
    assert.equal(isHelpCommand(alias.toUpperCase()), true);
  }
  assert.equal(isHelpCommand("人格列表"), false);
});

test("complete help lists supported commands without persona switching", () => {
  const help = buildHelpText();

  for (const expected of [
    "Sandstorm QQ Bot 全部指令",
    "@机器人 ins",
    "@机器人 <问题>",
    "DeepSeek V4.1 Flash",
    "默认 100 条，含 bot 回复",
    "@机器人 深度思考 <问题>",
    "@机器人 联网搜索",
    "@机器人 学习状态",
    "@机器人 记忆状态",
    "@机器人 轮换会话",
    "@机器人 黑话列表",
    "@机器人 学黑话",
    "@机器人 收集表情",
    "@机器人 表情库状态",
    "@机器人 清空表情库",
    "@机器人 重置群聊学习",
    "重置学习模块 / 清空学习模块",
    "@机器人 忽略 @目标账号",
    "@机器人 允许 @目标账号",
    "@机器人 忽略列表",
    "@机器人 清空上下文",
    "Bilibili / b23.tv",
    "@机器人 帮助 / help / /help / 使用说明 / 功能 / 菜单 / 指令 / 全部指令",
  ]) {
    assert.equal(help.includes(expected), true, `missing help entry: ${expected}`);
  }
  assert.doesNotMatch(help, /人格列表|切换人格|自定义人格|当前人格|重置人格|列克星敦/);
});

test("all learning reset aliases share the administrator reset command", () => {
  for (const alias of LEARNING_RESET_COMMAND_ALIASES) assert.equal(isLearningResetCommand(` ${alias} `), true);
  assert.equal(isLearningResetCommand("学习状态"), false);
  assert.equal(isLearningResetCommand("清空上下文"), false);
});
