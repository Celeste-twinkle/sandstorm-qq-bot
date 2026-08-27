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

列克星敦仍是主人格：群友没有选择其他人格时，Local Qwen 与 DeepSeek 回退分别完整加载 `LOCAL_QWEN_SYSTEM_PROMPT` 和 `DEEPSEEK_SYSTEM_PROMPT` 中原有的列克星敦提示词。群友选择碧蓝航线人格后，两条 AI 路径都会只为该群、该 QQ 号换用对应的外部人格；不会改动其他群友，也不会覆盖主人格配置。Qwen 的对话理解和长度控制可分别通过 `LOCAL_QWEN_DIALOGUE_PROMPT`、`LOCAL_QWEN_CONCISE_PROMPT` 调整。原有的 `RESPONSE_NEUTRALITY_PROMPT` 敏感话题限制保持启用，并紧跟在当前人格之后。人格与敏感话题限制组成普通问答和主动闲聊共用的稳定前缀，任务规则随后追加，动态群聊上下文只放在后续消息中，以便提高服务端前缀缓存命中率。默认对话规则仍会优先回答最后一条用户消息，区分承接上文与切换话题，解析最近相关指代，并且只在真正影响答案的关键歧义上追问。

## 碧蓝航线人格

外部目录现有 48 名高质量角色，按白鹰、皇家、重樱、铁血、东煌、北方联合、自由鸢尾、维希教廷和撒丁帝国分组。每名角色都包含性格、语气、措辞、交互方式、推理方式、偏好、禁忌、代表性表达和来源，不是仅替换角色名。关系基线统一为游戏中的“爱/100”满好感：当前群友已是她熟悉、信赖的指挥官，不会从路人或初见状态开场；满好感不自动等同已誓约。高风险或偏执特征只保留为安全的角色语气，不允许现实威胁、控制、跟踪、伤害、强迫或诱导依赖。

所有人格（包括列克星敦主人格）都会追加统一的自然演绎规则：保留角色的核心性格、价值取向、情感关系、措辞节奏和整体语气，但不把官方台词、口癖、名场面、舰船/战斗意象或条目中的代表性表达当作必用模板。即使旧人格块要求固定台词、强制口癖、每句固定结尾或反复自称，也以这条新规则为准并降级为可选。只有与当前语境自然贴合时才偶尔引用或化用，不合适时完全不用；回答应原创、具体并直接解决当前问题，避免机械复读和强塞角色梗。可通过 `PERSONA_FLEXIBILITY_PROMPT` 调整这条全局规则。

人格命令必须真实 `@机器人` 才会执行；未艾特时不会查询、切换、保存或重置人格：

```text
@机器人 人格列表
@机器人 人格列表 铁血
@机器人 人格查询 企业
@机器人 切换人格 企业
@机器人 自定义人格 你是一位冷静、耐心、说话简洁的研究助手
@机器人 当前人格
@机器人 重置人格
```

查询 bot 的全部指令可发送 `@机器人 帮助` 或 `@机器人 指令`；同时支持 `help`、`/help`、`使用说明`、`功能`、`菜单`、`全部指令`。完整菜单会列出查服、AI 对话、识图、联网、全部人格操作、上下文重置和无需艾特的 Bilibili 链接入口。只查看人格子菜单可发送 `@机器人 人格帮助`。

`切换人格` 支持人格列表中的中文名、英文名和常用别名。`自定义人格` 会把命令后的完整文字作为当前群友的人格描述；上限根据启动时最长的内置/外部人格提示词增加 25% 余量，再向上取整到 500 字，当前配置下为 2000 字。选择记录和自定义提示词原文以“QQ群号 + QQ号”为键写入本机的 `data/persona-selections.json`，机器人重启后仍生效。缓存从首次正式使用起只接受当前结构化格式，不包含旧格式迁移逻辑。`重置人格` 或 `恢复主人格` 会删除当前群友在本群的选择并恢复列克星敦主人格。即时闲聊使用当前发言人的选择，冷场闲聊使用最后一名有效发言人的选择。

自定义内容只用于身份、性格、关系、语气和表达习惯，不能覆盖系统任务、事实准确性、安全、隐私或同意规则；随后仍会应用统一的自然演绎规则，因此自定义提示里的固定台词和强制口癖同样只在语境合适时使用。自定义提示词保存在部署机器的本地 JSON 中，请不要提交隐私、密钥或其他敏感内容。

