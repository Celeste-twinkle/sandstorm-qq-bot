const { config } = require("./config");
const { extractBilibiliUrls, resolveBilibiliVideo } = require("./bilibili");
const { DeepSeekChatService } = require("./deepseek");
const { createOneBotServer } = require("./onebot");
const { querySandstormStatus } = require("./sandstorm");

const groupCooldowns = new Map();
const chatCooldowns = new Map();
const ambientChatCooldowns = new Map();
const ambientChatBuffers = new Map();
const ambientChatContexts = new Map();
const bilibiliCooldowns = new Map();
const chatService = new DeepSeekChatService(config);

function getMessageText(message) {
  if (typeof message.raw_message === "string") {
    return message.raw_message;
  }

  if (typeof message.message === "string") {
    return message.message;
  }

  if (Array.isArray(message.message)) {
    return message.message
      .map((segment) => {
        if (segment.type === "text") {
          return segment.data?.text || "";
        }

        if (segment.type === "at") {
          return `[CQ:at,qq=${segment.data?.qq || ""}]`;
        }

        return "";
      })
      .join("");
  }

  return "";
}

function isMentioned(message) {
  const selfId = String(message.self_id || "");
  if (!selfId) {
    return false;
  }

  if (Array.isArray(message.message)) {
    return message.message.some((segment) => {
      return segment.type === "at" && String(segment.data?.qq || "") === selfId;
    });
  }

  const text = getMessageText(message);
  return text.includes(`[CQ:at,qq=${selfId}]`);
}

function shouldReplyStatus(message) {
  if (config.requireAt && !isMentioned(message)) {
    return false;
  }

  const text = getMessageText(message).trim();
  if (!text) {
    return false;
  }

  return config.triggerKeywords.some((keyword) => text.includes(keyword));
}

function shouldChat(message) {
  if (!config.chatEnabled) {
    return false;
  }

  const mentioned = isMentioned(message);
  if (!mentioned && (config.chatRequireAt || config.ambientChatEnabled)) {
    return false;
  }

  return getCleanMessageText(message).length > 0;
}

function shouldAmbientChat(message, text) {
  if (!config.chatEnabled || !config.ambientChatEnabled) {
    return false;
  }

  if (isMentioned(message)) {
    return false;
  }

  if (hasImageMessage(message)) {
    return false;
  }

  if (!text || isLikelyNonChatText(text)) {
    return false;
  }

  return Math.random() < config.ambientChatProbability;
}

function shouldCollectAmbientChat(message, text) {
  if (!config.chatEnabled || !config.ambientChatEnabled) {
    return false;
  }

  if (isMentioned(message) || hasImageMessage(message)) {
    return false;
  }

  return Boolean(text) && !isLikelyNonChatText(text);
}

function isAllowedGroup(groupId) {
  return config.allowedGroupIds.size === 0 || config.allowedGroupIds.has(String(groupId));
}

function isCoolingDown(key, seconds, cooldowns) {
  const now = Date.now();
  const last = cooldowns.get(String(key)) || 0;
  return now - last < seconds * 1000;
}

function markCooldown(key, cooldowns) {
  cooldowns.set(String(key), Date.now());
}

function getSessionId(message) {
  return `${message.group_id}:${message.user_id || "unknown"}`;
}

function getSenderName(message) {
  return message.sender?.card || message.sender?.nickname || "";
}

