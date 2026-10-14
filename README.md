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

所有群员统一使用大肥鱼（小鲸鱼）默认角色，普通问答、即时闲聊与冷场闲聊都不再按群员切换人格。人格目录、查询/切换/自定义命令及个人选择缓存已移除，启动不依赖外部角色文件。`DEEPSEEK_SYSTEM_PROMPT` 和 `LOCAL_QWEN_SYSTEM_PROMPT` 留空时读取 `src/persona.js` 的同一默认提示词；旧部署中写死的列克星敦提示词需要清空这两项后重启。Qwen 的对话理解和长度控制仍可用 `LOCAL_QWEN_DIALOGUE_PROMPT`、`LOCAL_QWEN_CONCISE_PROMPT` 调整。

## 大肥鱼群聊提示词

默认角色以原本为 QQ 群聊设计的 [QQ Agent 小鲸鱼角色卡](https://github.com/K0nd1us/QQ-agent/blob/main/src/personas.js)、[群聊规则](https://github.com/K0nd1us/QQ-agent/blob/main/src/prompt.js) 和 [AstrBot QQ 群友版](https://github.com/mtshang/make-your-qq-ai-group-member/blob/main/templates/persona_dafeiyu.md) 为主要参考，按本项目的实际能力改写。两套群友卡有共同来源，不能视为独立效果验证。选择依据是多人指向、引用理解、群文化适应、性格一致性、实用问答和搜索表达的质量；仓库 Stars 只是辅助信息，完整比较见 `reports/whale-group-learning-20261014/research.json`。

保留聪明、贪吃、摸鱼和轻微傲娇的性格，用一张简短角色卡表达。闲聊以活人感为重点，可以起哄、瞎扯、吹牛、接梗、表达自己的情绪，不把聊天当考试；短词、笑声和随口一句都可以，不固定字数或每句的台词。明确要求查资料、算数或写代码时照具体任务处理，搜索材料读懂后用同一个群聊口吻讲出来。原文的长篇台词库没有作为已发生的聊天插入。

“偏短，一般懒得打字”是性格倾向，长句短句都允许，也允许复读其他群友。程序对照最近50条里的实际 assistant 发言，拦截自己的整句重复（忽略空白和末尾标点），不以真人消息作为去重对象，不裁切长度、不检查闲聊事实，也不另请求模型重写。人设和接话判断引导避免反复说自己的旧笑点。实验性同义复读审核 `GROUP_CHAT_SELF_REPEAT_CHECK_ENABLED` 默认关闭：真实对照中它把“喜欢哪个”之后的“哪个更耐看”也判成复读，误伤正常追问；原始失败样本保存在 `reports/whale-group-learning-20261014/npc/self-repeat-final/`。

`PERSONA_FLEXIBILITY_PROMPT` 与 `NATURAL_CHAT_PROMPT` 是可选附加提示，留空不再加入内置表达限制。默认角色只写一次，末尾只按需加入本群学习内容；旧的表达禁令、现实经历核验和重复身份提醒已移除。`RESPONSE_NEUTRALITY_PROMPT` 仍按现有配置使用。上下文按时间保留最近 50 条群员和 bot 实际消息，当前锚点只定位最近真人发言。

完整指令菜单可发送 `@机器人 帮助` 或 `@机器人 指令`，也支持 `help`、`/help`、`使用说明`、`功能`、`菜单`、`全部指令`，包含查服、对话、识图、联网、学习状态、学习重置、上下文重置与无需艾特的 Bilibili 链接入口。

普通聊天默认仍为 `DEEPSEEK_THINKING_ENABLED=false`，明确输入“深度思考”时开启推理。群聊学习使用独立的思考配置，不改变正常回复的默认模式。提示词对照可使用 `scripts/compare-chat-prompts.js`，思考模式对照可使用 `scripts/compare-deepseek-chat.js`；这些脚本不会连接 QQ。

Local Qwen 的普通问答、主动闲聊和图片问答统一启用强推理，不再按问题类型分级；`LOCAL_QWEN_REASONING_EFFORT` 只接受 `high` 或 `max`，默认 `high` 兼顾推理质量与速度。所有用户可见的 Qwen 回复仍统一使用 `LOCAL_QWEN_MODEL_MAX_OUTPUT_TOKENS` 作为 `max_tokens`，避免隐藏推理耗尽小生成预算后没有正文。后台图片任务是低成本视觉预索引，不只是 OCR：默认使用 `none`、确定性采样和 `detail=high`，通过代理实测支持的 JSON Schema 一次生成逐字转录、文字不确定项，以及图片类型、主体、布局、动作关系、显著细节、文档/界面结构、可能实体和视觉不确定项，不增加推理档位或额外模型调用。配套本地代理会把 `detail=high` 转换成原图总览和最多四个带重叠的放大切片；普通/auto 请求不做切片，因此不会拖慢普通对话。手写、题字、小字号和低清内容会显式标成需要原图复核；可通过 `LOCAL_QWEN_IMAGE_CACHE_REASONING_EFFORT` 和 `LOCAL_QWEN_IMAGE_CACHE_DETAIL` 独立调整预索引。用户直接发送图片提问或引用图片提问时，当前锚点只把原图交给 `high/max` 对话推理，不混入低成本缓存，避免错误 OCR 或实体名称产生锚定；旧上下文图片以及原图加载失败时才使用文字缓存。主动闲聊默认超时相应提高到 30 秒。DeepSeek 回退仍使用自己的输出和推理配置。

默认 `WEB_SEARCH_AUTO_ENABLED=true`：DeepSeek 与 Qwen 的正文生成都提供可选的 `web_search` / `web_fetch`，由模型决定是否使用。普通聊天、群内已有答案和个人偏好可以直接回应；需要核实的公开事实可以搜索；对象不明时可以问清，也允许直接说不清楚。用户明确要求不搜索时由模型按该要求直接回复。模型没有选择工具时只有原本的一轮生成请求，附加的工具说明会增加输入 token；选择搜索后才执行辅助搜索请求与后续生成。只有网址或标题、没有可用引用片段或正文时，自动路径会简短说明尚不确定。设置为 `false` 后恢复仅由联网关键词触发的手动模式。

旧搜索链路的实测与限制记录在 `reports/automatic-search-chat-v4/review.json`。当时同一组 50 条群消息的成本检查中，提供可选搜索让单次输入从 1645 增至 2325 token（增加 680，约 41.3%），两次均未搜索、各用一轮生成；这是旧工具定义与提示词的单一样本，不能当作当前 Harness 搜索或所有聊天的平均成本。缓存命中不等于免费 token。未明确要求搜索的事实提问，也可以直接承认未知，补充样本在 `reports/automatic-search-unprompted-v4/`。

按需搜索默认最多 2 轮、每轮 2 个工具调用，主聊天沿用原回复的推理设置，DeepSeek 默认仍关闭思考。轮次只计算实际调用了工具的回合。原生搜索只返回标题和网址时，工具会明确提示先读取正文；如果模型提前作答且仍有工具预算，最多补一次纠正提示，由模型决定是否继续读取，不增加工具轮数，也不把未核实的草稿发到群里。仍未取得证据时承认不确定。普通闲聊保留原输出预算，取得可用引用片段或正文后为来源链接预留至少 512 个输出 token。每次 `web_search` 可含 1–4 个查询，准确重复的查询合并，并发搜索后按各查询排名轮流合并，默认最多保留 8 个来源；其中任一查询失败就取消其余查询并返回整批失败。搜索数量和超时由 `WEB_SEARCH_MAX_QUERIES`、`WEB_SEARCH_MAX_RESULTS`、`WEB_SEARCH_TIMEOUT_MS` 控制。没有旧链路的搜索词扩写、相关性重排或自动抓取。

排查“没查到可靠消息”时，日志中的 `no_evidence_model_stop` 表示模型在取得正文前停止，`no_evidence_budget` 才表示用完了工具轮次；同时记录工具错误码、HTTP 状态、是否取得证据和是否触发纠正，不记录群聊原文或密钥。DeepSeek 出圈时间问题的复现、同样前缀下的 2/4 轮对照和修复后复测保存在 `reports/deepseek-search-diagnosis-20261014/`。可用 `node scripts/diagnose-search-rounds.js reports/新目录/rounds.json` 复测，使用真实 API 并消耗 token，不连接 QQ。

默认 `WEB_SEARCH_PROVIDER=deepseek-official` 移植 [DeepSeek Harness 官方实现](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/web)，固定到该提交并保留 MIT 许可。它不是打开可交互浏览器，而是向 `https://api.deepseek.com/anthropic/v1/messages` 发送带 `web_search_20250305` 原生服务端工具的 Messages 请求，复用 `DEEPSEEK_API_KEY`。`DEEPSEEK_SEARCH_BASE_URL` 独立于聊天地址；搜索模型采用官方 Harness 的 Anthropic 名称 `deepseek-v4-flash`，主聊天仍使用 `deepseek-flash`。仅提取结构化来源，并按 URL 关联 `cited_text`，丢弃搜索模型自行生成的说明和内部思考。引用片段足够时可以直接回答，需要详情时再调用 `web_fetch`，答案附实际使用的来源链接。网页内容作为不可信资料，不能改变聊天任务。

官方搜索的每条查询额外消耗一次模型请求，默认 `DEEPSEEK_SEARCH_MAX_TOKENS=4096`、`DEEPSEEK_SEARCH_MAX_USES=5`，搜索模型自身可能返回思考块；这是辅助搜索的官方协议，不会提高主聊天思考强度。辅助请求的输入、缓存读取、输出 token 和服务端搜索次数单独记录到日志。2026-10-13 的首次原生接口实测为 HTTP 200：2467 个输入 token（含 256 缓存读取）、504 个输出 token、1 次服务端搜索，仅代表该查询。真实聊天、搜索、网页读取及打包验证见 `reports/deepseek-harness-native/review.json`。可运行 `node scripts/check-deepseek-harness.js reports/新的目录` 复测；它使用合成对话和真实 API，会消耗 token，不连接 QQ。

`web_fetch` 同样移植官方 HTTP 读取和 Markdown 转换，支持直接读取用户给出的公开网址。每次解析并固定公网 IP，仅跟随同源重定向，不携带浏览器 Cookie，不执行页面 JavaScript。HTML 转为保留链接、表格、删除线的 Markdown，移除脚本和隐藏内容；读取默认限 5,000,000 字节、正文 100,000 字符、输出 200,000 字符、30 秒，分别用 `WEB_FETCH_MAX_RESPONSE_BYTES`、`WEB_FETCH_MAX_BODY_CHARS`、`WEB_FETCH_MAX_OUTPUT_CHARS`、`WEB_FETCH_TIMEOUT_MS` 调整。非 2xx 响应可见但不算证据。官方模式使用直接公网连接；本机代理/TUN 返回内网或 fake IP 时会拒绝抓取，旧 `OPEN_WEBSEARCH_FAKE_IP_CIDRS` 设置不会放宽这条限制。移植范围与重建方式见 `src/vendor/deepseek-harness/VENDOR-NOTES.md`。

Qwen 自动路径沿用普通聊天的推理与输出预算。手动模式下，Qwen 的明确联网请求仍使用多轮研究代理：默认 `reasoning_effort=high`，首轮搜索，最多 4 轮、每轮 4 个、整轮 12 个模型工具调用，保留原始 reasoning 回传及正文引用编号校验。它使用同一套官方搜索和网页工具，但仍要求先取得正文再给出研究结论。旧候选池、摘要截取和自动抓取配置仅对旧提供方生效。

旧链路保留为显式选项：设置 `WEB_SEARCH_PROVIDER=auto` 可使用 Exa 托管 MCP → Parallel Search MCP → Bing HTML；`open-websearch` 可使用原内嵌搜索。官方搜索失败不会自动改用这些提供方。旧链路的排序、正文自动抓取、`WEB_SEARCH_FALLBACK_PROVIDERS` 和可选 Exa/Parallel/Tavily/Brave Key 仍按原配置工作。

DeepSeek 和 Local Qwen 使用同一份群级上下文：艾特问答、即时闲聊和冷场闲聊读取当前群最近 50 条消息。成员文字、表情、图片消息与机器人实际发送的回复一起计数，超过 50 条删除时间最早的记录；消息按 OneBot 发送时间从旧到新排列，同一时间的消息保持接收顺序。上下文不再因冷场或会话超时自动清空，也不额外叠加个人聊天历史。bot 的长回复按 QQ 实际发送的分段逐条记录，发送失败的分段不计入，收到自身消息回传时按消息 ID 去重。非艾特的判断、正文生成和草稿检查使用同一份最近 50 条记录；旧的 `AMBIENT_CHAT_INSTANT_MAX_MESSAGES`、`AMBIENT_CHAT_IDLE_MAX_MESSAGES` 与 `LOCAL_QWEN_MAX_HISTORY_MESSAGES` 不再缩短共享群记录，后者只控制 Qwen 独立会话历史。极长内容仍受模型上下文预算及 `CHAT_MAX_CONTEXT_CHARS`（默认 64000 字符）保护，裁剪时保留默认角色与最新消息。发送 `清空上下文`、`重置会话` 或 `reset` 会清空当前群的共享上下文。

Local Qwen 与 DeepSeek 都支持 OneBot 图片段和 CQ 图片码。`@机器人` 时可以发送纯图片、图文消息，也可以先发送图片，再回复该图片并艾特机器人提问；缓存未命中时机器人会通过 OneBot `get_msg` 取回被引用的原图。每次模型请求最多保留上下文里最新的 10 张不同图片，并明确标记越新的图片优先级越高；多张原图之间会插入文字分隔，避免视觉后端把连续图片错误合并。Local Qwen 收到图片时仍会执行单图 OCR/视觉预索引；DeepSeek 则改为按需 OCR，只有最新问题明确要求 OCR、提取/读取图片文字或翻译图片文字时才发起独立转录，普通场景与物体识别只进行一次视觉推理。DeepSeek OCR 后会按图片内容哈希缓存转录，并让同一轮正式回答直接使用缓存文本，不重复发送相同像素；Qwen 与 DeepSeek 共用进程内缓存，因此已有 Qwen OCR 时也不会重复调用 DeepSeek OCR。同一 URL 或内容哈希相同的图片只缓存一次。若原图重新下载失败或超过大小限制，则安全退回已有缓存。图片下载与索引会执行类型、超时、单图大小和总大小检查。缓存默认保留在当前进程内 12 小时、最多 500 张，可分别通过 `LOCAL_QWEN_IMAGE_CACHE_*` 与 `DEEPSEEK_IMAGE_CACHE_*` 调整；重启机器人会清空缓存。缓存保存的是可复用文字，不是模型内部视觉向量。

Local Qwen 会通过 OneBot `get_forward_msg` 读取合并转发聊天记录，并按原始顺序递归展开嵌套内容。需要读取当前合并转发原文的回复由 Qwen 处理，原始转发文字与图片仍只进入 Qwen 上下文。DeepSeek 的群级记录保留转发消息占位以及 bot 实际发出的回答，均计入 50 条。

QQ 内置表情、超级表情、骰子和猜拳会转换成带含义的上下文标签，例如 `[QQ表情：笑哭]`、`[骰子：6 点]`；商城表情或 NapCat 转换出的表情图片会同时保留摘要和可用图片，由 Qwen 结合语义与视觉理解。未知表情 ID 只保留 ID，不猜测名称。单独发送这些表情也能进入群级上下文并触发主动闲聊。

未 `@机器人` 的群聊采用“先判断、再接话”：先让 AI 读取当前人格与最近最多 50 条共享群消息，按当前兴致决定自己想不想接话，返回 JSON 布尔值 `should_reply`；为真才调用正文生成，为假则安静结束。兴趣、共鸣、好奇和想接的梗都可以成为主动参与的理由，没被点名、不是求助或没有新知识可提供不再直接压低参与意愿；也允许有话可接却暂时不想说。心情从人格、聊天气氛和最近实际发言中延续，不设置随机心情值或固定参与率。即时消息与 `AMBIENT_CHAT_IDLE_SECONDS` 秒后的冷场检查使用同一条判断链路，冷场不保证回复，也不使用 `AMBIENT_CHAT_PROBABILITY` 抽签。明确要求不回复、私人事务、重复刷屏和已结束的话题仍保留留白。`@机器人` 的明确问答、查服与学习命令继续走相应入口。

没点名问 bot 时，即使群里有问句或需要查证的事实，也允许不接，不必为了插话先搜索。直接承接 bot 上一句的追问仍视为正在对话，可以继续回答、问清对象或坦承不知道。参与判断本身不提供搜索工具；只有决定参与后的正文模型才能选择搜索。

主动插话先看整段讨论有什么让大肥鱼感兴趣的地方：想吐槽、接梗、起哄、说偏好或好奇问一句，都可以加入。两三位群友互相聊天、艾特其他人、没有问句或没有提到 bot，不构成沉默条件。无艾特的真实模型对照及推理期间消息积累验证见 `reports/whale-group-learning-20261014/npc/proactive-interest-final/`，可运行 `node scripts/check-proactive-group-chat-live.js reports/新目录` 复测，不连接真实 QQ。

判断请求不启用思考，默认只允许 64 个输出 token、10 秒超时，采样温度为 0.5；通过 `AMBIENT_CHAT_JUDGE_MAX_OUTPUT_TOKENS`、`AMBIENT_CHAT_JUDGE_TIMEOUT_MS`、`AMBIENT_CHAT_JUDGE_TEMPERATURE` 和 `AMBIENT_CHAT_JUDGE_PROMPT` 调整。温度影响 AI 判断的采样，不代表回复概率。判断只读文字、表情含义与图片/转发标签，不为判断额外下载图片；需要视觉理解的正文回复仍使用图片处理路径。判断结果错误或服务不可用时保持安静，避免误把错误当成“必须接话”。决定接话时会多一轮 API 请求，判断为不接时不会生成正文。提示词对照与聊天兴致样本见 `reports/ambient-mood-final-20261014/`；这些合成样本不代表实际群聊插话率。

参与判断把最近群消息作为带角色的 JSON 资料传入，避免把历史 bot 正文当成 JSON 输出示范。此前 100 条连续群聊实测中出现过空白判断；[DeepSeek 官方文档](https://api-docs.deepseek.com/guides/json_mode/)也说明 JSON 模式偶尔可能返回空内容。现在的完整模拟会单独检查每次判断是否合法，不能把接口异常记成正常的“看心情不接”。

默认 `AMBIENT_CHAT_DRAFT_REVIEW_ENABLED=false`，生成后只做本地的自身原句去重，再发送正文；不额外核验闲聊事实或审查接梗。需要时可显式设为 `true` 开启可选草稿检查，只看是否顺口、当前不用回或私人事务；吹牛、拟人、夸张不作为扣分理由。可选删改仍只删除原稿词句，不重写重试。只有成功发送的文字进入 50 条群记录，判断和检查 JSON 不计入。

接话判断按角色、气氛和兴致决定，公共闲聊不用等艾特，也不按正确性或信息增量挑选。正在追问机器人时优先接住。自己刚说过同一件事可以继续聊，也可以先听，不设置固定参与率；当前明确不用回、两个人处理私事和已经散场仍留白。过去某件事的“不用回”不会让后来的公共聊天永久禁言。

程序不再在消息末尾复述人格或附加表达清单，也不裁切正文来满足短句目标。新版限制对照与完整群聊模拟见 `reports/whale-group-learning-20261014/npc/`；评估闲聊的情绪、主张、互动和模板感，不能靠正确率、少说话或字数短宣称更像活人。

此前侧重事实边界的微调与 100 条群聊复测保存在 `reports/group-chat-natural-v4-20261014/`，用于保留历史实验记录。现行闲聊采用上面的宽松角色卡，不再以这些旧边界筛选生成内容。

这轮语气与接话验证保存在 `reports/group-chat-natural-20261014/`：包括冻结历史上的提示词对照、独立边界样本和同一组 12 人、100 条消息的完整复测。`node scripts/compare-group-turn-taking.js snapshot <旧 run.json> <快照目录>` 可保存对照输入；改提示词后运行 `node scripts/compare-group-turn-taking.js run <快照目录> <新结果目录>` 进行真实 API 对照，不连接 QQ、不启用思考或搜索。短回复、少回复都不能单独证明更自然，最终仍需看完整对话和是否漏接明确追问。

后续删减方案的对照与完整复测保存在 `reports/group-chat-natural-v2-20261014/`。`node scripts/compare-ambient-editing.js <旧布尔检查 run.json> <新结果目录>` 比较同一草稿的保留/拒绝与删减方案，记录实际 token；可额外传入场景 JSON 文件只测试指定样本。程序保护是保守的，删除整句否定表达也可能使草稿被放弃，仍需人工审阅误删与漏删，不能据此保证每条回复都自然。

完整验证可运行 `node scripts/simulate-group-chat-100.js reports/新的验证目录`：固定 12 人、100 条人类消息，使用实际入口、调度器、OneBot 发送客户端与真实 DeepSeek API；QQ 传输由本地模拟器接管，时间用虚拟时钟推进，不向真实群发送消息。结果保存完整对话、判断、草稿检查、token、来源及上下文断言，自动检查通过后仍需审阅全部回复。脚本不会部署或关机；本次循环验证与采用/放弃的方案见 `reports/group-chat-100-20261014/`。

群级冷却和并发保护用于限制刷屏：连续消息默认在首条待处理消息后的 600 毫秒内合并（`AMBIENT_CHAT_DEBOUNCE_MS`），后续消息更新待处理上下文，不不断推迟判断时间。每群串行执行闲聊判断/生成，推理期间新消息继续积累；上一轮结束后再读取最新上下文处理待办。普通群友发言不直接废掉正在生成的插话；上下文推进后，发送前读取最新记录再判断一次这句是否仍想说、还能接上话，不重新生成草稿。判断期间又到来的消息留给下一轮，不要求等群里完全停下来才发。已转走的话题、明确停聊或私事不发送；明确命令、`@` 问答或其他 bot 回复使旧操作失效。发送后只清除本轮已经覆盖的待办，后来消息仍会处理。冷却从实际回复发送成功后开始，决定不接话不会消耗回复冷却。内部判断 JSON 不写入最近 50 条群聊记录。`AMBIENT_CHAT_CONTEXT_SECONDS` 仅影响引用消息查找缓存，不使共享群聊上下文过期。

两条 AI 路径都告诉模型群消息按时间从旧到新排列，末尾是最新进展，随后由模型根据整段讨论直接接话。已删除“只回应这一句”的限制；`【当前锚点】` 仅定位最后一条群成员消息，不限制回复只能涉及它。模型可以联系不同成员的说法、先前的选择和未聊完的问题，冷场时也不必主持或另开话题。QQ 回复/引用标记用于定位文字或图片，相关性仍由内容判断。本轮对照、50 条上下文连续性场景和完整群聊模拟保存在 `reports/group-chat-natural-v5-20261014/`。

群聊学习默认开启。程序收到群消息后自动在程序目录创建 `data/group-chat-learning/<群号>.json`，每群独立保存表达习惯和经过评估的教学指导，重启后继续使用。源码运行时“程序目录”指仓库根目录，EXE 运行时指 EXE 所在目录，与启动时的工作目录无关。`GROUP_CHAT_LEARNING_DIR` 可指定其他目录，相对路径也从程序目录解析。文件只保存学习提示词、修订时间和样本依据，不累积原始聊天或把过期话题事实重新塞进 50 条上下文。

专用学习提示词位于 `src/group-chat-learning-prompt.js`。每次更新同时传入现有 `learning_module` 和最近最多 50 条实际群聊消息，始终开启思考模式（默认 `high`）。聊天提示词明确说明 `user` 是群友、`assistant` 是机器人已经发过的话；学习记录另用 `speaker=bot` 标记机器人、`speaker=member1` 等匿名标记真人，学习提示词也解释了这些标识。模型既提炼群员风格，也定位针对 bot 回复的教学、纠正和方法建议，评估合理性、可执行性和长期适用范围后合并写回。明确合理的教学可以只出现一次；“闲聊随意一点、允许瞎扯、别像念稿”可以采纳。玩笑和吹牛不当成错误纠正，也不把一次性任务、引用指令或工具权限要求当长期习惯。

例如群员说“你搜完还是像念稿子，要改一下语气”，可形成“搜索后先理解材料，再用群聊口吻回答原问题，保留必要来源”的长期指导。“改完再来一次”是本次任务，不变成永久提示。学习结果应用于正文生成（包括搜索回复）和显式开启的草稿检查；接话判断只依据人格兴趣和当前群聊，不用回答格式、搜索教学或学习到的表达要求限制是否开口，也不把某次“不用回”学成永久只等艾特。

旧规则会随更新一同评估；合理内容可以原样保留，不因最近 50 条没有再次提到就丢失。输入用 `p1` 等 ID 标记旧规则，原样保留可引用该 ID；新增或实质修改必须有本轮至少一条真人 `m` 消息依据。持久文件继续使用现有结构，临时 `p` 引用解析后不会写入文件。最多 12 条、每条 180 字、总计 1800 字，用于保留风格和教学，不积累聊天事实。

默认累计 20 条新真人消息后首次学习，之后每 30 条更新一次，两次至少间隔 10 分钟，所有群的学习请求串行。学习在后台进行，不启用联网或图片读取，不阻塞当前回复；正常聊天仍默认关闭思考。`GROUP_CHAT_LEARNING_REASONING_EFFORT` 可选 `high`/`max`，`GROUP_CHAT_LEARNING_MAX_OUTPUT_TOKENS` 默认 8192（同时容纳隐藏推理和最终 JSON），超时默认 90000 毫秒。100 条连续群聊实测中，旧 4096 上限曾全部用于推理而没有 JSON，因此提高的是学习上限，实际用量按 API 返回计。旧的 512/4096 token 或 15 秒配置建议按 `.env.example` 更新。

无效 JSON、证据不合格、模型失败或写盘失败都会保留上一份学习结果；文件损坏时继续默认聊天并暂停该群学习，避免覆盖原文件。`@机器人 学习状态` 查看本群表达习惯和回复指导，`@机器人 重置群聊学习` 清空本群结果并重新积累；清空聊天上下文会保留学习内容。其他频率和目录配置见 `.env.example` 的 `GROUP_CHAT_LEARNING_*`，关闭则设 `GROUP_CHAT_LEARNING_ENABLED=false`。

真实模型的合成反馈验证可运行 `node scripts/check-whale-group-learning-live.js <新结果目录>`，检查搜索教学、无关聊天后保留、重启读取、不合理教学以及学后重述。使用真实模型 API，但不读取真实群聊、不连接或发送 QQ 消息；只保存最终 JSON/回复与 API 用量，不保存隐藏推理。来源评估与这轮验证记录位于 `reports/whale-group-learning-20261014/`。

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

把整个 `release` 目录复制到目标 Windows 10 机器，目标机不需要安装 Node.js。默认大肥鱼提示词包含在 exe 中，不再需要外部人格目录。第一次运行前，把 `.env.example` 复制或重命名为 `.env`，填好服务器 IP、查询端口、QQ群号等配置。

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
