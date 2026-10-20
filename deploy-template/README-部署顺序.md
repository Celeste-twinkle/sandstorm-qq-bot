# Sandstorm QQ Bot 预制部署包

这个目录可以直接复制到 `angelabalzac.ddns.net` 所在的 Windows 10 服务器运行。目标机器不需要安装 Node.js。

## 已有部署增量更新

### 本次防互聊、管理员与娇憨少女人格更新（2026-10-20）

本轮必须替换部署目录中的 `sandstorm-qq-bot.exe`。建议同时替换 `.env.example` 和本说明文件 `README-部署顺序.md`；所有程序修改都已打入 EXE，服务器无需复制 `src` 或安装依赖。

先运行 `03-停止Bot服务.ps1`，替换文件，然后在服务器原有 `.env` 中合并：

```dotenv
BOT_ADMIN_IDS=631978355
DEEPSEEK_SYSTEM_PROMPT=
LOCAL_QWEN_SYSTEM_PROMPT=
```

保留原有 API Key、群号、Token 和服务器地址；两个系统提示词留空会启用本轮更娇憨、柔软、偶尔迷糊撒娇的内置大肥鱼人格。`BOT_ADMIN_IDS` 可用逗号配置多位管理员，群主或群管理员不会自动获得机器人管理权限。

启动后，管理员可在群里使用：

- `@机器人 忽略 @目标账号`：支持忽视、无视、屏蔽、拉黑、别理、不要回复等同义表达，也支持同时艾特多个目标。
- `@机器人 允许 @目标账号`：支持取消忽略、解除忽视、解除屏蔽、恢复回复等说法。
- `@机器人 忽略列表`：查看本群忽略的 QQ 号。
- `@机器人 重置学习模块` / `@机器人 清空学习模块`：清空当前群保存的学习内容，之后重新积累；原有“重置群聊学习”也统一要求管理员权限。

忽略设置按群保存在 EXE 旁的 `data\group-bot-policy.json`，收到管理命令后自动创建，重启后保留；若设置了 `GROUP_CHAT_BOT_POLICY_FILE`，则保留该项实际指向的文件。继续保留整个 `data` 目录及自定义的学习目录，学习文件格式兼容，不需要清空。`onebot\napcat`、QQ 登录数据与原有启动/停止脚本继续沿用。

未知账号快速互聊熔断默认开启，不需要额外填写 QQ 号：同一账号连续跟随机器人给它的回复接话，默认从第 4 次跟随开始停止处理，艾特也不能绕过；每次跟随窗口为 120 秒。被熔断账号需要持续安静 600 秒后由新消息恢复，持续发言会延长等待，没有自动回复通知。管理员豁免启发式熔断，动态忽略仍优先；其他需要连续快速对话的真人可配置 `GROUP_CHAT_TRUSTED_USER_IDS`。这些设置的可选参数见新版 `.env.example`。

最后运行 `02-启动Bot服务.ps1`，发送 `@机器人 帮助` 确认出现管理员指令；再用管理员账号发送 `@机器人 忽略列表` 确认权限生效。

以下为旧版本升级事项，已经完成的配置无需重复修改。

如果目标机器已经部署并登录过 QQ，不需要覆盖 NapCat 运行目录：

1. 先运行 `03-停止Bot服务.ps1`。
2. 用新包里的 `sandstorm-qq-bot.exe` 替换旧文件。
3. 新版统一使用内置大肥鱼群友提示词，启动不再读取 `config\azur-lane-personas.json`，人格切换和自定义命令已移除。旧目录和选择文件不再影响运行，可留作历史备份。
4. 保留目标机器原有 `.env`、真实 API Key、群号和整个 `data` 目录，其中 `data\group-chat-learning\<群号>.json` 保存各群学到的表达习惯和教学指导。不要直接用 `.env.example` 覆盖 `.env`，只合并需要的配置。旧配置中的实验模型和 `WEB_SEARCH_PROVIDER=auto` 会覆盖程序的新默认值，需要按下方示例更新。清空 `DEEPSEEK_SYSTEM_PROMPT` 和 `LOCAL_QWEN_SYSTEM_PROMPT` 以启用新的默认大肥鱼提示词；旧的 `PERSONA_CATALOG_FILE`、`PERSONA_CACHE_FILE` 配置不再读取。
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

### 本次大肥鱼与主动插话更新（2026-10-14）