function getCleanMessageText(message) {
  const text = getMessageText(message);
  const selfId = String(message.self_id || "");
  return text
    .replace(new RegExp(`\\[CQ:at,qq=${escapeRegExp(selfId)}\\]`, "g"), "")
    .replace(/\[CQ:[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isResetCommand(text) {
  const normalized = text.trim().toLowerCase();
  return ["清空上下文", "重置会话", "清除记忆", "reset", "/reset"].includes(normalized);
}

function isHelpCommand(text) {
  const normalized = text.trim().toLowerCase();
  return ["帮助", "help", "/help", "使用说明", "功能", "菜单"].includes(normalized);
}

function shouldUseThinking(text) {
  return String(text || "").includes("深度思考");
}

function shouldUseWebSearch(text) {
  const normalized = String(text || "");
  return config.webSearchTriggerKeywords.some((keyword) => normalized.includes(keyword));
}

function shouldHandleBilibili(text) {
  return config.bilibiliEnabled && extractBilibiliUrls(text).length > 0;
}

function hasImageMessage(message) {
  if (Array.isArray(message.message)) {
    return message.message.some((segment) => segment.type === "image");
  }

  const rawText = typeof message.raw_message === "string"
    ? message.raw_message
    : typeof message.message === "string"
      ? message.message
      : "";
  return /\[CQ:image\b/i.test(rawText);
}

function isLikelyNonChatText(text) {
  return (
    text.length < 2 ||
    text.length > 240 ||
    /^https?:\/\//i.test(text) ||
    /^[/!！.。#＃]/.test(text) ||
    /^\d+$/.test(text)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clearAmbientChatBuffer(groupId) {
  const key = String(groupId);
  const buffer = ambientChatBuffers.get(key);
  if (buffer?.timer) {
    clearTimeout(buffer.timer);
  }
  ambientChatBuffers.delete(key);
}

function collectAmbientChat(message, text, client) {
  const groupId = String(message.group_id);
  appendAmbientChatContext(groupId, {
    senderName: getSenderName(message) || String(message.user_id || "unknown"),
    text,
    timestamp: Date.now(),
  });

  const existing = ambientChatBuffers.get(groupId) || {
    generation: 0,
    timer: null,
  };

  if (existing.timer) {
    clearTimeout(existing.timer);
  }

  existing.generation += 1;

  const generation = existing.generation;
  existing.timer = setTimeout(() => {
    handleAmbientChatIdle(groupId, generation, client).catch((error) => {
      console.error("[deepseek] ambient idle chat failed:", error.message);
    });
  }, Math.max(1, config.ambientChatIdleSeconds) * 1000);

  ambientChatBuffers.set(groupId, existing);
}

async function handleAmbientChatIdle(groupId, generation, client) {
  const buffer = ambientChatBuffers.get(groupId);
  if (!buffer || buffer.generation !== generation) {
    return;
  }

  ambientChatBuffers.delete(groupId);
  const messages = getAmbientChatContext(groupId);
  if (messages.length === 0) {
    return;
  }

  const text = formatAmbientChatMessages(messages);
  console.log(`[bot] ambient idle chat hit in group ${groupId}, messages=${messages.length}: ${text}`);
  const reply = await chatService.quickReply(text, {
    ambientMode: "idle",
  });
  client.sendGroupMessage(groupId, reply);
}

function appendAmbientChatContext(groupId, message) {
  const key = String(groupId);
  const existing = ambientChatContexts.get(key) || [];
  existing.push(message);
  ambientChatContexts.set(key, trimAmbientChatContext(existing, Date.now()));
}

function getAmbientChatContext(groupId) {
  const key = String(groupId);
  const messages = trimAmbientChatContext(ambientChatContexts.get(key) || [], Date.now());
  ambientChatContexts.set(key, messages);
  return messages.slice(-Math.max(1, config.ambientChatIdleMaxMessages)).reverse();
}

function trimAmbientChatContext(messages, now) {
  const contextMs = Math.max(1, config.ambientChatContextSeconds) * 1000;
  const maxMessagesToKeep = Math.max(1, config.ambientChatIdleMaxMessages) * 4;
  return messages
    .filter((message) => now - message.timestamp <= contextMs)
    .slice(-maxMessagesToKeep);
}

function formatAmbientChatMessages(messages) {
  if (messages.length === 1) {
    return messages[0].text;
  }

  const lines = messages.map((message) => `${message.senderName}：${message.text}`);
  return `以下是群聊里刚刚冷场前的一段上下文，按从新到旧排列。请接一句自然的闲聊吐槽：\n${lines.join("\n")}`;
}

async function onGroupMessage(message, client) {
  const groupId = message.group_id;

  if (!isAllowedGroup(groupId)) {
    return;
  }

  const sessionId = getSessionId(message);
  const text = getCleanMessageText(message);
  const canCollectAmbientChat = shouldCollectAmbientChat(message, text);

  if (shouldHandleBilibili(text)) {
    if (!hasImageMessage(message)) {
      clearAmbientChatBuffer(groupId);
    }

    if (isCoolingDown(sessionId, config.chatCooldownSeconds, bilibiliCooldowns)) {
      return;
    }

    markCooldown(sessionId, bilibiliCooldowns);
    await handleBilibiliMessage(groupId, text, client);
    return;
  }

  if (shouldReplyStatus(message)) {
    clearAmbientChatBuffer(groupId);

    if (isCoolingDown(groupId, config.cooldownSeconds, groupCooldowns)) {
      return;
    }

    markCooldown(groupId, groupCooldowns);
    console.log(`[bot] keyword hit in group ${groupId}: ${getMessageText(message)}`);

    const reply = await querySandstormStatus(config);
    client.sendGroupMessage(groupId, reply);
    return;
  }

  if (canCollectAmbientChat) {
    collectAmbientChat(message, text, client);
  } else if (!hasImageMessage(message)) {
    clearAmbientChatBuffer(groupId);
  }

  if (shouldAmbientChat(message, text)) {
    if (isCoolingDown(groupId, config.ambientChatCooldownSeconds, ambientChatCooldowns)) {
      return;
    }

    clearAmbientChatBuffer(groupId);
    markCooldown(groupId, ambientChatCooldowns);
    try {
      console.log(`[bot] ambient chat hit in group ${groupId}, user ${message.user_id}: ${text}`);
      const reply = await chatService.quickReply(text, {
        senderName: getSenderName(message),
      });
      client.sendGroupMessage(groupId, reply);
    } catch (error) {
      console.error("[deepseek] ambient chat failed:", error.message);
    }
    return;
  }

  if (!shouldChat(message)) {
    return;
  }

  if (isResetCommand(text)) {
    chatService.resetSession(sessionId);
    client.sendGroupMessage(groupId, "已清空当前会话上下文。");
    return;
  }

  if (isHelpCommand(text)) {
    client.sendGroupMessage(groupId, buildHelpText());
    return;
  }

  if (isCoolingDown(sessionId, config.chatCooldownSeconds, chatCooldowns)) {
    return;
  }

  markCooldown(sessionId, chatCooldowns);
  try {
    const webSearch = shouldUseWebSearch(text);
    const thinking = shouldUseThinking(text);
    console.log(
      `[bot] chat hit in group ${groupId}, user ${message.user_id}, webSearch=${webSearch}, thinking=${thinking}: ${text}`,
    );
    const reply = await chatService.chat(sessionId, text, {
      senderName: getSenderName(message),
      thinking,
      webSearch,
    });
    client.sendGroupMessage(groupId, reply);
  } catch (error) {
    console.error("[deepseek] chat failed:", error.message);
    client.sendGroupMessage(groupId, "DeepSeek 暂时没有回复成功，稍后再试一下。");
  }
}

async function handleBilibiliMessage(groupId, text, client) {
  const urls = extractBilibiliUrls(text);
  try {
    const result = await resolveBilibiliVideo(config, urls[0]);
    console.log(`[bilibili] resolved provider=${result.provider} bvid=${result.bvid || ""} url=${urls[0]}`);

    if (config.bilibiliSendVideo) {
      await client.sendGroupMessageAndWait(groupId, [
        {
          type: "video",
          data: {
            file: result.videoUrl,
          },
        },
      ]);
      client.sendGroupMessage(groupId, formatBilibiliResolveBrief(result));
    } else {
      client.sendGroupMessage(groupId, formatBilibiliResolveText(result));
    }
  } catch (error) {
    console.error("[bilibili] resolve failed:", error.message);
    client.sendGroupMessage(groupId, `Bilibili 解析失败：${error.message}`);
  }
}

function buildHelpText() {
  return [
    "Sandstorm QQ Bot 使用说明",
    "",
    "查服：@我 ins / 叛乱 / 沙漠风暴 / 服务器状态",
    "聊天：@我 直接提问",
    "深度思考：@我 深度思考 + 问题",
    "联网搜索：@我 联网搜索 / 联网查询 / 联网搜搜 + 问题",
    "组合：@我 联网搜索 深度思考 + 问题",
    "清空上下文：@我 清空上下文 / 重置会话 / reset",
    "Bilibili：群里直接发 B 站或 b23.tv 视频链接，无需 @我",
    "帮助：@我 帮助 / help / 使用说明",
  ].join("\n");
}

function formatBilibiliResolveText(result) {
  const lines = ["Bilibili 解析成功"];
  if (result.title) {
    lines.push(`标题：${result.title}`);
  }
  if (result.authorName) {
    lines.push(`UP：${result.authorName}`);
  }
  if (result.durationText) {
    lines.push(`时长：${result.durationText}`);
  }
  lines.push(`来源：${result.provider}`);
  lines.push(`直链：${result.videoUrl}`);
  return lines.join("\n");
}

function formatBilibiliResolveBrief(result) {
  const lines = ["Bilibili 解析成功"];
  if (result.title) {
    lines.push(`标题：${result.title}`);
  }
  if (result.authorName) {
    lines.push(`UP：${result.authorName}`);
  }
  if (result.pubdateText) {
    lines.push(`发布：${result.pubdateText}`);
  }
  if (result.durationText) {
    lines.push(`时长：${result.durationText}`);
  }
  const stats = formatBilibiliStats(result.stats);
  if (stats) {
    lines.push(stats);
  }
  if (result.description) {
    lines.push(`简介：${truncateText(result.description, 180)}`);
  }
  lines.push(`来源：${result.provider}`);
  return lines.join("\n");
}

function formatBilibiliStats(stats = {}) {
  const parts = [];
  if (stats.view !== undefined) {
    parts.push(`播放 ${formatCount(stats.view)}`);
  }
  if (stats.danmaku !== undefined) {
    parts.push(`弹幕 ${formatCount(stats.danmaku)}`);
  }
  if (stats.reply !== undefined) {
    parts.push(`评论 ${formatCount(stats.reply)}`);
  }
  if (stats.like !== undefined) {
    parts.push(`点赞 ${formatCount(stats.like)}`);
  }
  if (stats.coin !== undefined) {
    parts.push(`投币 ${formatCount(stats.coin)}`);
  }
  if (stats.favorite !== undefined) {
    parts.push(`收藏 ${formatCount(stats.favorite)}`);
  }
  if (stats.share !== undefined) {
    parts.push(`分享 ${formatCount(stats.share)}`);
  }

  return parts.length > 0 ? `数据：${parts.join(" / ")}` : "";
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }

  if (number >= 10000) {
    return `${(number / 10000).toFixed(number >= 100000 ? 1 : 2).replace(/\.0+$/, "")}万`;
  }

  return String(number);
}

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

const server = createOneBotServer(config, onGroupMessage);
server.listen();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("[bot] shutting down");
  server.close(() => process.exit(0));
}
