const dgram = require("dgram");
const dns = require("dns").promises;
const { GameDig } = require("gamedig");

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function formatServerStatus(state, rules, config) {
  const players = Array.isArray(state.players) ? state.players : [];
  const currentPlayers = firstNumber(
    rules.PlrC_i,
    state.numplayers,
    state.numPlayers,
    state.raw?.numplayers,
    state.raw?.numPlayers,
    state.raw?.players,
    state.raw?.Clients,
    players.length
  );
  const maxPlayers = firstNumber(
    rules.PlrM_i,
    state.maxplayers,
    state.maxPlayers,
    state.raw?.maxplayers,
    state.raw?.maxPlayers,
    state.raw?.max_players,
    state.raw?.MaxClients
  );
  const ping = typeof state.ping === "number" ? `${Math.round(state.ping)}ms` : "未知";
  const gameMode = rules.GameMode_s || "";
  const passwordRequired = rules.Pwd_b === "true" || state.password;

  const lines = [
    `[${config.botName}] 叛乱：沙漠风暴服务器在线`,
    `服务器：${state.name || "未知"}`,
    `地图：${state.map || "未知"}`,
    `人数：${currentPlayers ?? "?"}/${maxPlayers ?? "?"}`,
  ];

  if (gameMode) {
    lines.push(`模式：${gameMode}`);
  }

  lines.push(`延迟：${ping}`);

  if (passwordRequired) {
    lines.push("密码：需要密码");
  }

  const namedPlayers = players
    .map((player) => String(player.name || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  if (namedPlayers.length > 0) {
    const suffix = players.length > namedPlayers.length ? ` 等 ${players.length} 人` : "";
    lines.push(`玩家：${namedPlayers.join("、")}${suffix}`);
  }

  return lines.join("\n");
}

async function querySandstormStatus(config) {
  try {
    const state = await withTimeout(
      GameDig.query({
        type: "insurgencysandstorm",
        host: config.sandstormHost,
        port: config.sandstormPort,
        maxAttempts: 1,
        socketTimeout: Math.min(config.queryTimeoutMs, 4000),
        attemptTimeout: config.queryTimeoutMs,
      }),
      config.queryTimeoutMs
    );

    let rules = {};
    try {
      rules = await querySandstormRules(config.sandstormHost, config.sandstormPort, config.queryTimeoutMs);
    } catch (error) {
      console.warn("[sandstorm] rules query failed:", error.message);
    }

    return formatServerStatus(state, rules, config);
  } catch (error) {
    console.error("[sandstorm] query failed:", error.message);
    return [
      `[${config.botName}] 服务器状态查询失败`,
      `目标：${config.sandstormHost}:${config.sandstormPort}`,
      "可能原因：服务器离线、查询端口不正确、防火墙未放行 UDP 查询端口。",
    ].join("\n");
  }
}

async function querySandstormRules(host, port, timeoutMs) {
  const challengeRequest = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x56, 0xff, 0xff, 0xff, 0xff]);
  const challengeResponse = await sendUdp(host, port, challengeRequest, timeoutMs);

  if (challengeResponse.length < 9 || challengeResponse[4] !== 0x41) {
    throw new Error("Unexpected rules challenge response");
  }

  const challenge = challengeResponse.subarray(5, 9);
  const rulesRequest = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x56]), challenge]);
  const rulesResponse = await sendUdp(host, port, rulesRequest, timeoutMs);

  return parseRulesResponse(rulesResponse);
}

async function sendUdp(host, port, packet, timeoutMs) {
  const { address } = await dns.lookup(host);
  const socket = dgram.createSocket("udp4");
  const waitMs = Math.min(timeoutMs, 5000);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`UDP query timed out after ${waitMs}ms`));
    }, waitMs);

    socket.once("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(message);
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });

    socket.send(packet, port, address, (error) => {
      if (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
  });
}

function parseRulesResponse(buffer) {
  if (buffer.length < 7 || buffer[4] !== 0x45) {
    throw new Error("Unexpected rules response");
  }

  const count = buffer.readUInt16LE(5);
  const rules = {};
  let offset = 7;

  for (let i = 0; i < count && offset < buffer.length; i++) {
    const keyResult = readNullTerminatedString(buffer, offset);
    offset = keyResult.nextOffset;

    const valueResult = readNullTerminatedString(buffer, offset);
    offset = valueResult.nextOffset;

    if (keyResult.value) {
      rules[keyResult.value] = valueResult.value;
    }
  }

  return rules;
}

function readNullTerminatedString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }

  return {
    value: buffer.toString("utf8", offset, end),
    nextOffset: end + 1,
  };
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

module.exports = { querySandstormStatus };
