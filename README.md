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

开启 DeepSeek 聊天后，群里 `@机器人` 且不包含查服关键词的消息会进入默认聊天模型；包含 `叛乱`、`沙漠风暴`、`服务器状态`、`ins` 等关键词时仍优先查询服务器状态。

聊天消息里包含 `深度思考` 会开启 DeepSeek thinking；包含 `联网搜索`、`联网查询` 或 `联网搜搜` 会进入本地联网搜索工具模式：bot 通过 DeepSeek 官方 `tools`/function calling 让模型请求 `web_search` / `web_fetch`，再由本地 Node 程序执行搜索和网页读取。联网搜索触发词和 `深度思考` 可以同时出现，此时会同时启用搜索工具和 thinking。

联网搜索会限制工具轮次，默认最多 2 轮、每轮最多 2 个工具调用。为了兼顾时效性和 token 消耗，本地会先拿较大的候选池，再根据 QQ 用户原始问题、模型搜索词和结果日期做相关性/时效性重排，只把少量高分结果交给模型，并压缩网页正文。回答要求基于搜索/抓取结果，重要事实标注来源；如果来源不足、冲突或搜索质量差，会说明无法可靠确认。默认使用内嵌的 `open-websearch@2.1.11`，不需要单独启动服务，也不需要搜索 API Key；可通过 `OPEN_WEBSEARCH_ENGINES` 调整搜索引擎列表。

聊天上下文按 `群号 + 用户QQ` 隔离，默认保留最近 16 条历史消息，120 分钟无消息后过期。发送 `清空上下文`、`重置会话` 或 `reset` 可以清空当前用户在当前群的会话。

群里直接发送 Bilibili / b23.tv 普通视频链接时，bot 会尝试通过外部解析服务获取 MP4 直链并发送视频，不需要 `@机器人`；普通网页 URL 不会触发解析。发送 `@机器人 帮助`、`@机器人 help` 或 `@机器人 使用说明` 可以查看可用功能。

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
