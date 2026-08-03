const { randomUUID } = require("crypto");
const {
  AiChatService,
  extractImageSources,
  extractSemanticMessageText,
} = require("./ai");
const { config } = require("./config");
const {
  downloadBilibiliVideo,
  extractBilibiliUrls,
  inspectDownloadedBilibiliVideo,
  removeDownloadedBilibiliVideo,
  resolveBilibiliVideo,
} = require("./bilibili");
const {
  GroupMessageCache,
  getMessageId,
  getReplyMessageId,
  getSenderName,
} = require("./message-context");
const { createOneBotServer } = require("./onebot");
const { querySandstormStatus } = require("./sandstorm");

const groupCooldowns = new Map();
const chatCooldowns = new Map();
const ambientChatCooldowns = new Map();
const ambientChatBuffers = new Map();
const groupConversationContexts = new Map();
const bilibiliCooldowns = new Map();
const chatService = new AiChatService(config);
const groupMessageCache = new GroupMessageCache(config);

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

  return getCleanMessageText(message).length > 0 || hasImageMessage(message);
}

function shouldAmbientChat(message, text) {
  if (!config.chatEnabled || !config.ambientChatEnabled) {
    return false;
  }

  if (isMentioned(message)) {
    return false;
  }

  if (!text || isLikelyNonChatText(text)) {
    return false;
  }

  return Math.random() < config.ambientChatProbability;
}

