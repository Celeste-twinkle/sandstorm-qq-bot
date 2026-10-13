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
AI_PRIMARY_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的DeepSeek API Key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VISION_MODEL=deepseek-flash
LOCAL_QWEN_BASE_URL=你的OpenAI兼容Qwen地址/v1
LOCAL_QWEN_API_KEY=你的Local Qwen API Key
LOCAL_QWEN_MODEL=qwen3.6-local
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

开启 AI 聊天后，群里 `@机器人` 且不包含查服关键词的消息默认调用 DeepSeek V4.1 Flash 正式 API：`https://api.deepseek.com/chat/completions`，文字和图片统一使用官方模型名 `deepseek-flash`（见 [DeepSeek 官方文档](https://api-docs.deepseek.com/)）。普通与思考模式均可直接理解图片。DeepSeek 请求失败时，已配置的 Local Qwen 可以接管整轮回复；需要主动优先使用 Qwen 时，设置 `AI_PRIMARY_PROVIDER=local-qwen`。包含 `叛乱`、`沙漠风暴`、`服务器状态`、`ins` 等关键词时仍优先查询服务器状态。

Local Qwen 是可选的备用服务，使用 OpenAI 兼容的 `/chat/completions` 接口和 Bearer 认证。配置后，机器人启动时会立即请求一次 `/models`，之后默认每 10 秒检查一次。显式优先使用 Qwen 时，网络错误、超时或服务端错误会触发整轮请求回退到 DeepSeek，Qwen 恢复后自动切回。健康检查间隔、路径和超时可通过 `LOCAL_QWEN_HEALTH_INTERVAL_MS`、`LOCAL_QWEN_HEALTH_PATH`、`LOCAL_QWEN_HEALTH_TIMEOUT_MS` 调整。

列克星敦仍是默认人格。每次普通问答、即时闲聊和冷场闲聊，都以当前时间顺序里最后一位群成员的设置为准：该成员在本群设置了碧蓝航线或自定义人格就用其设置，没有设置就使用默认人格；机器人自己的消息不改变人格归属，其他成员的设置与历史回复语气也不继承。默认人格分别读取 `DEEPSEEK_SYSTEM_PROMPT` 和 `LOCAL_QWEN_SYSTEM_PROMPT`。Qwen 的对话理解和长度控制可分别通过 `LOCAL_QWEN_DIALOGUE_PROMPT`、`LOCAL_QWEN_CONCISE_PROMPT` 调整。`RESPONSE_NEUTRALITY_PROMPT` 与统一的自然聊天规则保持启用，组成各类回复共用的稳定前缀；动态群聊内容放在后续消息中，以便提高服务端前缀缓存命中率。

## 碧蓝航线人格

外部目录现有 48 名高质量角色，按白鹰、皇家、重樱、铁血、东煌、北方联合、自由鸢尾、维希教廷和撒丁帝国分组。每名角色都包含性格、语气、措辞、交互方式、推理方式、偏好、禁忌、代表性表达和来源，不是仅替换角色名。关系基线统一为游戏中的“爱/100”满好感：当前群友已是她熟悉、信赖的指挥官，不会从路人或初见状态开场；满好感不自动等同已誓约。高风险或偏执特征只保留为安全的角色语气，不允许现实威胁、控制、跟踪、伤害、强迫或诱导依赖。

所有人格（包括列克星敦主人格）都会追加统一的自然演绎规则：保留角色的核心性格、价值取向、情感关系、措辞节奏和整体语气，但不把官方台词、口癖、名场面、舰船/战斗意象或条目中的代表性表达当作必用模板。即使旧人格块要求固定台词、强制口癖、每句固定结尾或反复自称，也以这条新规则为准并降级为可选。只有与当前语境自然贴合时才偶尔引用或化用，不合适时完全不用；回答应原创、具体并直接解决当前问题，避免机械复读和强塞角色梗。可通过 `PERSONA_FLEXIBILITY_PROMPT` 调整这条全局规则。

默认列克星敦人格已取消固定自称、频繁问候、每句表情和一味附和的要求。统一聊天规则鼓励自然短句、具体接话、贴合语境的吐槽与自己的判断，避免客服式开场、无条件安慰、习惯性追问、舞台动作描写和重复上一轮的句式；认真提问仍需把关键点讲清楚。可通过 `NATURAL_CHAT_PROMPT` 调整统一表达规则，默认非思考模式温度为 `0.9`。

默认人格现在使用三段中文描述保留列克星敦的身份、温和成熟的性格与背景偏好。聊天规则区分玩笑、吐槽、提问和收尾：不需要每次安慰、叮嘱、比喻或给方案；表达风格参考群成员，自身历史只用于承接内容，不继续学习旧回复的口癖。群消息保留原有 50 条与时间顺序，提示文本仅标出当前锚点，历史 bot 回复直接使用实际发送的文字，减少容易被模仿的标签和逐条数字权重。`@机器人 人格查询 列克星敦` 可查看更新后的默认人格说明。

这轮提示词调整参考了 [MaiBot 的回复模板与风格学习](https://github.com/Mai-with-u/MaiBot/tree/6260d473780afefe58049899cdf051897c3dd06c/prompts/zh-CN)、[Group Chat Plus 的回复职责划分](https://github.com/Him666233/astrbot_plugin_group_chat_plus/blob/aa97e0e35a18733e73db753238dd2a3021446e42/web/static/js/prompt-data.js) 和 [NekroAgent 的人格与事实边界](https://github.com/KroMiose/nekro-agent/blob/ea7b90eb83bd80061b2a177510c27c957f7f980d/nekro_agent/services/agent/templates/j2_zh/persona.j2)。实现使用本项目自己的提示词；来源与实测分别保存在 `reports/deepseek-prompt-ab/research.json` 与 `comparison.json`。本轮 10 类场景、每类 2 轮的主观对照中，新版胜 11 对、旧版胜 3 对、6 对持平，输入 token 减少约 55%；结果来自合成场景与单一评审，不代表所有真实群聊效果。

本次语气调整进一步强调具体反应、朴素的偏好和判断：被纠正时直接改口，分享开心时能高兴，认真失落时不硬找好处；明确求助仍需讲全必要内容。`reports/deepseek-chat-natural-v4/comparison.json` 保留 24 类场景、每类 2 轮的提示词对照：新版胜 13 对、旧版胜 10 对、25 对持平，总 token 增加约 3.1%。优势较小，且切题分没有同步提高，不能据此声称已消除 NPC 感；仍有无依据的细节，因此另行加入下述按需搜索与坦承不确定的路径。

复测提示词时，先在修改前运行 `node scripts/compare-chat-prompts.js snapshot 2 reports/新对照目录` 保存旧版快照；修改后运行 `node scripts/compare-chat-prompts.js run 2 reports/新对照目录`，会输出完整请求记录、token 与耗时，以及隐藏版本标签的成对回复。目前包含 14 类 50 条上下文场景和 10 类不重复填充的短上下文场景。此脚本只比较生成提示词，不启用参与判断或联网工具；按需搜索另用 `node scripts/check-automatic-search.js reports/新搜索对照目录` 实测，默认使用真实模型和固定的模拟网页证据，追加 `--live` 会再查询一次真实的公开官网。两个脚本都不连接 QQ，也不改变默认思考配置。

普通聊天默认保持 `DEEPSEEK_THINKING_ENABLED=false`，明确输入“深度思考”时仍启用推理。调整默认思考强度前，可以运行 `node scripts/compare-deepseek-chat.js 2 reports/另一次对照`：脚本使用相同提示词与 50 条合成群消息，比较关闭思考与 `max`，保存实际 API token、缓存命中、耗时、完整回复和隐藏分组标签的评审材料，不连接 QQ、不改变运行配置。两组统一使用 8192 token 上限，避免推理被短回复预算截断；隐藏推理正文不保存。思考模式的 `temperature` 不生效，因此比较的是实际模式切换，不声称采样参数完全相同。NPC 感需结合切题程度做主观评审，不能只看回复长短或推理 token。

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

默认 `WEB_SEARCH_AUTO_ENABLED=true`：DeepSeek 与 Qwen 的正文生成都提供可选的 `web_search` / `web_fetch`，由模型决定是否使用。普通聊天、群内已有答案和个人偏好可以直接回应；需要核实的公开事实可以搜索；对象不明时可以问清，也允许直接说不清楚。用户明确要求不搜索时由模型按该要求直接回复。模型没有选择工具时只有原本的一轮生成请求，附加的工具说明会增加输入 token；选择搜索后才执行辅助搜索请求与后续生成。只有网址或标题、没有可用引用片段或正文时，自动路径会简短说明尚不确定。设置为 `false` 后恢复仅由联网关键词触发的手动模式。

旧搜索链路的实测与限制记录在 `reports/automatic-search-chat-v4/review.json`。当时同一组 50 条群消息的成本检查中，提供可选搜索让单次输入从 1645 增至 2325 token（增加 680，约 41.3%），两次均未搜索、各用一轮生成；这是旧工具定义与提示词的单一样本，不能当作当前 Harness 搜索或所有聊天的平均成本。缓存命中不等于免费 token。未明确要求搜索的事实提问，也可以直接承认未知，补充样本在 `reports/automatic-search-unprompted-v4/`。

按需搜索默认最多 2 轮、每轮 2 个工具调用，主聊天沿用原回复的推理设置，DeepSeek 默认仍关闭思考。普通闲聊保留原输出预算，取得可用引用片段或正文后为来源链接预留至少 512 个输出 token。每次 `web_search` 可含 1–4 个查询，准确重复的查询合并，并发搜索后按各查询排名轮流合并，默认最多保留 8 个来源；其中任一查询失败就取消其余查询并返回整批失败。搜索数量和超时由 `WEB_SEARCH_MAX_QUERIES`、`WEB_SEARCH_MAX_RESULTS`、`WEB_SEARCH_TIMEOUT_MS` 控制。没有旧链路的搜索词扩写、相关性重排或自动抓取。

默认 `WEB_SEARCH_PROVIDER=deepseek-official` 移植 [DeepSeek Harness 官方实现](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/web)，固定到该提交并保留 MIT 许可。它不是打开可交互浏览器，而是向 `https://api.deepseek.com/anthropic/v1/messages` 发送带 `web_search_20250305` 原生服务端工具的 Messages 请求，复用 `DEEPSEEK_API_KEY`。`DEEPSEEK_SEARCH_BASE_URL` 独立于聊天地址；搜索模型采用官方 Harness 的 Anthropic 名称 `deepseek-v4-flash`，主聊天仍使用 `deepseek-flash`。仅提取结构化来源，并按 URL 关联 `cited_text`，丢弃搜索模型自行生成的说明和内部思考。引用片段足够时可以直接回答，需要详情时再调用 `web_fetch`，答案附实际使用的来源链接。网页内容作为不可信资料，不能改变聊天任务。

官方搜索的每条查询额外消耗一次模型请求，默认 `DEEPSEEK_SEARCH_MAX_TOKENS=4096`、`DEEPSEEK_SEARCH_MAX_USES=5`，搜索模型自身可能返回思考块；这是辅助搜索的官方协议，不会提高主聊天思考强度。辅助请求的输入、缓存读取、输出 token 和服务端搜索次数单独记录到日志。2026-10-13 的首次原生接口实测为 HTTP 200：2467 个输入 token（含 256 缓存读取）、504 个输出 token、1 次服务端搜索，仅代表该查询。真实聊天、搜索、网页读取及打包验证见 `reports/deepseek-harness-native/review.json`。可运行 `node scripts/check-deepseek-harness.js reports/新的目录` 复测；它使用合成对话和真实 API，会消耗 token，不连接 QQ。

`web_fetch` 同样移植官方 HTTP 读取和 Markdown 转换，支持直接读取用户给出的公开网址。每次解析并固定公网 IP，仅跟随同源重定向，不携带浏览器 Cookie，不执行页面 JavaScript。HTML 转为保留链接、表格、删除线的 Markdown，移除脚本和隐藏内容；读取默认限 5,000,000 字节、正文 100,000 字符、输出 200,000 字符、30 秒，分别用 `WEB_FETCH_MAX_RESPONSE_BYTES`、`WEB_FETCH_MAX_BODY_CHARS`、`WEB_FETCH_MAX_OUTPUT_CHARS`、`WEB_FETCH_TIMEOUT_MS` 调整。非 2xx 响应可见但不算证据。官方模式使用直接公网连接；本机代理/TUN 返回内网或 fake IP 时会拒绝抓取，旧 `OPEN_WEBSEARCH_FAKE_IP_CIDRS` 设置不会放宽这条限制。移植范围与重建方式见 `src/vendor/deepseek-harness/VENDOR-NOTES.md`。

Qwen 自动路径沿用普通聊天的推理与输出预算。手动模式下，Qwen 的明确联网请求仍使用多轮研究代理：默认 `reasoning_effort=high`，首轮搜索，最多 4 轮、每轮 4 个、整轮 12 个模型工具调用，保留原始 reasoning 回传及正文引用编号校验。它使用同一套官方搜索和网页工具，但仍要求先取得正文再给出研究结论。旧候选池、摘要截取和自动抓取配置仅对旧提供方生效。

旧链路保留为显式选项：设置 `WEB_SEARCH_PROVIDER=auto` 可使用 Exa 托管 MCP → Parallel Search MCP → Bing HTML；`open-websearch` 可使用原内嵌搜索。官方搜索失败不会自动改用这些提供方。旧链路的排序、正文自动抓取、`WEB_SEARCH_FALLBACK_PROVIDERS` 和可选 Exa/Parallel/Tavily/Brave Key 仍按原配置工作。

DeepSeek 和 Local Qwen 使用同一份群级上下文：艾特问答、即时闲聊和冷场闲聊默认读取当前群最近 50 条消息。成员文字、表情、图片消息与机器人实际发送的回复一起计数，超过 50 条删除时间最早的记录；消息按 OneBot 发送时间从旧到新排列，同一时间的消息保持接收顺序。上下文不再因冷场或会话超时自动清空，也不额外叠加个人聊天历史。bot 的长回复按 QQ 实际发送的分段逐条记录，发送失败的分段不计入，收到自身消息回传时按消息 ID 去重。各个消息数量配置均有 50 条硬上限；极长内容仍受模型上下文预算及 `CHAT_MAX_CONTEXT_CHARS`（默认 64000 字符）保护，裁剪时保留当前人格与最新消息。发送 `清空上下文`、`重置会话` 或 `reset` 会清空当前群的共享上下文。

Local Qwen 与 DeepSeek 都支持 OneBot 图片段和 CQ 图片码。`@机器人` 时可以发送纯图片、图文消息，也可以先发送图片，再回复该图片并艾特机器人提问；缓存未命中时机器人会通过 OneBot `get_msg` 取回被引用的原图。每次模型请求最多保留上下文里最新的 10 张不同图片，并明确标记越新的图片优先级越高；多张原图之间会插入文字分隔，避免视觉后端把连续图片错误合并。Local Qwen 收到图片时仍会执行单图 OCR/视觉预索引；DeepSeek 则改为按需 OCR，只有最新问题明确要求 OCR、提取/读取图片文字或翻译图片文字时才发起独立转录，普通场景与物体识别只进行一次视觉推理。DeepSeek OCR 后会按图片内容哈希缓存转录，并让同一轮正式回答直接使用缓存文本，不重复发送相同像素；Qwen 与 DeepSeek 共用进程内缓存，因此已有 Qwen OCR 时也不会重复调用 DeepSeek OCR。同一 URL 或内容哈希相同的图片只缓存一次。若原图重新下载失败或超过大小限制，则安全退回已有缓存。图片下载与索引会执行类型、超时、单图大小和总大小检查。缓存默认保留在当前进程内 12 小时、最多 500 张，可分别通过 `LOCAL_QWEN_IMAGE_CACHE_*` 与 `DEEPSEEK_IMAGE_CACHE_*` 调整；重启机器人会清空缓存。缓存保存的是可复用文字，不是模型内部视觉向量。

Local Qwen 会通过 OneBot `get_forward_msg` 读取合并转发聊天记录，并按原始顺序递归展开嵌套内容。需要读取当前合并转发原文的回复由 Qwen 处理，原始转发文字与图片仍只进入 Qwen 上下文。DeepSeek 的群级记录保留转发消息占位以及 bot 实际发出的回答，均计入 50 条。

QQ 内置表情、超级表情、骰子和猜拳会转换成带含义的上下文标签，例如 `[QQ表情：笑哭]`、`[骰子：6 点]`；商城表情或 NapCat 转换出的表情图片会同时保留摘要和可用图片，由 Qwen 结合语义与视觉理解。未知表情 ID 只保留 ID，不猜测名称。单独发送这些表情也能进入群级上下文并触发主动闲聊。

未 `@机器人` 的群聊采用“先判断、再接话”：先让 AI 读取当前人格与最近最多 50 条共享群消息，返回 JSON 布尔值 `should_reply`；为真才调用正文生成，为假则安静结束。即时消息与 `AMBIENT_CHAT_IDLE_SECONDS` 秒后的冷场检查使用同一条判断链路，冷场不再保证回复，也不再使用 `AMBIENT_CHAT_PROBABILITY` 随机抽签。单字、数字、较长文字和收尾消息也交由 AI 结合上下文判断，而不靠关键词或长度硬过滤。`@机器人` 的明确问答、查服与人格命令继续走相应入口。

没点名问 bot 时，即使群里有问句或需要查证的事实，也允许不接，不必为了插话先搜索。直接承接 bot 上一句的追问仍视为正在对话，可以继续回答、问清对象或坦承不知道。参与判断本身不提供搜索工具；只有决定参与后的正文模型才能选择搜索。

判断请求不启用思考，默认只允许 64 个输出 token、10 秒超时；通过 `AMBIENT_CHAT_JUDGE_MAX_OUTPUT_TOKENS`、`AMBIENT_CHAT_JUDGE_TIMEOUT_MS` 和 `AMBIENT_CHAT_JUDGE_PROMPT` 调整。判断只读文字、表情含义与图片/转发标签，不为判断额外下载图片；需要视觉理解的正文回复仍使用图片处理路径。判断结果错误或服务不可用时保持安静，避免误把错误当成“必须接话”。决定接话时会多一轮 API 请求，判断为不接时不会生成正文。

群级冷却和并发保护用于限制刷屏：每个群同时最多一条闲聊判断/生成；新消息或其他 bot 回复到来后，旧判断失效，不再生成或发送过时的闲聊。冷却从实际回复发送成功后开始，决定不接话不会消耗回复冷却。最近 50 条消息的计数包含实际发出的 bot 回复，内部判断 JSON 不写入群聊历史。`AMBIENT_CHAT_CONTEXT_SECONDS` 仅影响引用消息查找缓存，不使共享群聊上下文过期。

两条 AI 路径的群上下文均采用相同的新旧优先级：最后一条群成员消息是本次回应锚点，越近的消息优先用于理解它。历史关联按语义判断，例如明确指代、同一对象/事件、条件修正、因果延续、语义承接或图片内容关联；QQ 回复/引用标记用于定位文字或图片，本身不构成关联证据。冷场闲聊同样围绕最新话题，不复活无关旧话题。

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
