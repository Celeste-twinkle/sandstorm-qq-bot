const HELP_COMMAND_ALIASES = Object.freeze([
  "帮助",
  "help",
  "/help",
  "使用说明",
  "功能",
  "菜单",
  "指令",
  "全部指令",
]);

function isHelpCommand(input) {
  return HELP_COMMAND_ALIASES.includes(String(input || "").trim().toLowerCase());
}

function buildHelpText(options = {}) {
  const customPersonaMaxChars = Number(options.customPersonaMaxChars);
  const customLimit = Number.isInteger(customPersonaMaxChars) && customPersonaMaxChars > 0
    ? `（最多 ${customPersonaMaxChars} 字）`
    : "";

  return [
    "Sandstorm QQ Bot 全部指令",
    "除 Bilibili 链接外，以下入口都需要真实 @机器人。",
    "",
    "【服务器】",
    "@机器人 ins / 叛乱 / 沙漠风暴 / 服务器状态：查询游戏服务器",
    "",
    "【AI 对话】",
    "@机器人 <问题>：普通聊天；Qwen 会参考群内最近 100 条消息",
    "@机器人 深度思考 <问题>：请求更强推理",
    "@机器人 联网搜索 / 联网查询 / 联网搜搜 <问题>：联网研究",
    "@机器人 联网搜索 深度思考 <问题>：组合使用",
    "@机器人 并附带图片，或回复图片后 @机器人：图片问答",
    "",
    "【人格】",
    "@机器人 人格列表 [阵营]：查看可切换人格",
    "@机器人 人格查询 <人格值>：查看人格详情",
    "@机器人 切换人格 <人格列表值>：切换当前群个人的人格",
    `@机器人 自定义人格 <提示词>：设置当前群个人的自定义人格${customLimit}`,
    "@机器人 当前人格：查看当前选择",
    "@机器人 重置人格：恢复列克星敦主人格",
    "@机器人 人格帮助：查看人格子菜单",
    "",
    "【会话】",
    "@机器人 清空上下文 / 重置会话 / 清除记忆 / reset / /reset",
    "",
    "【无需 @】",
    "直接发送 Bilibili / b23.tv 视频链接：解析并发送视频",
    "",
    "【帮助入口】",
    "@机器人 帮助 / help / /help / 使用说明 / 功能 / 菜单 / 指令 / 全部指令",
  ].join("\n");
}

module.exports = {
  HELP_COMMAND_ALIASES,
  buildHelpText,
  isHelpCommand,
};
