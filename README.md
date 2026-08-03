# Sandstorm QQ Bot

QQ 群关键词机器人，用 OneBot v11 反向 WebSocket 接收群消息，并查询 `Insurgency: Sandstorm` 服务器状态。

## 功能

- 默认只在群聊里 `@机器人` 且包含关键词时回复
- 关键词：`叛乱`、`沙漠风暴`、`服务器状态`、`ins`
- 查询 Insurgency: Sandstorm 服务器在线状态、服务器名、地图、人数、延迟和部分玩家名
- 支持限定 QQ 群号
- 支持群冷却，避免重复刷屏
- 支持 Windows 10 本机后台运行、单 exe 纯净运行、PM2 和 Docker Compose 部署

## 为什么没有直接用汇编

同目录的 `nodejs-osc-VRChat-chatbox` 适合做成小型 Win32 汇编程序，因为它主要是本地 HTTP + UDP OSC。

这个 QQ 机器人需要长期维护 WebSocket、JSON、OneBot v11 事件、QQ 机器人鉴权，以及 Steam/Valve UDP 查询协议。纯汇编可以做，但成本和故障排查难度会很高。当前版本使用 Node.js 开发，并提供 Windows x64 单 exe 打包。目标机器不需要安装 Node.js。

## 配置

复制配置文件：

```powershell
Copy-Item .env.example .env
```

修改 `.env`：

```env
SANDSTORM_HOST=你的服务器IP或域名
SANDSTORM_PORT=27015
TRIGGER_KEYWORDS=叛乱,沙漠风暴,服务器状态,ins
REQUIRE_AT=true
ALLOWED_GROUP_IDS=你的QQ群号
LOCAL_QWEN_BASE_URL=你的OpenAI兼容Qwen地址/v1
LOCAL_QWEN_API_KEY=你的Local Qwen API Key
LOCAL_QWEN_MODEL=qwen3.6-local
DEEPSEEK_API_KEY=你的DeepSeek API Key
```

`SANDSTORM_PORT` 是查询端口，通常是 UDP `27015`，但不一定等于游戏端口。服务器防火墙需要放行该 UDP 端口。

`REQUIRE_AT=true` 表示必须 `@机器人` 并输入关键词才回复，例如：

```text
@机器人 ins
@机器人 叛乱
```

如果想恢复“只要群里出现关键词就回复”，改成：

```env
REQUIRE_AT=false
```

开启 AI 聊天后，群里 `@机器人` 且不包含查服关键词的消息会优先进入 Local Qwen；Local Qwen 不可用时自动回退到 DeepSeek。包含 `叛乱`、`沙漠风暴`、`服务器状态`、`ins` 等关键词时仍优先查询服务器状态。

Local Qwen 使用 OpenAI 兼容的 `/chat/completions` 接口和 Bearer 认证。机器人启动时会立即请求一次 `/models`，之后默认每 10 秒检查一次；网络错误、超时或服务端错误会触发当前整轮请求回退到 DeepSeek，服务恢复后自动切回。健康检查间隔、路径和超时可通过 `LOCAL_QWEN_HEALTH_INTERVAL_MS`、`LOCAL_QWEN_HEALTH_PATH`、`LOCAL_QWEN_HEALTH_TIMEOUT_MS` 调整。

Qwen 的提示词分为角色、对话理解和长度控制三层，可分别通过 `LOCAL_QWEN_SYSTEM_PROMPT`、`LOCAL_QWEN_DIALOGUE_PROMPT`、`LOCAL_QWEN_CONCISE_PROMPT` 调整。默认对话规则会优先回答最后一条用户消息，区分承接上文与切换话题，解析最近相关指代，并且只在真正影响答案的关键歧义上追问。

Local Qwen 的普通问答、主动闲聊和图片问答统一启用强推理，不再按问题类型分级；`LOCAL_QWEN_REASONING_EFFORT` 只接受 `high` 或 `max`，默认 `high` 兼顾推理质量与速度。所有用户可见的 Qwen 回复仍统一使用 `LOCAL_QWEN_MODEL_MAX_OUTPUT_TOKENS` 作为 `max_tokens`，避免隐藏推理耗尽小生成预算后没有正文。后台图片 OCR/语义索引明确使用 `none`，避免 Ollama 单并发被后台任务长时间占用；图片问答本身不受影响。主动闲聊默认超时相应提高到 30 秒。DeepSeek 回退仍使用自己的输出和推理配置。