人格数据位于 `config/azur-lane-personas.json`，不打进 exe。开发环境默认从项目的 `config` 目录读取；打包后默认从 exe 同级的 `config` 目录读取。编辑 JSON 后重启机器人即可生效，无需重新打包；也可通过 `PERSONA_CATALOG_FILE` 指定其他文件，通过 `PERSONA_CACHE_FILE` 指定选择缓存位置。两项留空时会使用上述安全默认路径。

新增或维护角色时，每个条目必须完整提供 `id`、`name`、`faction`、`shipRole`、`selfReference`、`userAddress`、`relationship`、`summary`、HTTPS `sourceUrl`、至少一个 `aliases`，以及 `maxAffection.expression` 和大写英文 `maxAffection.promptCode`。结构化人格字段的固定规格是：`tone` 3 项、`speech` 4 项、`personality` 5 项、`likes` 3 项、`dislikes` 3 项、`interaction` 4 项、`reasoning` 3 项、`replyStyle` 4 项、`signature` 2 项、`boundaries` 3 项，再加恰好 15 条大写英文 `promptCodes`。启动时会严格检查字段、数量、重复 ID/别名和提示短码；配置有误时会直接指出条目，不会静默降级成残缺人格。英文短码用于压缩稳定提示前缀，但实际 token 数仍取决于模型分词器。

Local Qwen 的普通问答、主动闲聊和图片问答统一启用强推理，不再按问题类型分级；`LOCAL_QWEN_REASONING_EFFORT` 只接受 `high` 或 `max`，默认 `high` 兼顾推理质量与速度。所有用户可见的 Qwen 回复仍统一使用 `LOCAL_QWEN_MODEL_MAX_OUTPUT_TOKENS` 作为 `max_tokens`，避免隐藏推理耗尽小生成预算后没有正文。后台图片任务是低成本视觉预索引，不只是 OCR：默认使用 `none`、确定性采样和 `detail=high`，通过代理实测支持的 JSON Schema 一次生成逐字转录、文字不确定项，以及图片类型、主体、布局、动作关系、显著细节、文档/界面结构、可能实体和视觉不确定项，不增加推理档位或额外模型调用。配套本地代理会把 `detail=high` 转换成原图总览和最多四个带重叠的放大切片；普通/auto 请求不做切片，因此不会拖慢普通对话。手写、题字、小字号和低清内容会显式标成需要原图复核；可通过 `LOCAL_QWEN_IMAGE_CACHE_REASONING_EFFORT` 和 `LOCAL_QWEN_IMAGE_CACHE_DETAIL` 独立调整预索引。用户直接发送图片提问或引用图片提问时，当前锚点只把原图交给 `high/max` 对话推理，不混入低成本缓存，避免错误 OCR 或实体名称产生锚定；旧上下文图片以及原图加载失败时才使用文字缓存。主动闲聊默认超时相应提高到 30 秒。DeepSeek 回退仍使用自己的输出和推理配置。

Qwen 模式无需附加 `深度思考`，普通对话本身就使用强推理。只有聊天消息明确包含 `联网搜索`、`联网查询` 或 `联网搜搜` 时才进入本地联网搜索工具模式，由模型调用 `web_search` / `web_fetch`，本地 Node 程序执行搜索和网页读取；未命中联网触发词时请求体不提供联网工具，因此不会自行搜索。DeepSeek 回退仍保留原有的 `深度思考` 触发行为。

Qwen 使用专属的多轮研究代理：联网时默认强制 `reasoning_effort=high`，首轮必须搜索，支持并行工具调用，并把 Ollama 返回的 `message.reasoning` 原样带入后续工具回合。默认最多 4 轮、每轮 4 个、整轮 12 个模型工具调用；每条搜索保留 5 个结果、12 个候选，摘要最多 500 字，网页正文最多 6000 字，并预留 48000 token 给研究证据。为避免模型搜索后直接使用摘要作答，控制器会在每条搜索后自动读取一个排名靠前的正文，整轮默认最多 4 页；即使模型没有主动调用 `web_fetch`，成功读取的正文也会进入来源目录和引用校验。复杂问题仍可继续读取其他官方/一手或独立来源并查漏；配置入口为 `LOCAL_QWEN_WEB_*`。这条链路利用 Qwen 的 262144 token 上下文，DeepSeek 回退仍保留原来的 2 轮 × 2 调用和较小证据窗口。