已有部署的必需更新是 `sandstorm-qq-bot.exe`，再将下面配置合并到部署机器原有 `.env`。不要直接覆盖 `.env`，API Key、群号、服务器地址、Token 等沿用原值；未写的配置会使用新版默认值，但旧的非空提示词和旧学习预算会覆盖默认值。

```dotenv
DEEPSEEK_SYSTEM_PROMPT=
LOCAL_QWEN_SYSTEM_PROMPT=
PERSONA_FLEXIBILITY_PROMPT=
NATURAL_CHAT_PROMPT=
AMBIENT_CHAT_SYSTEM_PROMPT=
AMBIENT_CHAT_JUDGE_PROMPT=
AMBIENT_CHAT_ENABLED=true
AMBIENT_CHAT_DEBOUNCE_MS=600
AMBIENT_CHAT_DRAFT_REVIEW_ENABLED=false
GROUP_CHAT_SELF_REPEAT_CHECK_ENABLED=false
GROUP_CHAT_LEARNING_ENABLED=true
GROUP_CHAT_LEARNING_REASONING_EFFORT=high
GROUP_CHAT_LEARNING_MAX_OUTPUT_TOKENS=8192
GROUP_CHAT_LEARNING_TIMEOUT_MS=90000
```

统一使用内置大肥鱼；群友彼此聊天、没有问句、没有提到 bot，也能按兴趣主动加入。每群串行执行，推理期间的新消息继续积累，完成后处理下一轮；持续聊天不再不断推迟判断或使本轮插话作废。学习每次接收旧模块和最近聊天，使用思考模式评估风格及合理教学；学习内容指导怎么回复，不限制何时开口。

保留整个 `data` 目录和自定义的 `GROUP_CHAT_LEARNING_DIR`，现有学习文件兼容，不需要清空。旧人格目录和选择缓存已不再读取，无需更新。`.env.example` 和本说明建议同步替换；`onebot\napcat`、QQ 登录数据、原有启动/停止脚本无需更换。停止 bot、替换文件、合并配置后，重新运行 `02-启动Bot服务.ps1`。

### 本次群聊学习模块更新

新版提示词和学习模块已包含在 `sandstorm-qq-bot.exe` 中，不需要另行复制 `src`、安装 npm 依赖或重装 Node.js、NapCat。已有部署只需替换 EXE；建议同时更新 `.env.example` 和本说明，NapCat 的运行目录、登录数据以及原有日志继续保留。

群聊学习默认开启，旧 `.env` 不增加配置也会生效。需要显式配置时，将以下项合并到原 `.env`；留空的目录默认使用 EXE 所在目录下的 `data\group-chat-learning`，目录和各群文件会在收到群消息后自动创建：

```dotenv
GROUP_CHAT_LEARNING_ENABLED=true
GROUP_CHAT_LEARNING_DIR=
GROUP_CHAT_LEARNING_MIN_MESSAGES=20
GROUP_CHAT_LEARNING_EVERY_MESSAGES=30
GROUP_CHAT_LEARNING_MIN_INTERVAL_MS=600000
GROUP_CHAT_LEARNING_REASONING_EFFORT=high
GROUP_CHAT_LEARNING_MAX_OUTPUT_TOKENS=8192
GROUP_CHAT_LEARNING_TIMEOUT_MS=90000
```

首次累计 20 条新真人消息后学习，之后每累计 30 条新真人消息更新，两次至少间隔 10 分钟。学习每次传入已有学习模块与最近 50 条群聊，开启思考模式评估表达习惯和群员对回答方式的合理教学，并合并保存。旧规则不会仅因最近记录没再提到而被清空。学习不启用联网，主聊天仍默认关闭思考，正常群聊窗口仍为 50 条。

