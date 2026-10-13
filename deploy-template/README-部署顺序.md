# Sandstorm QQ Bot 预制部署包

这个目录可以直接复制到 `angelabalzac.ddns.net` 所在的 Windows 10 服务器运行。目标机器不需要安装 Node.js。

## 已有部署增量更新

如果目标机器已经部署并登录过 QQ，不需要覆盖 NapCat 运行目录：

1. 先运行 `03-停止Bot服务.ps1`。
2. 用新包里的 `sandstorm-qq-bot.exe` 替换旧文件。
3. 同步复制新包里的 `config` 目录，确保 `config\azur-lane-personas.json` 与 exe 保持这个相对位置；该文件未打进 exe，缺失时机器人会拒绝启动。
4. 保留目标机器原有 `.env`、真实 API Key、群号和 `data\persona-selections.json`，将新版配置合并进去。旧配置中的实验模型和 `WEB_SEARCH_PROVIDER=auto` 会覆盖程序的新默认值，需要按下方示例更新。`PERSONA_CATALOG_FILE`、`PERSONA_CACHE_FILE`、`PERSONA_FLEXIBILITY_PROMPT` 留空即可使用推荐默认值。
5. 建议同步替换 `.env.example`、`00-打开配置.ps1` 和本说明文件，方便以后维护。
6. 运行 `02-启动Bot服务.ps1`；默认优先使用正式 DeepSeek，配置了可用的 Qwen 时可在 DeepSeek 请求失败后回退。

本轮升级建议合并以下配置，其余搜索预算及网页读取上限见新的 `.env.example`：

```dotenv
AI_PRIMARY_PROVIDER=deepseek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VISION_MODEL=deepseek-flash
DEEPSEEK_THINKING_ENABLED=false
WEB_SEARCH_AUTO_ENABLED=true
WEB_SEARCH_PROVIDER=deepseek-official
DEEPSEEK_SEARCH_BASE_URL=https://api.deepseek.com/anthropic/v1
DEEPSEEK_SEARCH_MODEL=deepseek-v4-flash
WEB_SEARCH_MAX_QUERIES=4
WEB_SEARCH_MAX_RESULTS=8
WEB_SEARCH_TIMEOUT_MS=30000
CHAT_MAX_HISTORY_MESSAGES=50
LOCAL_QWEN_MAX_HISTORY_MESSAGES=50
AMBIENT_CHAT_INSTANT_MAX_MESSAGES=50
AMBIENT_CHAT_IDLE_MAX_MESSAGES=50
```

