# Sandstorm QQ Bot 预制部署包

这个目录可以直接复制到 `angelabalzac.ddns.net` 所在的 Windows 10 服务器运行。目标机器不需要安装 Node.js。

## 部署顺序

最快方式：配置完成后，直接运行：

```text
05-一键启动NapCat和Bot.ps1
```

它会自动启动 NapCat，尝试打开二维码图片，然后启动 bot 服务。

1. 运行 `00-打开配置.ps1`
   - 确认 `SANDSTORM_HOST=127.0.0.1`
   - 确认 `SANDSTORM_PORT=27015`，如果你的查询端口不同就改成实际端口
   - 建议填写 `ALLOWED_GROUP_IDS=你的QQ群号`
   - 默认 `REQUIRE_AT=true`，必须 `@机器人` 并输入关键词才回复
   - `ACCESS_TOKEN` 可留空；如果填写，NapCat 里也要填同一个 token
   - 如需聊天和联网搜索，填写 `DEEPSEEK_API_KEY`；消息里包含 `联网搜索`、`联网查询` 或 `联网搜搜` 时会使用内嵌 open-websearch 的 `web_search` / `web_fetch` 工具；同一条消息再包含 `深度思考` 时会同时开启 thinking
   - 未 `@机器人` 的普通文字群聊默认会以较低概率触发参考最近群上下文的即时闲聊吐槽，默认最多取 `AMBIENT_CHAT_INSTANT_MAX_MESSAGES` 条；如果之后 `AMBIENT_CHAT_IDLE_SECONDS` 秒内没人继续发普通文字，会从群级最近上下文里按旧到新采集最多 `AMBIENT_CHAT_IDLE_MAX_MESSAGES` 条普通文字，100% 触发一次冷场闲聊；图片消息会被忽略
   - 可调整 `AMBIENT_CHAT_PROBABILITY`、`AMBIENT_CHAT_IDLE_SECONDS`、`AMBIENT_CHAT_INSTANT_MAX_MESSAGES`、`AMBIENT_CHAT_IDLE_MAX_MESSAGES`、`AMBIENT_CHAT_CONTEXT_SECONDS`，或用 `AMBIENT_CHAT_ENABLED=false` 关闭
   - `RESPONSE_NEUTRALITY_PROMPT` 会统一约束聊天和闲聊回复，避免出现政治或宗教倾向
   - 默认无需搜索 API Key，也不需要单独启动搜索服务；可通过 `OPEN_WEBSEARCH_ENGINES` 调整搜索引擎列表

2. 运行 `01-启动OneBot-NapCat.ps1`
   - 完成 QQ 登录
   - 打开 NapCat WebUI
   - 新建 `WebSocket Client`
   - URL 填：`ws://127.0.0.1:6700/onebot/v11/ws`
   - Token 和 `.env` 的 `ACCESS_TOKEN` 保持一致
   - 保存并启用

3. 运行 `02-启动Bot服务.ps1`
   - bot 会在后台运行
   - 日志在 `logs/out.log` 和 `logs/err.log`

4. 在 QQ 群测试
   - 发送 `@机器人 ins`
   - 或发送 `@机器人 叛乱`

## 停止与日志

- 停止 bot：运行 `03-停止Bot服务.ps1`
- 查看日志：运行 `04-查看Bot日志.ps1`

## 端口说明

- OneBot 反向 WebSocket：本机 `127.0.0.1:6700`
- 叛乱服务器查询：默认 UDP `27015`

如果 NapCat 和 bot 都在同一台机器，不需要把 `6700` 暴露到公网。
