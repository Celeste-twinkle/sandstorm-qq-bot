const { randomUUID } = require("crypto");
const {
  AiChatService,
  extractImageSources,
  extractSemanticMessageText,
  isRepeatedOwnReply,
} = require("./ai");
const { config } = require("./config");
const { AmbientReplyGuard, AmbientReplyScheduler, getAmbientReplyDelay, getAmbientRecipientHint } = require("./ambient-chat");
const {
  MAX_GROUP_CONTEXT_MESSAGES,
  GroupConversationContext,
  getGroupMessageTimestamp,
  getGroupReplyMeta,
} = require("./group-context");
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
const { buildHelpText, isHelpCommand } = require("./help");
const { createOneBotServer } = require("./onebot");
const { GroupChatLearning } = require("./group-chat-learning");
const { querySandstormStatus } = require("./sandstorm");

const groupCooldowns = new Map();
const chatCooldowns = new Map();
const ambientChatCooldowns = new Map();
const ambientChatBuffers = new Map();
const ambientReplyGuard = new AmbientReplyGuard();
const ambientReplyScheduler = new AmbientReplyScheduler();
const groupConversationContext = new GroupConversationContext();
const bilibiliCooldowns = new Map();
const chatService = new AiChatService(config);
const groupChatLearning = new GroupChatLearning(config, {
  learn: (context, previous) => chatService.learnGroupChatStyle(context, previous),
  now: () => Date.now(),
});
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
    Boolean(text)
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

function shouldUseThinking(text) {
  return config.deepseekThinkingEnabled || String(text || "").includes("深度思考");
}