function shouldCollectAmbientChat(message, text, hasQwenForwardedContent = false) {
  if (!config.chatEnabled || !config.ambientChatEnabled) {
    return false;
  }

  if (isMentioned(message)) {
    return false;
  }

  return (
    hasQwenForwardedContent ||
    hasImageMessage(message) ||
    (Boolean(text) && !isLikelyNonChatText(text))
  );
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

function getCleanMessageText(message) {
  return extractSemanticMessageText(message);
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

function clearAmbientChatBuffer(groupId) {
  const key = String(groupId);
  const buffer = ambientChatBuffers.get(key);
  if (buffer?.timer) {
    clearTimeout(buffer.timer);
  }
  ambientChatBuffers.delete(key);
}

function recordIncomingGroupMessage(message, text, forwarded = null) {
  const groupId = String(message.group_id || "");
  const cached = groupMessageCache.add(
    message,
    text,
    "",
    { forwarded },
  );
  const images = cached?.images || extractImageSources(message);
  if (
    !groupId ||
    (!text && images.length === 0 && !cached?.hasForwardedContent)
  ) {
    return null;
  }

  const entry = {
    role: "user",
    messageId:
      getMessageId(message) ||
      `incoming-${groupId}-${message.user_id || "unknown"}-${Date.now()}`,
    senderName: getSenderName(message) || String(message.user_id || "unknown"),
    text,
    images,
    qwenText: cached?.qwenText || "",
    qwenImages: cached?.qwenImages || [],
    qwenOnly: cached?.qwenOnly === true,
    hasForwardedContent: cached?.hasForwardedContent === true,
    relation: getReplyMessageId(message)
      ? "QQ引用来源未解析（仅用于定位，不代表语义相关）"
      : "",
    qwenRelation: "",
    timestamp: Date.now(),
  };
  appendGroupConversationContext(groupId, entry);
  return entry;
}

async function prewarmImageInsights(images) {
  const sources = dedupeStrings(Array.isArray(images) ? images : []);
  if (sources.length === 0) {
    return 0;
  }

  try {
    return await chatService.prewarmImages(sources);
  } catch (error) {
    console.warn("[ai] image OCR prewarm failed:", error.message);
    return 0;
  }
}

async function linkRepliedMessage(message, client) {
  const replyMessageId = getReplyMessageId(message);
  if (!replyMessageId) {
    return null;
  }

  const repliedMessage = await groupMessageCache.resolveRepliedMessage(message, client);
  if (!repliedMessage) {
    return null;
  }

  const groupId = String(message.group_id);
  const currentMessageId = getMessageId(message);
  const context = groupConversationContexts.get(groupId) || [];
  const current = [...context]
    .reverse()
    .find((entry) => !currentMessageId || entry.messageId === currentMessageId);
  if (!current) {
    return repliedMessage;
  }

  if (repliedMessage.hasForwardedContent) {
    const currentQwenText = String(
      current.qwenText || current.text || "",
    ).trim();
    const repliedQwenText = String(
      repliedMessage.qwenText || repliedMessage.text || "",
    ).trim();
    current.qwenText = [
      currentQwenText,
      "[当前消息所引用的合并转发聊天记录]",
      repliedQwenText,
    ]
      .filter(Boolean)
      .join("\n\n");
    current.qwenImages = dedupeStrings([
      ...(current.images || []),
      ...(current.qwenImages || []),
      ...(repliedMessage.qwenImages || []),
    ]);
    current.hasForwardedContent = true;
    current.qwenOnly = !current.text && current.images.length === 0;
    current.qwenRelation =
      `QQ引用来源：${repliedMessage.senderName || "群成员"}发送的合并转发聊天记录` +
      "（仅用于定位，不代表语义相关）";
    return repliedMessage;
  }

  current.images = dedupeStrings([
    ...(repliedMessage.images || []),
    ...(current.images || []),
  ]);
  const repliedSender = repliedMessage.senderName || "群成员";
  const repliedText = truncateText(repliedMessage.text, 120);
  current.relation = repliedText
    ? `QQ引用来源：${repliedSender}“${repliedText}”（仅用于定位，不代表语义相关）`
    : `QQ引用图片来源：${repliedSender}（仅用于定位，不代表语义相关）`;
  return repliedMessage;
}

async function collectAmbientChat(message, client) {
  const groupId = String(message.group_id);
  await linkRepliedMessage(message, client);

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
      console.error("[ai] ambient idle chat failed:", error.message);
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
  const messages = getGroupConversationContext(
    groupId,
    config.ambientChatIdleMaxMessages,
  );
  if (messages.length === 0) {
    return;
  }

  const text = formatAmbientChatMessages(messages);
  console.log(`[bot] ambient idle chat hit in group ${groupId}, messages=${messages.length}: ${text}`);
  const reply = await chatService.ambientReply(messages, {
    ambientMode: "idle",
  });
  sendBotReply(client, groupId, reply, {
    qwenOnly: isQwenOnlyContextAnchor(messages),
  });
}

function appendGroupConversationContext(groupId, message) {
  const key = String(groupId);
  const existing = groupConversationContexts.get(key) || [];
  const deduped = message.messageId
    ? existing.filter((entry) => entry.messageId !== message.messageId)
    : existing;
  deduped.push(message);
  groupConversationContexts.set(
    key,
    trimGroupConversationContext(deduped, Date.now()),
  );
}

function getGroupConversationContext(
  groupId,
  maxMessages = config.localQwenMaxHistoryMessages,
) {
  const key = String(groupId);
  const messages = trimGroupConversationContext(
    groupConversationContexts.get(key) || [],
    Date.now(),
  );
  groupConversationContexts.set(key, messages);
  return messages.slice(-Math.max(1, maxMessages));
}

function trimGroupConversationContext(messages, now) {
  const contextMs = Math.max(1, config.ambientChatContextSeconds) * 1000;
  const maxMessagesToKeep = Math.max(
    1,
    config.localQwenMaxHistoryMessages,
    config.ambientChatIdleMaxMessages,
    config.ambientChatInstantMaxMessages,
  );
  return messages
    .filter((message) => now - message.timestamp <= contextMs)
    .slice(-maxMessagesToKeep);
}

function clearGroupConversationContext(groupId) {
  groupConversationContexts.delete(String(groupId));
}

function sendBotReply(client, groupId, reply, options = {}) {
  const text = typeof reply === "string" ? reply.trim() : "";
  client.sendGroupMessage(groupId, reply);
  if (!text) {
    return;
  }

  appendGroupConversationContext(groupId, {
    role: "assistant",
    messageId: `bot-${groupId}-${Date.now()}-${randomUUID()}`,
    senderName: config.botName,
    text,
    images: [],
    qwenOnly: options.qwenOnly === true,
    relation: "",
    timestamp: Date.now(),
  });
}

function formatAmbientChatMessages(messages, mode = "idle") {
  if (messages.length === 0) {
    return "";
  }

  if (messages.length === 1 && mode !== "instant") {
    return formatAmbientContextLine(messages[0]);
  }

  const lines = messages.map((message, index) => {
    const relation = message.relation || (mode === "instant" && index === messages.length - 1 ? "当前消息" : "");
    const relationText = relation ? `（${relation}）` : "";
    return `${relationText}${formatAmbientContextLine(message)}`;
  });

  if (mode === "instant") {
    return `以下是群聊刚刚的一段上下文，按从旧到新排列；“当前消息”是你要接的话。请优先回应当前消息，并参考上下文接一句自然的闲聊吐槽：\n${lines.join("\n")}`;
  }

  return `以下是群聊里刚刚冷场前的一段上下文，按从旧到新排列。请接一句自然的闲聊吐槽：\n${lines.join("\n")}`;
}

function formatAmbientContextLine(message) {
  const sender =
    message.role === "assistant"
      ? `机器人 ${message.senderName || config.botName}`
      : message.senderName || "群成员";
  const text = String(message.text || "").trim() || "[图片消息]";
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const imageText = imageCount > 0 ? ` [图片×${imageCount}]` : "";
  return `${sender}：${text}${imageText}`;
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function isQwenOnlyContextAnchor(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      return message?.qwenOnly === true;
    }
  }
  return false;
}

async function onGroupMessage(message, client) {
  const groupId = message.group_id;

  if (!isAllowedGroup(groupId)) {
    return;
  }

  const sessionId = getSessionId(message);
  const text = getCleanMessageText(message);
  const forwarded = await groupMessageCache.resolveForwardedMessage(
    message,
    client,
  );
  const hasQwenForwardedContent = Boolean(forwarded);
  const ambientDecisionText =
    text || (hasQwenForwardedContent ? "[合并转发聊天记录]" : "");
  const canCollectAmbientChat = shouldCollectAmbientChat(
    message,
    text,
    hasQwenForwardedContent,
  );
  const incomingEntry = recordIncomingGroupMessage(message, text, forwarded);
  const incomingImagePrewarm = prewarmImageInsights(
    incomingEntry?.hasForwardedContent
      ? incomingEntry.qwenImages
      : incomingEntry?.images,
  );

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
    sendBotReply(client, groupId, reply);
    return;
  }

  if (canCollectAmbientChat) {
    await collectAmbientChat(message, client);
  } else {
    clearAmbientChatBuffer(groupId);
  }

  if (shouldAmbientChat(message, ambientDecisionText)) {
    if (isCoolingDown(groupId, config.ambientChatCooldownSeconds, ambientChatCooldowns)) {
      return;
    }

    clearAmbientChatBuffer(groupId);
    markCooldown(groupId, ambientChatCooldowns);
    try {
      const contextualText = formatAmbientChatMessages(
        getGroupConversationContext(groupId, config.ambientChatInstantMaxMessages),
        "instant",
      );
      console.log(`[bot] ambient chat hit in group ${groupId}, user ${message.user_id}: ${contextualText}`);
      const reply = await chatService.ambientReply(
        getGroupConversationContext(groupId, config.ambientChatInstantMaxMessages),
        {
          ambientMode: "instant",
          senderName: getSenderName(message),
        },
      );
      sendBotReply(client, groupId, reply, {
        qwenOnly: incomingEntry?.qwenOnly === true,
      });
    } catch (error) {
      console.error("[ai] ambient chat failed:", error.message);
    }
    return;
  }

  if (!shouldChat(message)) {
    return;
  }

  if (isResetCommand(text)) {
    chatService.resetSession(sessionId);
    clearGroupConversationContext(groupId);
    sendBotReply(client, groupId, "已清空当前群聊会话上下文。");
    return;
  }

  if (isHelpCommand(text)) {
    sendBotReply(client, groupId, buildHelpText());
    return;
  }

  if (isCoolingDown(sessionId, config.chatCooldownSeconds, chatCooldowns)) {
    return;
  }

  markCooldown(sessionId, chatCooldowns);
  try {
    const repliedMessage = await linkRepliedMessage(message, client);
    await Promise.all([
      incomingImagePrewarm,
      prewarmImageInsights(
        repliedMessage?.hasForwardedContent
          ? repliedMessage.qwenImages
          : repliedMessage?.images,
      ),
    ]);
    const webSearch = shouldUseWebSearch(text);
    const thinking = shouldUseThinking(text);
    console.log(
      `[bot] chat hit in group ${groupId}, user ${message.user_id}, webSearch=${webSearch}, thinking=${thinking}: ${text}`,
    );
    const reply = await chatService.chat(sessionId, text, {
      senderName: getSenderName(message),
      thinking,
      webSearch,
      images: extractImageSources(message),
      qwenForwardedContext: incomingEntry?.hasForwardedContent === true,
      groupContextMessages: getGroupConversationContext(
        groupId,
        config.localQwenMaxHistoryMessages,
      ),
    });
    sendBotReply(client, groupId, reply, {
      qwenOnly: incomingEntry?.hasForwardedContent === true,
    });
  } catch (error) {
    console.error("[ai] chat failed:", error.message);
    sendBotReply(client, groupId, "AI 服务暂时没有回复成功，稍后再试一下。");
  }
}

