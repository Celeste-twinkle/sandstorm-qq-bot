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

function buildHelpText() {
  return [
    "Sandstorm QQ Bot 全部指令",
    "除 Bilibili 链接外，以下入口都需要真实 @机器人。",
    "",
    "【服务器】",
    "@机器人 ins / 叛乱 / 沙漠风暴 / 服务器状态：查询游戏服务器",
    "",
    "【AI 对话】",
    "@机器人 <问题>：默认使用 DeepSeek V4.1 Flash，参考群内最近 50 条消息（含 bot 回复）",
    "AI 会按需搜索，也可以说不清楚；未点名时由 AI 判断是否接话",
    "@机器人 深度思考 <问题>：请求更强推理",
    "@机器人 联网搜索 / 联网查询 / 联网搜搜 <问题>：联网研究",
    "@机器人 联网搜索 深度思考 <问题>：组合使用",
    "@机器人 并附带图片，或回复图片后 @机器人：图片问答",
    "",
    "【会话】",
    "@机器人 清空上下文 / 重置会话 / 清除记忆 / reset / /reset",
    "@机器人 学习状态：查看本群学到的表达习惯和回复指导",
    "@机器人 重置群聊学习：清除本群的学习结果并重新积累",
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