function shouldUseWebSearch(text) {
  if (config.webSearchAutoEnabled) {
    return "auto";
  }
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

function clearAmbientChatBuffer(groupId) {
  const key = String(groupId);
  ambientReplyScheduler.cancel(key);
  ambientReplyGuard.cancel(key);
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
    role: isSelfGroupMessage(message) ? "assistant" : "user",
    messageId:
      getMessageId(message) ||
      `incoming-${groupId}-${message.user_id || "unknown"}-${Date.now()}`,
    userId: String(message.user_id || ""),
    senderName: isSelfGroupMessage(message)
      ? config.botName
      : getSenderName(message) || String(message.user_id || "unknown"),
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
    recipientHint: getAmbientRecipientHint(message),
    timestamp: getGroupMessageTimestamp(message),
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
  const context = groupConversationContext.get(groupId);
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
  scheduleAmbientReply(groupId, "idle", client);
}

function scheduleAmbientReply(groupId, mode, client) {
  const delayMs = getAmbientReplyDelay(mode, ambientChatCooldowns.get(String(groupId)), config);
  ambientReplyScheduler.schedule(groupId, () => tryAmbientReply(groupId, mode, client), delayMs);
}

async function tryAmbientReply(groupId, mode, client) {
  const messages = getGroupConversationContext(
    groupId,
    MAX_GROUP_CONTEXT_MESSAGES,
  );
  if (messages.length === 0) {
    return;
  }

  if (isCoolingDown(groupId, config.ambientChatCooldownSeconds, ambientChatCooldowns)) {
    console.log(`[bot] ambient deferred group=${groupId} mode=${mode} reason=cooldown`);
    scheduleAmbientReply(groupId, mode, client);
    return;
  }
  const ticket = ambientReplyGuard.begin(groupId, messages);
  if (!ticket) {
    return;
  }
  try {
    const reply = await chatService.ambientReplyIfAppropriate(messages, {
      ambientMode: mode,
      groupChatStyle: groupChatLearning.getRules(groupId),
      ...getGroupReplyMeta(messages),
    }, {
      isCurrent: () => ambientReplyGuard.canContinue(ticket, getGroupConversationContext(groupId)),
      getCurrentContext: () => getGroupConversationContext(groupId),
      onContextReviewed: context => ambientReplyGuard.refresh(ticket, context),
      onDecision: (shouldReply) => {
        console.log(`[bot] ambient decision group=${groupId} mode=${mode} reply=${shouldReply}`);
      },
      onSkip: (reason) => {
        console.log(`[bot] ambient reply skipped group=${groupId} reason=${reason}`);
      },
    });
    if (reply === null) {
      return;
    }
    const currentContext = getGroupConversationContext(groupId);
    if (ambientReplyGuard.canContinue(ticket, currentContext)) {
      // Clear work covered by this inference; later arrivals stay queued.
      if (ambientReplyGuard.canSend(ticket, currentContext)) clearAmbientChatBuffer(groupId);
      await sendBotReply(client, groupId, reply);
      markCooldown(groupId, ambientChatCooldowns);
    } else {
      console.log(`[bot] ambient reply skipped after conversation changed in group ${groupId}`);
    }
  } finally {
    ambientReplyGuard.finish(ticket);
  }
}

function appendGroupConversationContext(groupId, message) {
  groupConversationContext.append(groupId, message);
  if (config.chatEnabled && chatService.isConfigured()) {
    groupChatLearning.observe(groupId, groupConversationContext.get(groupId));
  }
}

function getGroupConversationContext(
  groupId,
  maxMessages = config.chatMaxHistoryMessages,
) {
  return groupConversationContext.get(groupId, maxMessages);
}

function clearGroupConversationContext(groupId) {
  groupConversationContext.clear(groupId);
}

function recordOutgoingGroupMessage(groupId, message, response) {
  const text = extractSemanticMessageText({ message });
  if (!text) {
    return;
  }
  const messageId = String(response?.data?.message_id ?? `bot-${groupId}-${randomUUID()}`);
  groupMessageCache.add({
    group_id: groupId,
    message_id: messageId,
    sender: { nickname: config.botName },
    message,
  }, text);
  appendGroupConversationContext(groupId, {
    role: "assistant",
    messageId,
    senderName: config.botName,
    text,
    images: [],
    relation: "",
    timestamp: Date.now(),
  });
}

async function sendBotReply(client, groupId, reply) {
  await client.sendGroupMessage(groupId, reply);
}

function isSelfGroupMessage(message) {
  return message.post_type === "message_sent" ||
    (Boolean(message.self_id) && String(message.user_id) === String(message.self_id));
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function onGroupMessage(message, client) {
  const groupId = message.group_id;

  if (!isAllowedGroup(groupId)) {
    return;
  }

  const sessionId = getSessionId(message);
  const text = getCleanMessageText(message);
  let incomingEntry = recordIncomingGroupMessage(message, text);
  if (isSelfGroupMessage(message)) {
    return;
  }
  const botMentioned = isMentioned(message);
  if (["学习状态", "重置群聊学习"].includes(text)) {
    clearAmbientChatBuffer(groupId);
    if (!botMentioned) return;
    if (text === "重置群聊学习") {
      try {
        await groupChatLearning.reset(groupId);
        await sendBotReply(client, groupId, "已重置本群学到的表达习惯和回复指导，之后会重新学习。");
      } catch {
        await sendBotReply(client, groupId, "学习结果暂时无法重置，请检查学习文件目录权限。");
      }
    } else {
      const state = groupChatLearning.getStatus(groupId);
      const reply = !state.enabled ? "群聊学习已关闭。" : state.blocked
        ? "本群学习文件无法读取，暂用默认表达。可以用“重置群聊学习”重新开始。"
        : state.rules.length ? `本群目前学到的表达习惯和回复指导：\n${state.rules.map(rule => rule.text).join("\n")}`
          : "本群还在积累聊天样本，暂时没有可靠的学习结果。";
      await sendBotReply(client, groupId, reply);
    }
    return;
  }
  if (isHelpCommand(text)) {
    if (!botMentioned) {
      clearAmbientChatBuffer(groupId);
      return;
    }
    clearAmbientChatBuffer(groupId);
    await client.sendGroupMessage(
      groupId,
      buildHelpText(),
    );
    return;
  }

  const forwarded = await groupMessageCache.resolveForwardedMessage(
    message,
    client,
  );
  const hasQwenForwardedContent = Boolean(forwarded);
  const canCollectAmbientChat = shouldCollectAmbientChat(
    message,
    text,
    hasQwenForwardedContent,
  );
  if (forwarded) {
    incomingEntry = recordIncomingGroupMessage(message, text, forwarded);
  }
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
    await sendBotReply(client, groupId, reply);
    return;
  }

  if (canCollectAmbientChat) {
    await collectAmbientChat(message, client);
    scheduleAmbientReply(groupId, "instant", client);
    return;
  }
  clearAmbientChatBuffer(groupId);

  if (!shouldChat(message)) {
    return;
  }

  if (isResetCommand(text)) {
    chatService.resetSession(sessionId);
    clearGroupConversationContext(groupId);
    await sendBotReply(client, groupId, "已清空当前群聊会话上下文。");
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
    const contextMessages = getGroupConversationContext(groupId);
    const reply = await chatService.chat(sessionId, text, {
      thinking,
      webSearch,
      images: extractImageSources(message),
      qwenForwardedContext: incomingEntry?.hasForwardedContent === true,
      groupContextMessages: contextMessages,
      groupChatStyle: groupChatLearning.getRules(groupId),
      ...getGroupReplyMeta(contextMessages),
    });
    if (reply === null || isRepeatedOwnReply(getGroupConversationContext(groupId), reply)) return;
    try {
      await sendBotReply(client, groupId, reply);
    } catch (error) {
      const chunk =
        Number.isInteger(error.chunkIndex) && Number.isInteger(error.chunkCount)
          ? ` chunk=${error.chunkIndex + 1}/${error.chunkCount}`
          : "";
      console.error(`[onebot] AI reply delivery failed${chunk}: ${error.message}`);
      try {
        await client.sendGroupMessage(
          groupId,
          "回答已经生成，但发送到 QQ 时失败了，请稍后重试。",
        );
      } catch (fallbackError) {
        console.error(
          `[onebot] delivery failure notice failed: ${fallbackError.message}`,
        );
      }
    }
  } catch (error) {
    console.error("[ai] chat failed:", error.message);
    await sendBotReply(client, groupId, "AI 服务暂时没有回复成功，稍后再试一下。");
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
    await sendBotReply(client, groupId, message);
    logBilibili("info", "request.complete", {
      traceId,
      outcome: "resolve_failure",
      durationMs: Date.now() - requestStartedAt,
    });
    return;
  }

  if (!config.bilibiliSendVideo) {
    await sendBotReply(client, groupId, formatBilibiliResolveText(result));
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
    await sendBotReply(client, groupId, formatBilibiliResolveBrief(result));
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
    await sendBotReply(client, groupId, formatBilibiliUploadFallback(result, error));
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

const server = createOneBotServer(config, onGroupMessage, recordOutgoingGroupMessage);
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
  ambientReplyScheduler.clear();
  for (const groupId of ambientChatBuffers.keys()) clearAmbientChatBuffer(groupId);
  chatService.stop();
  groupChatLearning.stop();
  server.close(() => process.exit(0));
}
