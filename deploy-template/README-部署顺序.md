# Sandstorm QQ Bot 预制部署包

这个目录可以直接复制到 `angelabalzac.ddns.net` 所在的 Windows 10 服务器运行。目标机器不需要安装 Node.js。

## 已有部署增量更新

如果目标机器已经部署并登录过 QQ，不需要覆盖 NapCat 运行目录：

1. 先运行 `03-停止Bot服务.ps1`。
2. 用新包里的 `sandstorm-qq-bot.exe` 替换旧文件。
3. 保留目标机器原有 `.env`，不要用 `.env.example` 直接覆盖；把 `.env.example` 新增的 `LOCAL_QWEN_*` 配置合并进去，并填写真实 URL、API Key 和模型 ID。
4. 建议同步替换 `.env.example`、`00-打开配置.ps1` 和本说明文件，方便以后维护。
5. 运行 `02-启动Bot服务.ps1`；机器人启动后会立即检查 Qwen，之后每 10 秒检查一次，不可用时自动回退到 DeepSeek。

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
   - 如需优先使用本地 Qwen，填写 `LOCAL_QWEN_BASE_URL`、`LOCAL_QWEN_API_KEY` 和 `LOCAL_QWEN_MODEL`；机器人每 10 秒检查一次连通性，不可用时自动回退到 `DEEPSEEK_API_KEY` 对应的 DeepSeek
   - Qwen 默认优先回答最后一条用户消息，自动判断承接或换题并解析最近指代；可用 `LOCAL_QWEN_DIALOGUE_PROMPT` 调整对话理解规则
   - 消息里包含 `联网搜索`、`联网查询` 或 `联网搜搜` 时会使用内嵌 open-websearch 的 `web_search` / `web_fetch` 工具；同一条消息再包含 `深度思考` 时会同时启用推理
   - Local Qwen 的艾特问答和主动闲聊共用群级最近 100 条上下文，群成员消息、图片和机器人自己的回复都计入；单次最多保留最近 10 张不同图片
   - `@机器人` 时可发送图文或纯图片，也可先发图片，再回复该图片并艾特机器人提问；缓存未命中时会通过 OneBot `get_msg` 取回原图；DeepSeek 回退保持原有文本与短上下文模式
   - 合并转发聊天记录会通过 OneBot `get_forward_msg` 读取；嵌套记录按原始顺序递归展平，文字、表情和图片只进入 Local Qwen 上下文，DeepSeek 及其回退路径继续忽略
   - QQ 内置表情、超级表情、骰子、猜拳会转换成可理解的语义标签；商城表情会同时保留摘要与可用图片，单独发送也能进入上下文并触发主动闲聊
   - 未 `@机器人` 的普通群聊默认会以较低概率触发即时闲聊；如果之后 `AMBIENT_CHAT_IDLE_SECONDS` 秒内没人继续发消息，会基于同一份最多 100 条/10 图上下文触发一次冷场闲聊
   - 群上下文严格以最新成员消息为唯一回应锚点，历史消息按距离递减权重且只能用于解释最新消息；关联只按指代、同一对象/事件、条件修正、因果延续或图片内容等语义判断，QQ 回复/引用标记只定位内容、不作为关联证据；语义无关的旧内容会被要求忽略
   - 可调整 `AMBIENT_CHAT_PROBABILITY`、`AMBIENT_CHAT_IDLE_SECONDS`、`AMBIENT_CHAT_INSTANT_MAX_MESSAGES`、`AMBIENT_CHAT_IDLE_MAX_MESSAGES`、`AMBIENT_CHAT_CONTEXT_SECONDS`，或用 `AMBIENT_CHAT_ENABLED=false` 关闭
   - `RESPONSE_NEUTRALITY_PROMPT` 会统一约束聊天和闲聊回复，避免出现政治或宗教倾向
   - 默认无需搜索 API Key，也不需要单独启动搜索服务；可通过 `OPEN_WEBSEARCH_ENGINES` 调整搜索引擎列表
   - Bilibili 发送失败时，`logs/out.log` 和 `logs/err.log` 会按 `traceId` 输出下载文件哈希、MP4 结构、上传耗时及完整 OneBot 错误。需要保留失败视频手工测试时，可临时设置 `BILIBILI_KEEP_FAILED_VIDEO=true`；测试后请删除日志所示文件并恢复为 `false`

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