async function handleBilibiliMessage(groupId, text, client) {
  const urls = extractBilibiliUrls(text);
  const traceId = randomUUID();
  const requestStartedAt = Date.now();
  logBilibili("info", "request.start", {
    traceId,
    groupId: String(groupId),
    inputHost: getUrlHost(urls[0]),
  });

  let result;
  const resolveStartedAt = Date.now();
  try {
    result = await resolveBilibiliVideo(config, urls[0]);
    logBilibili("info", "resolve.success", {
      traceId,
      durationMs: Date.now() - resolveStartedAt,
      provider: result.provider,
      bvid: result.bvid || "",
      aid: result.aid || "",
      page: result.page,
      quality: result.quality,
      durationSeconds: result.duration,
      title: result.title || "",
      mediaHost: getUrlHost(result.videoUrl),
    });
  } catch (error) {
    logBilibili("error", "resolve.failure", {
      traceId,
      durationMs: Date.now() - resolveStartedAt,
      error: formatErrorForLog(error),
    });
    const message = error.message.startsWith("Bilibili 解析失败：")
      ? error.message
      : `Bilibili 解析失败：${error.message}`;
    sendBotReply(client, groupId, message);
    logBilibili("info", "request.complete", {
      traceId,
      outcome: "resolve_failure",
      durationMs: Date.now() - requestStartedAt,
    });
    return;
  }

  if (!config.bilibiliSendVideo) {
    sendBotReply(client, groupId, formatBilibiliResolveText(result));
    logBilibili("info", "request.complete", {
      traceId,
      outcome: "text_only",
      durationMs: Date.now() - requestStartedAt,
    });
    return;
  }

  let downloaded;
  let uploadSucceeded = false;
  let phase = "download";
  try {
    if (config.bilibiliDownloadVideo) {
      logBilibili("info", "download.start", {
        traceId,
        bvid: result.bvid || "",
        mediaHost: getUrlHost(result.videoUrl),
        timeoutMs: config.bilibiliDownloadTimeoutMs,
        maxVideoSizeMb: config.bilibiliMaxVideoSizeMb,
      });
      downloaded = await downloadBilibiliVideo(config, result);
      logBilibili("info", "download.success", {
        traceId,
        bvid: result.bvid || "",
        filePath: downloaded.filePath,
        fileUrl: downloaded.fileUrl,
        sizeBytes: downloaded.sizeBytes,
        declaredSizeBytes: downloaded.declaredSizeBytes,
        contentType: downloaded.contentType,
        sourceHost: downloaded.sourceHost,
        md5: downloaded.md5,
        sha256: downloaded.sha256,
        mp4: downloaded.mp4,
        durationMs: downloaded.durationMs,
        averageBytesPerSecond: downloaded.averageBytesPerSecond,
      });
    }

    phase = "upload";
    const localFile = await inspectDownloadedBilibiliVideo(downloaded);
    logBilibili(localFile.exists || !downloaded ? "info" : "error", "upload.file_check", {
      traceId,
      transport: downloaded ? "local_file" : "remote_url",
      ...localFile,
    });

    const upload = await sendBilibiliVideoWithRetry(
      groupId,
      downloaded?.fileUrl || result.videoUrl,
      client,
      config.bilibiliSendRetries,
      { traceId, bvid: result.bvid || "" },
    );
    uploadSucceeded = true;
    sendBotReply(client, groupId, formatBilibiliResolveBrief(result));
    logBilibili("info", "request.complete", {
      traceId,
      outcome: "video_sent",
      upload,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (error) {
    logBilibili("error", "request.failure", {
      traceId,
      phase,
      bvid: result.bvid || "",
      durationMs: Date.now() - requestStartedAt,
      error: formatErrorForLog(error),
    });
    sendBotReply(client, groupId, formatBilibiliUploadFallback(result, error));
  } finally {
    if (downloaded && !uploadSucceeded && config.bilibiliKeepFailedVideo) {
      logBilibili("warn", "cleanup.retained", {
        traceId,
        filePath: downloaded.filePath,
        reason: "BILIBILI_KEEP_FAILED_VIDEO=true",
      });
    } else {
      const cleanup = await removeDownloadedBilibiliVideo(downloaded);
      logBilibili(cleanup.removed || cleanup.skipped ? "info" : "error", "cleanup.complete", {
        traceId,
        ...cleanup,
      });
    }
  }
}

async function sendBilibiliVideoWithRetry(groupId, file, client, retryCount, diagnostics = {}) {
  const retries = Math.max(0, Number.parseInt(retryCount, 10) || 0);
  const maxAttempts = retries + 1;
  const uploadStartedAt = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptNumber = attempt + 1;
    const attemptStartedAt = Date.now();
    logBilibili("info", "upload.attempt", {
      ...diagnostics,
      groupId: String(groupId),
      attempt: attemptNumber,
      maxAttempts,
      transport: String(file).startsWith("file:") ? "local_file" : "remote_url",
    });
    try {
      await client.sendGroupMessageAndWait(groupId, [
        {
          type: "video",
          data: { file },
        },
      ]);
      const durationMs = Date.now() - attemptStartedAt;
      logBilibili("info", "upload.success", {
        ...diagnostics,
        groupId: String(groupId),
        attempt: attemptNumber,
        maxAttempts,
        durationMs,
      });
      return {
        attempts: attemptNumber,
        durationMs: Date.now() - uploadStartedAt,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableRichMediaError(error);
      logBilibili("error", "upload.failure", {
        ...diagnostics,
        groupId: String(groupId),
        attempt: attemptNumber,
        maxAttempts,
        durationMs: Date.now() - attemptStartedAt,
        retryable,
        error: formatErrorForLog(error),
      });
      if (attempt >= retries || !isRetryableRichMediaError(error)) {
        throw error;
      }
      const delayMs = 800 * attemptNumber;
      logBilibili("warn", "upload.retry_scheduled", {
        ...diagnostics,
        attempt: attemptNumber,
        maxAttempts,
        delayMs,
      });
      await delay(delayMs);
    }
  }

  throw lastError;
}

function isRetryableRichMediaError(error) {
  return (
    Number(error?.retcode) === 1200 ||
    /rich media transfer failed|retcode["']?\s*:\s*1200/i.test(String(error?.message || ""))
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logBilibili(level, event, details = {}) {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  console[method](`[bilibili] ${safeJsonStringify(entry)}`);
}

function formatErrorForLog(error) {
  if (!error) {
    return { name: "Error", message: "unknown error" };
  }

  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code,
    action: error.action,
    retcode: error.retcode,
    durationMs: error.durationMs,
    response: error.response,
    stack: error.stack,
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  } catch (error) {
    return JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "log.serialization_failure",
      message: error.message,
    });
  }
}

function getUrlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function buildHelpText() {
  return [
    "Sandstorm QQ Bot 使用说明",
    "",
    "查服：@我 ins / 叛乱 / 沙漠风暴 / 服务器状态",
    "聊天：@我 直接提问，Qwen 会参考群内最近 100 条消息",
    "识图：@我 并附带图片，或回复上面的图片后 @我；最多参考最近 10 张",
    "转发：合并转发聊天记录会递归展平并仅供 Qwen 阅读，DeepSeek 不读取",
    "表情：内置/超级/商城表情会作为语气和图片进入 Qwen 上下文",
    "深度思考：@我 深度思考 + 问题",
    "联网搜索：@我 联网搜索 / 联网查询 / 联网搜搜 + 问题",
    "组合：@我 联网搜索 深度思考 + 问题",
    "清空群上下文：@我 清空上下文 / 重置会话 / reset",
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

function formatBilibiliUploadFallback(result, error) {
  const lines = ["Bilibili 解析成功，但 QQ 视频上传失败。"];
  if (result.title) {
    lines.push(`标题：${result.title}`);
  }
  if (result.authorName) {
    lines.push(`UP：${result.authorName}`);
  }
  if (error?.code === "BILIBILI_VIDEO_TOO_LARGE") {
    lines.push(`原因：${error.message}`);
  } else {
    lines.push("原因：QQ 富媒体传输失败，请打开原视频观看。");
  }
  lines.push(`原视频：${result.pageUrl}`);
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
chatService
  .start()
  .catch((error) => {
    console.error("[ai] provider health monitor failed to start:", error.message);
  })
  .finally(() => {
    server.listen();
  });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("[bot] shutting down");
  chatService.stop();
  server.close(() => process.exit(0));
}