删除旧的 `AMBIENT_CHAT_PROBABILITY`；冷场与普通群聊现在都先由 AI 判断是否接话。若旧 `.env` 固定了过时的 `NATURAL_CHAT_PROMPT`、`AMBIENT_CHAT_SYSTEM_PROMPT` 或 `AMBIENT_CHAT_JUDGE_PROMPT`，清空这些项可启用新版默认提示词；有意维护的自定义提示词可以保留。

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
   - 默认 `REQUIRE_AT=true`，查询游戏服务器状态时需要 `@机器人` 并输入关键词
   - `ACCESS_TOKEN` 可留空；如果填写，NapCat 里也要填同一个 token
   - 默认填写 `DEEPSEEK_API_KEY` 即可使用正式 DeepSeek Flash；聊天和视觉模型都使用 `deepseek-flash`，默认不开启思考
   - 如需优先使用本地 Qwen，设置 `AI_PRIMARY_PROVIDER=local-qwen`，填写 `LOCAL_QWEN_BASE_URL`、`LOCAL_QWEN_API_KEY` 和 `LOCAL_QWEN_MODEL`；机器人每 10 秒检查一次连通性，不可用时自动回退到 DeepSeek
   - `LOCAL_QWEN_SYSTEM_PROMPT` 和 `DEEPSEEK_SYSTEM_PROMPT` 分别保存两条 AI 路径的默认人格；每次回复采用最新聊天发送人的人格选择，未设定就使用默认人格。选择按“群号 + QQ号”独立保存
   - `PERSONA_CATALOG_FILE` 留空时读取 exe 同级的 `config\azur-lane-personas.json`；修改该文件并重启即可维护人格，无需重新打包 exe。`PERSONA_CACHE_FILE` 留空时把个人选择保存到 `data\persona-selections.json`
   - 人格指令和完整帮助都必须真实艾特机器人；可发送 `@机器人 帮助`、`@机器人 人格列表`、`@机器人 切换人格 企业`、`@机器人 自定义人格 <提示词>`、`@机器人 当前人格` 或 `@机器人 重置人格`
   - Qwen 默认优先回答最后一条用户消息，自动判断承接或换题并解析最近指代；可用 `LOCAL_QWEN_DIALOGUE_PROMPT` 调整对话理解规则
   - 默认 `WEB_SEARCH_AUTO_ENABLED=true`，由 AI 决定是否调用 `web_search` / `web_fetch`，也允许直接说不知道。明确要求不搜索时直接回复；需要查资料时可以说“联网搜索”“联网查询”或直接要求查证
   - 默认 `WEB_SEARCH_PROVIDER=deepseek-official` 使用移植的 DeepSeek Harness 原生搜索。引用片段足够时可直接回答，需要详情时读取网页并转换为 Markdown；用户提供公开网址时可直接读取。旧 `auto` 提供方链路保留为显式选项
   - DeepSeek 与 Local Qwen 的艾特问答、即时闲聊和冷场判断共用群级最近 50 条消息，包含机器人实际发送的回复，按时间从旧到新排列，超出时裁掉最早的记录；单次最多保留最近 10 张不同图片
   - `@机器人` 时可发送图文或纯图片，也可先发图片，再回复该图片并艾特机器人提问；缓存未命中时会通过 OneBot `get_msg` 取回原图。DeepSeek 使用正式 Flash 原生视觉，普通识图不预 OCR，只有明确要求读取/提取/翻译图片文字时才按需 OCR 并按内容哈希缓存
   - 合并转发聊天记录会通过 OneBot `get_forward_msg` 读取；嵌套记录按原始顺序递归展平，文字、表情和图片只进入 Local Qwen 上下文，DeepSeek 及其回退路径继续忽略
   - QQ 内置表情、超级表情、骰子、猜拳会转换成可理解的语义标签；商城表情会同时保留摘要与可用图片，单独发送也能进入上下文并触发主动闲聊
   - 未 `@机器人` 的普通群聊先由 AI 判断是否接话；空闲达到 `AMBIENT_CHAT_IDLE_SECONDS` 后也只是再判断一次，不保证暖场。不是点名问 AI、话题已结束或没有值得补充的内容时可以保持沉默
   - 回复结合最新成员消息与相关群聊，不强行解释无关旧话题；同一个群只保留一个进行中的接话判断，判断期间有新消息时会丢弃过时答复
   - 可调整 `AMBIENT_CHAT_COOLDOWN_SECONDS`、`AMBIENT_CHAT_IDLE_SECONDS`、`AMBIENT_CHAT_JUDGE_TIMEOUT_MS`，或用 `AMBIENT_CHAT_ENABLED=false` 关闭主动闲聊；上下文数量配置有 50 条硬上限
   - `RESPONSE_NEUTRALITY_PROMPT` 会统一约束聊天和闲聊回复，避免出现政治或宗教倾向
   - 官方搜索复用 `DEEPSEEK_API_KEY`，不需要单独启动搜索服务。每条查询是额外模型请求，搜索模型自身可能产生思考 token；这不改变主聊天的非思考默认值。搜索地址和模型由独立的 `DEEPSEEK_SEARCH_*` 配置控制
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
   - 发送 `@机器人 帮助` 检查完整指令菜单
   - 发送 `@机器人 人格列表`，切换一个人格后再发送 `@机器人 当前人格`

## 停止与日志

- 停止 bot：运行 `03-停止Bot服务.ps1`
- 查看日志：运行 `04-查看Bot日志.ps1`

## 端口说明

- OneBot 反向 WebSocket：本机 `127.0.0.1:6700`
- 叛乱服务器查询：默认 UDP `27015`

如果 NapCat 和 bot 都在同一台机器，不需要把 `6700` 暴露到公网。