重启后发送 `@机器人 学习状态` 检查功能；首次尚未学到建议属于正常状态。需要清除本群学习结果时发送 `@机器人 重置群聊学习`。后续升级继续保留 `data\group-chat-learning`；若自定义了 `GROUP_CHAT_LEARNING_DIR`，也要保留该目录实际指向的文件。

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
   - `LOCAL_QWEN_SYSTEM_PROMPT` 和 `DEEPSEEK_SYSTEM_PROMPT` 留空时统一使用内置大肥鱼群友提示词，旧的人格选择不再读取
   - 完整帮助和学习指令必须真实艾特机器人；可发送 `@机器人 帮助`、`@机器人 学习状态`、`@机器人 重置群聊学习`
   - Qwen 默认优先回答最后一条用户消息，自动判断承接或换题并解析最近指代；可用 `LOCAL_QWEN_DIALOGUE_PROMPT` 调整对话理解规则
   - 非 `@` 插话由 AI 按人格喜好、好奇心和聊天气氛主动加入整段公共讨论。两三位群友互相聊天、艾特其他群友、没有问句或没有提到 bot，都不是沉默条件；没有兴趣时可以不接，不设置机械回复比例。旧 `.env` 的 `AMBIENT_CHAT_JUDGE_PROMPT` 应清空以启用新版规则
   - 默认在首条待处理消息后的 600 毫秒合并消息，持续来消息不推迟截止时间。每群推理串行，新消息继续积累；生成时群聊有进展，发送前再判断草稿能否接上，最后判断期间新增消息保留给下一轮，不等待群聊完全安静
   - 默认关闭额外草稿检查和实验性语义去重，闲聊允许瞎扯、吹牛、复读群友和任意长短句；“偏短，一般懒得打字”只是倾向。程序只对照最近 50 条 `assistant` 历史拦截自己的整句重复，真人发言不作为去重对象。聊天提示说明 `assistant` 是自己，学习提示另说明 `speaker=bot` 是自己；主聊天默认关闭思考，学习始终开启思考
   - 每轮使用默认角色，历史角色名字不覆盖系统身份；学习指导影响表达与回复方法
   - 回复以符合当前语境、群友能理解为准；允许一个字、一个词或半句话，不设固定字数或强制补成完整句，减少没必要的点评、叮嘱和续写比喻；明确提问、追问及求助保留完整答案，发送端不裁切正文
   - 默认 `WEB_SEARCH_AUTO_ENABLED=true`，由 AI 决定是否调用 `web_search` / `web_fetch`，也允许直接说不知道。明确要求不搜索时直接回复；需要查资料时可以说“联网搜索”“联网查询”或直接要求查证
   - 默认 `WEB_SEARCH_PROVIDER=deepseek-official` 使用移植的 DeepSeek Harness 原生搜索。引用片段足够时可直接回答，只有标题和网址时提示读取正文；若模型提前作答，在剩余工具预算内最多纠正一次。默认仍是 2 轮工具、每轮 2 次，不提高主聊天思考强度。用户提供公开网址时可直接读取。旧 `auto` 提供方链路保留为显式选项
   - DeepSeek 与 Local Qwen 的艾特问答、即时闲聊和冷场判断共用群级最近 50 条消息，包含机器人实际发送的回复，按时间从旧到新排列，超出时裁掉最早的记录；单次最多保留最近 10 张不同图片
   - `@机器人` 时可发送图文或纯图片，也可先发图片，再回复该图片并艾特机器人提问；缓存未命中时会通过 OneBot `get_msg` 取回原图。DeepSeek 使用正式 Flash 原生视觉，普通识图不预 OCR，只有明确要求读取/提取/翻译图片文字时才按需 OCR 并按内容哈希缓存
   - 合并转发聊天记录会通过 OneBot `get_forward_msg` 读取；嵌套记录按原始顺序递归展平，文字、表情和图片只进入 Local Qwen 上下文，DeepSeek 及其回退路径继续忽略
   - QQ 内置表情、超级表情、骰子、猜拳会转换成可理解的语义标签；商城表情会同时保留摘要与可用图片，单独发送也能进入上下文并触发主动闲聊
   - 未 `@机器人` 的普通群聊先由 AI 按兴趣判断是否接话；空闲达到 `AMBIENT_CHAT_IDLE_SECONDS` 后也只是再判断一次，不保证暖场。没有对 bot 的对话意图仍可插话；当下没兴趣、明确不用回、当事人私事或已散场时可以安静
   - 回复联系整个群聊，不只回答最后一句。普通新消息不会取消当前推理；明确命令、`@` 问答和其他 bot 回复会使旧操作失效。发送后仅清除本轮覆盖的待办，后来消息继续进入下一轮
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
   - 发送 `@机器人 学习状态` 检查学习结果；尚未积累足够记录时没有规则属于正常状态

## 停止与日志

- 停止 bot：运行 `03-停止Bot服务.ps1`
- 查看日志：运行 `04-查看Bot日志.ps1`

## 端口说明

- OneBot 反向 WebSocket：本机 `127.0.0.1:6700`
- 叛乱服务器查询：默认 UDP `27015`

如果 NapCat 和 bot 都在同一台机器，不需要把 `6700` 暴露到公网。