所有联网路径都会根据 QQ 用户原始问题、模型搜索词和结果日期做相关性/时效性重排，并统一使用本地 Ollama 代理一键导入包中的 `web-evidence-research` 证据研究规则。搜索摘要只负责发现线索，关键结论必须读取正文；失败页面和搜索结果页不算证据，高风险信息还会限定地区、版本和日期。回答要求重要事实紧邻标注来源、明确区分事实与推断；如果来源不足、冲突或搜索质量差，会说明无法可靠确认并给出下一步验证方式。

默认 `WEB_SEARCH_PROVIDER=auto` 使用可降级链路：Exa 托管 MCP → Parallel Search MCP → Bing HTML。Exa 请求与 OpenCode 一样启用 `type=auto`、`livecrawl=fallback` 和富上下文；Bot 仍把搜索上下文视为发现线索，并通过控制器自动读取正文后才允许引用。Exa 和 Parallel 都可匿名使用，不依赖本地代理；匿名服务限流、超时或返回空结果时会自动尝试下一家。`web_fetch` 同样优先使用 Exa/Parallel 的正文提取，失败后才调用内嵌 `open-websearch@2.1.11` 和直接抓取。可选的 `EXA_API_KEY`、`PARALLEL_API_KEY` 用于提高额度，`WEB_SEARCH_FALLBACK_PROVIDERS` 可调整顺序；Tavily/Brave 只有在配置对应 Key 并显式加入该列表后才参与降级。显式设置 `WEB_SEARCH_PROVIDER=open-websearch` 时仍可通过 `OPEN_WEBSEARCH_ENGINES` 使用原有内嵌搜索。

Local Qwen 使用群级统一上下文：艾特问答和主动闲聊都会读取当前群最近最多 100 条消息，普通成员消息、图片消息以及机器人自己的回复都计入这 100 条，并按 262144 token 上限裁剪。回退到 DeepSeek 时仍使用原有的当前用户最近 16 条和 12000 字符限制；主动闲聊回退仍只取最近 6 条文本摘要。发送 `清空上下文`、`重置会话` 或 `reset` 会清空当前群的 Qwen 上下文。

Local Qwen 支持 OneBot 图片段和 CQ 图片码。`@机器人` 时可以发送纯图片、图文消息，也可以先发送图片，再回复该图片并艾特机器人提问；缓存未命中时机器人会通过 OneBot `get_msg` 取回被引用的原图。每次模型请求最多保留上下文里最新的 10 张不同图片，并明确标记越新的图片优先级越高；多张原图之间会插入文字分隔，避免视觉后端把连续图片错误合并。机器人收到图片时就会在后台为每张图发起一次独立的 Qwen 单图视觉预索引，同一 URL 或内容哈希相同的图片只索引一次。普通历史上下文优先使用预索引文字以节省视觉 token；当前提问直接携带的图片以及重新引用的图片只发送原图，让高推理对话独立完成人物/物体/场景/空间关系/图表、界面理解和必要的 OCR，不受低成本缓存污染。若原图重新下载失败或超过总大小限制，则安全退回已有预索引。图片下载与索引会执行类型、超时、单图大小和总大小检查。缓存默认保留在当前进程内 12 小时、最多 500 张，可通过 `LOCAL_QWEN_IMAGE_CACHE_*` 配置调整；重启机器人会清空缓存。OpenAI/Ollama 接口不支持导出并重新注入模型内部视觉 embedding，因此这里缓存的是可复用的文字词元，而不是私有的内部视觉向量。DeepSeek 回退链路保持文本模式，图片会转换为 `[图片]` 关联占位符。

Local Qwen 会通过 OneBot `get_forward_msg` 读取合并转发聊天记录，并按原始顺序递归展开、展平其中嵌套的聊天记录；转发内的文字、表情和图片只进入 Qwen 上下文。DeepSeek（包括 Qwen 请求失败后的回退路径）会继续忽略转发记录及由其产生的 Qwen 会话内容。

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
  config/
    azur-lane-personas.json
  .env.example
  start.ps1
  stop.ps1
```

把整个 `release` 目录复制到目标 Windows 10 机器，目标机不需要安装 Node.js。`config/azur-lane-personas.json` 必须与 exe 一起保留在该相对位置；后续只替换或编辑这个文件并重启即可更新人格。第一次运行前，把 `.env.example` 复制或重命名为 `.env`，填好服务器 IP、查询端口、QQ群号等配置。

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