Qwen 模式无需附加 `深度思考`，普通对话本身就使用强推理。只有聊天消息明确包含 `联网搜索`、`联网查询` 或 `联网搜搜` 时才进入本地联网搜索工具模式，由模型调用 `web_search` / `web_fetch`，本地 Node 程序执行搜索和网页读取；未命中联网触发词时请求体不提供联网工具，因此不会自行搜索。DeepSeek 回退仍保留原有的 `深度思考` 触发行为。

Qwen 使用专属的多轮研究代理：联网时默认强制 `reasoning_effort=high`，首轮必须搜索，支持并行工具调用，并把 Ollama 返回的 `message.reasoning` 原样带入后续工具回合。默认最多 4 轮、每轮 4 个、整轮 12 个工具调用；每条搜索保留 5 个结果、12 个候选，摘要最多 500 字，网页正文最多 6000 字，并预留 48000 token 给研究证据。复杂问题会先做互补搜索，再读取多个官方/一手或独立来源，继续查漏后综合；配置入口为 `LOCAL_QWEN_WEB_*`。这条链路利用 Qwen 的 262144 token 上下文，DeepSeek 回退仍保留原来的 2 轮 × 2 调用和较小证据窗口。

所有联网路径都会根据 QQ 用户原始问题、模型搜索词和结果日期做相关性/时效性重排。回答要求重要事实紧邻标注来源；如果来源不足、冲突或搜索质量差，会说明无法可靠确认。默认使用内嵌的 `open-websearch@2.1.11`，不需要单独启动服务，也不需要搜索 API Key；可通过 `OPEN_WEBSEARCH_ENGINES` 调整搜索引擎列表。

Local Qwen 使用群级统一上下文：艾特问答和主动闲聊都会读取当前群最近最多 100 条消息，普通成员消息、图片消息以及机器人自己的回复都计入这 100 条，并按 262144 token 上限裁剪。回退到 DeepSeek 时仍使用原有的当前用户最近 16 条和 12000 字符限制；主动闲聊回退仍只取最近 6 条文本摘要。发送 `清空上下文`、`重置会话` 或 `reset` 会清空当前群的 Qwen 上下文。

Local Qwen 支持 OneBot 图片段和 CQ 图片码。`@机器人` 时可以发送纯图片、图文消息，也可以先发送图片，再回复该图片并艾特机器人提问；缓存未命中时机器人会通过 OneBot `get_msg` 取回被引用的原图。每次模型请求最多保留上下文里最新的 10 张不同图片，并明确标记越新的图片优先级越高；多张原图之间会插入文字分隔，避免视觉后端把连续图片错误合并。机器人收到图片时就会在后台为每张图发起一次独立的 Qwen 单图 OCR/语义索引，后续触发聊天时优先携带已提取的缓存文本；同一 URL 或内容哈希相同的图片只索引一次，不再重复传输整张原图。若聊天首轮仍明确回复“看不到图片”，机器人会等待最新图片的单图缓存并自动重答一次。图片下载与索引会执行类型、超时、单图大小和总大小检查。缓存默认保留在当前进程内 12 小时、最多 500 张，可通过 `LOCAL_QWEN_IMAGE_CACHE_*` 配置调整；重启机器人会清空缓存。OpenAI/Ollama 接口不支持导出并重新注入模型内部视觉 embedding，因此这里缓存的是可复用的文字词元，而不是私有的内部视觉向量。DeepSeek 回退链路保持文本模式，图片会转换为 `[图片]` 关联占位符。

QQ 内置表情、超级表情、骰子和猜拳会转换成带含义的上下文标签，例如 `[QQ表情：笑哭]`、`[骰子：6 点]`；商城表情或 NapCat 转换出的表情图片会同时保留摘要和可用图片，由 Qwen 结合语义与视觉理解。未知表情 ID 只保留 ID，不猜测名称。单独发送这些表情也能进入群级上下文并触发主动闲聊。

未 `@机器人` 的普通群聊可触发闲聊：即时闲聊和冷场闲聊都使用同一份群级 Qwen 上下文，默认最多 100 条消息和 10 张图片；冷场闲聊会在 `AMBIENT_CHAT_IDLE_SECONDS` 秒无人继续发消息后回复。`AMBIENT_CHAT_CONTEXT_SECONDS` 默认 7200 秒，与默认会话有效期一致。

Qwen 群上下文采用严格的新旧优先级：最后一条群成员消息标记为唯一回应锚点；越近的消息权重越高，但只能用于解释当前锚点。历史关联只按语义判断，例如明确指代、同一对象/事件、条件修正、因果延续、语义承接或图片内容关联；QQ 回复/引用标记仅用于定位文字或图片，本身不构成关联证据，也不会提高权重。未通过语义门槛的较早消息不能参与推理或独立成为回复目标，冷场闲聊同样不得复活无关旧话题。

