# OneBot Client: NapCat

This project includes helper scripts for installing and starting NapCat QQ as the companion OneBot v11 client.

NapCat is not vendored in the repository. Run the installer script to download the latest official `NapCat.Shell.Windows.OneKey.zip` release into:

```text
onebot/napcat/runtime/
```

## Install

From the source project:

```powershell
npm run onebot:install
```

Or directly:

```powershell
.\scripts\install-onebot-napcat.ps1
```

From the packaged `release` directory:

```powershell
.\install-onebot-napcat.ps1
```

## Start

From the source project:

```powershell
npm run onebot:start
```

Or directly:

```powershell
.\scripts\start-onebot-napcat.ps1
```

From the packaged `release` directory:

```powershell
.\start-onebot-napcat.ps1
```

The first launch may open NapCat's installer/launcher and require QQ login by QR code.

## Connect To This Bot

After NapCat is running and QQ is logged in, open NapCat WebUI, then create a network configuration:

```text
Type: WebSocket Client
URL:  ws://127.0.0.1:6700/onebot/v11/ws
Token: same value as ACCESS_TOKEN in this bot's .env, if ACCESS_TOKEN is set
Enabled: yes
```

Because `sandstorm-qq-bot` and NapCat are expected to run on the same Windows server, use `127.0.0.1` instead of the DDNS domain for the OneBot connection.

By default, this bot only replies when a group message mentions the bot and contains a keyword:

```text
@bot ins
@bot 叛乱
```

Set `REQUIRE_AT=false` in `.env` if keyword-only matching is desired.

## Server Target

For a Sandstorm server running on the same Windows server, this bot's `.env` should usually use:

```env
SANDSTORM_HOST=127.0.0.1
SANDSTORM_PORT=27015
```

Use `angelabalzac.ddns.net` only if the local loopback query does not work or if the game server is on another machine behind that DDNS name.