群里直接发送 Bilibili / b23.tv 普通视频链接时，bot 会通过外部解析服务获取 MP4，并默认先下载到系统临时目录，再把本地文件交给 NapCat 发送，避免 Bilibili 防盗链导致 `rich media transfer failed`。视频发送完成后会自动清理临时文件；超过 `BILIBILI_MAX_VIDEO_SIZE_MB`（默认 95 MB）或 QQ 上传失败时，会自动退回标题和原视频链接，不再误报成解析失败。此功能不需要 `@机器人`；普通网页 URL 不会触发解析。

Bilibili 链路会为每次请求生成 `traceId`，并在日志中记录解析、下载、文件校验、上传尝试、OneBot 完整错误响应和临时文件清理结果。需要在部署机上保留失败视频做 QQ 客户端手工发送测试时，可临时设置 `BILIBILI_KEEP_FAILED_VIDEO=true`；测试完成后请按日志中的 `filePath` 手工删除文件并恢复为 `false`。

## 本机运行

```powershell
npm install
npm start
```

启动后，在 NapCat / Lagrange 等 OneBot 实现里配置反向 WebSocket：

```text
ws://127.0.0.1:6700/onebot/v11/ws
```

如果 QQ 客户端和机器人不在同一台机器，把 `127.0.0.1` 换成机器人机器的局域网 IP 或公网 IP。

如果 `.env` 设置了 `ACCESS_TOKEN`，OneBot 客户端需要携带：

```text
Authorization: Bearer 你的ACCESS_TOKEN
```

## Windows 10 后台运行

开发机已安装 Node.js 时，可以直接运行源码：

```powershell
.\scripts\start.ps1
.\scripts\stop.ps1
```

日志在：

```text
logs/out.log
logs/err.log
```

需要开机自启时，可以用 Windows 任务计划程序创建一个“登录时运行”的任务，操作填写：

```text
powershell.exe
```

参数填写：

```text
-ExecutionPolicy Bypass -File "F:\工作相关\github\sandstorm-qq-bot\scripts\start.ps1"
```

## 打包为单 exe

在开发机运行：

```powershell
npm install
npm run release
```

产物在：

```text
release/
  sandstorm-qq-bot.exe
  .env.example
  start.ps1
  stop.ps1
```

把整个 `release` 目录复制到目标 Windows 10 机器，目标机不需要安装 Node.js。第一次运行前，把 `.env.example` 复制或重命名为 `.env`，填好服务器 IP、查询端口、QQ群号等配置。

目标机后台启动：

```powershell
.\start.ps1
```

停止：

```powershell
.\stop.ps1
```

目标机的 NapCat / Lagrange 反向 WebSocket 地址仍然是：

```text
ws://目标机器IP:6700/onebot/v11/ws
```

## 配套 OneBot 客户端

本工程已提供 NapCat OneBot 客户端辅助脚本。源码目录安装：

```powershell
npm run onebot:install
npm run onebot:start
```

打包后的 `release` 目录安装：

```powershell
.\install-onebot-napcat.ps1
.\start-onebot-napcat.ps1
```

NapCat 启动并登录 QQ 后，在 WebUI 的网络配置里新建 `WebSocket Client`：

```text
URL: ws://127.0.0.1:6700/onebot/v11/ws
Token: 和 .env 里的 ACCESS_TOKEN 保持一致；如果 ACCESS_TOKEN 为空，这里也留空
```

详细说明见 `onebot/README.md`。

## 预制部署包

需要一个按顺序部署的完整包时，在开发机运行：

```powershell
npm run deploy:package
```

生成：

```text
deploy/SandstormQQBot-Deploy/
deploy/SandstormQQBot-Deploy.zip
```

复制到目标 Windows 10 服务器后，按编号执行：

```text
00-打开配置.ps1
01-启动OneBot-NapCat.ps1
02-启动Bot服务.ps1
```

部署包内已带 NapCat OneKey 运行文件、bot 单 exe、配置示例、停止脚本和日志查看脚本。

如果 NapCat 已完成安装，也可以使用一站式启动：

```text
05-一键启动NapCat和Bot.ps1
```

## PM2 部署

```powershell
npm install
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

## Docker 部署

```powershell
docker compose up -d --build
```

## 常见问题

- 查询失败：检查服务器是否在线、`SANDSTORM_PORT` 是否是查询端口、UDP 查询端口是否被防火墙放行。
- 没有回复：检查 OneBot 是否成功连接、群号是否被 `ALLOWED_GROUP_IDS` 限制、是否已经 `@机器人`、关键词是否匹配。
- 重复触发不回复：默认同群 20 秒冷却，可调整 `COOLDOWN_SECONDS`。
