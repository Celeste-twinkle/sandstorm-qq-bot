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
  getLatestGroupMemberMessage,
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
const { buildHelpText, isHelpCommand, isLearningResetCommand } = require("./help");
const { createOneBotServer } = require("./onebot");
const { GroupChatLearning } = require("./group-chat-learning");
const { GroupBotLoopGuard } = require("./group-bot-loop-guard");
const { GroupBotPolicy, parseBotControlCommand } = require("./group-bot-policy");
const { AgentMemory, createMemoryTools } = require("./agent-memory");
const { StickerLibrary } = require("./sticker-library");
const { formatMoodHint } = require("./memory-policy");
const { querySandstormStatus } = require("./sandstorm");

const groupCooldowns = new Map();
const chatCooldowns = new Map();
const ambientChatCooldowns = new Map();
const ambientChatBuffers = new Map();
const ambientReplyGuard = new AmbientReplyGuard();
const ambientReplyScheduler = new AmbientReplyScheduler();
const groupTurnLocks = new Map();
const bilibiliCooldowns = new Map();
const chatService = new AiChatService(config);
const groupChatLearning = new GroupChatLearning(config, {
  learn: (context, previous, slang) => chatService.learnGroupChatStyle(context, previous, slang),
  now: () => Date.now(),
  excludedUsers: group => groupBotPolicy.ignoredIds(group, config.groupChatBotIds),
});
const groupMessageCache = new GroupMessageCache(config);
const groupBotPolicy = new GroupBotPolicy(config);
const agentMemory = new AgentMemory({ ...config, memoryEnabled: config.memoryEnabled === true }, {
  excludedUsers: key => groupBotPolicy.ignoredIds(key.replace(/^group:/, ""), config.groupChatBotIds),
  now: () => Date.now(),
});
const groupConversationContext = new GroupConversationContext({ memory: agentMemory });
const stickerLibrary = new StickerLibrary(config, {
  analyze: image => chatService.analyzeSticker(image),
  choose: (candidates, context, draft) => chatService.chooseSticker(candidates, context, draft),
  excludedUsers: group => groupBotPolicy.ignoredIds(group, config.groupChatBotIds),
  now: () => Date.now(),
});
const groupBotLoopGuard = new GroupBotLoopGuard(config, {
  accountDecision: (groupId, userId) => groupBotPolicy.decision(groupId, userId),
});
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
  return `group:${message.group_id}`;
}

async function runGroupTurn(groupId, operation) {
  const key = String(groupId), epoch = agentMemory.epoch(`group:${key}`);
  const previous = groupTurnLocks.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => agentMemory.epoch(`group:${key}`) === epoch ? operation() : null);
  groupTurnLocks.set(key, pending);
  try { return await pending; }
  finally { if (groupTurnLocks.get(key) === pending) groupTurnLocks.delete(key); }
}

async function withMemoryTurn(groupId, query, canRespond, operation, ambient = false) {
  const key = `group:${groupId}`;
  const lease = agentMemory.beginTurn(key);
  const epoch = agentMemory.epoch(key);
  const isCurrent = () => canRespond() && agentMemory.epoch(key) === epoch;
  let completed = false;
  try {
    const memoryPrompt = lease ? await agentMemory.buildPrompt(lease, query) : "";
    if (!isCurrent()) return null;
    const result = await operation({
      memoryPrompt,
      memoryTools: lease ? createMemoryTools(agentMemory, lease, isCurrent) : undefined,
      onUsage: lease ? usage => agentMemory.recordUsage(lease, usage) : undefined,
      memoryMoodHint: config.memoryMoodEnabled === true ? formatMoodHint(Date.now(), config.memoryTimezone || "Asia/Shanghai", ambient) : "",
      groupSlang: groupChatLearning.getSlang(groupId),
      currentText: query,
      memoryContext: lease ? agentMemory.contextForTurn(lease) : undefined,
      getMemoryContext: lease ? () => agentMemory.contextForTurn(lease) : undefined,
      isCurrent,
    });
    completed = result !== null;
    return result;
  } finally { if (lease) agentMemory.finishTurn(lease, completed); }
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
    agentMemory.record(`group:${groupId}`, current);
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
  agentMemory.record(`group:${groupId}`, current);
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
  return runGroupTurn(groupId, () => tryAmbientReplyUnlocked(groupId, mode, client));
}

async function tryAmbientReplyUnlocked(groupId, mode, client) {
  const messages = getGroupConversationContext(
    groupId,
    MAX_GROUP_CONTEXT_MESSAGES,
  );
  if (messages.length === 0) {
    return;
  }
  const anchor = getLatestGroupMemberMessage(messages);
  if (!anchor || !groupBotLoopGuard.canRespond(groupId, anchor.userId)) return;

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
    const canRespond = () => groupBotLoopGuard.canRespond(groupId, anchor.userId);
    const reply = await withMemoryTurn(groupId, anchor.text, canRespond, memoryMeta => chatService.ambientReplyIfAppropriate(memoryMeta.memoryContext || messages, {
      ...memoryMeta,
      groupContextMessages: messages,
      ambientMode: mode,
      groupChatStyle: groupChatLearning.getRules(groupId),
      ...getGroupReplyMeta(messages),
    }, {
      isCurrent: () => memoryMeta.isCurrent() && ambientReplyGuard.canContinue(ticket, getGroupConversationContext(groupId)),
      getCurrentContext: () => memoryMeta.getMemoryContext?.() || getGroupConversationContext(groupId),
      onContextReviewed: context => ambientReplyGuard.refresh(ticket, context),
      onDecision: (shouldReply) => {
        console.log(`[bot] ambient decision group=${groupId} mode=${mode} reply=${shouldReply}`);
      },
      onSkip: (reason) => {
        console.log(`[bot] ambient reply skipped group=${groupId} reason=${reason}`);
      },
    }), true);
    if (reply === null) {
      return;
    }
    const currentContext = getGroupConversationContext(groupId);
    if (ambientReplyGuard.canContinue(ticket, currentContext)) {
      // Clear work covered by this inference; later arrivals stay queued.
      if (ambientReplyGuard.canSend(ticket, currentContext)) clearAmbientChatBuffer(groupId);
      await sendAiReply(client, groupId, reply, getLatestGroupMemberMessage(currentContext)?.userId);
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

function recordOutgoingGroupMessage(groupId, message, response, metadata = {}) {
  if (metadata.stickerId) stickerLibrary.markSent(groupId, metadata.stickerId);
  groupBotLoopGuard.recordReply(groupId, metadata.replyToUserId);
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
    images: extractImageSources({ message }),
    relation: "",
    timestamp: Date.now(),
  });
}

async function sendBotReply(client, groupId, reply, replyToUserId) {
  await client.sendGroupMessage(groupId, reply, {
    replyToUserId,
    canSend: groupBotLoopGuard.responseCheck(groupId, replyToUserId),
  });
}

async function sendAiReply(client, groupId, reply, replyToUserId) {
  const epoch = agentMemory.epoch(`group:${groupId}`);
  const canSend = () => groupBotLoopGuard.canRespond(groupId, replyToUserId) && agentMemory.epoch(`group:${groupId}`) === epoch;
  await client.sendGroupMessage(groupId, reply, { replyToUserId, canSend });
  if (!canSend()) return;
  const context = getGroupConversationContext(groupId);
  const sticker = await stickerLibrary.select(groupId, context, reply, {
    isCurrent: canSend, getContext: () => getGroupConversationContext(groupId),
  });
  if (!sticker) return;
  try {
    if (!sticker.isCurrent()) return;
    await client.sendGroupMessage(groupId, [sticker.segment], { replyToUserId, stickerId: sticker.id,
      canSend: () => canSend() && sticker.isCurrent() });
  } catch { console.warn(`[stickers] delivery failed group=${groupId}; text reply already delivered`); }
  finally { sticker.release(); }
}

async function handleMemoryCommand(message, text, client) {
  if (!isMentioned(message)) return false;
  const groupId = String(message.group_id);
  let reply;
  if (text === "记忆状态") {
    const state = agentMemory.status(`group:${groupId}`);
    reply = !state.enabled ? "持久记忆已关闭。" : `本群近期记忆 ${state.recentMessages} 条，历史归档${state.archiveAvailable ? "可用" : "暂不可用"}，语义检索${state.semanticEnabled ? "已接入" : "未配置，使用关键词检索"}。${state.readOnly ? "存储文件异常，已保护原文件并停止覆盖。" : ""}`;
  } else if (text === "轮换会话") {
    agentMemory.requestRotation(`group:${groupId}`);
    reply = agentMemory.enabled ? "会在下一轮启用新窗口，已有记忆、学习结果和表情库都会保留。" : "持久记忆已关闭，无需轮换窗口。";
  } else if (text === "黑话列表") {
    const terms = groupChatLearning.getSlang(groupId);
    reply = terms.length ? `本群黑话：\n${terms.slice(-20).map(item => `${item.term}：${item.meaning}${item.status === "candidate" ? "（待确认，暂不主动使用）" : ""}`).join("\n")}` : "还没有学到可靠的本群黑话。可以说：学黑话 词=含义；场景=适用情境；禁用=不合适的情境。";
  } else if (/^学黑话\s+/u.test(text)) {
    const match = text.match(/^学黑话\s+([^=＝；;]{1,24})[=＝]([^；;]+)(?:[；;]\s*场景[=＝]([^；;]+))?(?:[；;]\s*禁用[=＝]([^；;]+))?$/u);
    if (!match) reply = "格式：学黑话 寄=这局没戏了；场景=游戏失利时自嘲；禁用=认真求助或真实伤亡。";
    else {
      try {
        await groupChatLearning.teachSlang(groupId, { term: match[1].trim(), meaning: match[2].trim(), usage: match[3]?.trim() || "按本群原始语境使用", avoid: match[4]?.trim() || "语义不明或不合当前语境时不用" }, {
          messageId: getMessageId(message), userId: String(message.user_id), text,
        });
        reply = `已记下“${match[1].trim()}”在本群的含义，会按适用语境使用。`;
      } catch { reply = "这条黑话暂时无法保存，请检查格式或学习模块状态。"; }
    }
  } else if (text === "表情库状态") {
    const state = stickerLibrary.status(groupId);
    reply = !state.enabled ? "表情收集已关闭。" : `本群表情 ${state.total}/${state.limit} 个，已识别 ${state.recognized} 个，待识别 ${state.pending} 个，识别失败 ${state.failed} 个。全库 ${state.storage.pairs}/${state.globalLimit} 对，约 ${(state.storage.bytes / 1048576).toFixed(1)} MB。图片与 OCR 情境资料配对保存，自动淘汰低价值和长期闲置条目。`;
  } else if (text === "清空表情库") {
    if (!config.botAdminIds.has(String(message.user_id))) reply = "只有机器人管理员可以清空本群表情库。";
    else {
      try { stickerLibrary.reset(groupId); reply = "已清空本群表情及对应 OCR 情境资料。其他群仍在使用的图片会保留。"; }
      catch { reply = "表情库暂时无法清空，请检查存储状态。"; }
    }
  } else if (text === "收集表情") {
    let source = message;
    if (getReplyMessageId(message)) {
      try {
        const original = await client.getMessage(getReplyMessageId(message));
        if (String(original?.group_id) !== groupId || !groupBotLoopGuard.canRespond(groupId, original.user_id)) throw new Error("Unavailable source");
        source = { ...original, self_id: message.self_id };
      } catch { reply = "暂时读不到本群被引用的图片，可以把图片与“收集表情”一起发来。"; }
    }
    if (!reply) reply = stickerLibrary.observe(groupId, source, getGroupConversationContext(groupId), true)
      ? "已加入收集队列，会将图片与 OCR 情境资料一起保存。" : "请附带图片；也可能是表情收集已关闭、正在处理或存储暂不可用。";
  } else return false;
  clearAmbientChatBuffer(groupId);
  await sendBotReply(client, groupId, reply, message.user_id);
  return true;
}

function isSelfGroupMessage(message) {
  return message.post_type === "message_sent" ||
    (Boolean(message.self_id) && String(message.user_id) === String(message.self_id));
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function handleAdminCommand(message, command, client) {
  const groupId = message.group_id;
  clearAmbientChatBuffer(groupId);
  if (!config.botAdminIds.has(String(message.user_id))) {
    await sendBotReply(client, groupId, "只有机器人管理员可以使用这条管理命令。", message.user_id);
    return;
  }
  if (command.action === "reset_learning") {
    let reply;
    try {
      await groupChatLearning.reset(groupId);
      reply = "已清空本群学习模块保存的表达习惯、回复指导和黑话词典，之后会重新积累学习。";
    } catch {
      reply = "学习模块暂时无法清空，请检查学习文件目录权限。";
    }
    await sendBotReply(client, groupId, reply, message.user_id);
    return;
  }
  if (command.action !== "list" && !command.targets.length) {
    await sendBotReply(client, groupId, "用法：@我 忽略 @目标账号 / 允许 @目标账号 / 忽略列表。也支持忽视、屏蔽、别理、取消忽略、恢复回复。", message.user_id);
    return;
  }
  if (command.action === "ignore" && command.targets.some(id => config.botAdminIds.has(id))) {
    await sendBotReply(client, groupId, "不能忽略机器人管理员账号。", message.user_id);
    return;
  }
  let reply;
  try {
    if (command.action === "list") {
      const ids = groupBotPolicy.ignoredIds(groupId, config.groupChatBotIds);
      reply = ids.length ? `本群忽略账号：${ids.join("、")}` : "本群没有设置忽略账号。";
    } else {
      await groupBotPolicy.set(groupId, command.targets, command.action);
      for (const id of command.targets) groupBotLoopGuard.resetAccount(groupId, id);
      if (command.action === "ignore") {
        groupConversationContext.removeMembers(groupId, command.targets);
        groupChatLearning.excludeMembers(groupId, command.targets);
        stickerLibrary.excludeMembers(groupId);
      }
      reply = command.action === "ignore"
        ? `本群已忽略账号：${command.targets.join("、")}。设置已保存，重启后仍生效。`
        : `本群已恢复接收账号：${command.targets.join("、")}。互聊防循环保护仍生效。`;
    }
  } catch (error) {
    console.error(`[bot] ignore settings failed: ${error.message}`);
    reply = "忽略设置暂时无法读取或保存，请检查数据文件和目录权限。";
  }
  await sendBotReply(client, groupId, reply, message.user_id);
}

async function onGroupMessage(message, client) {
  const groupId = message.group_id;

  if (!isAllowedGroup(groupId)) {
    return;
  }

  if (isSelfGroupMessage(message)) {
    recordIncomingGroupMessage(message, getCleanMessageText(message));
    return;
  }
  const text = getCleanMessageText(message);
  const botMentioned = isMentioned(message);
  const control = botMentioned && isLearningResetCommand(text)
    ? { action: "reset_learning" } : parseBotControlCommand(message);
  // Administrators can always recover an ignored account, even when their own
  // chat was previously caught by a loop or a stale account configuration.
  if (control && config.botAdminIds.has(String(message.user_id))) {
    await handleAdminCommand(message, control, client);
    return;
  }
  // Reject bot loops before context/learning, forwarded-message lookups, OCR,
  // participation judgement, commands or direct AI requests can do any work.
  const admission = groupBotLoopGuard.inspect(message);
  if (!admission.allowed) {
    if (admission.justBlocked) {
      clearAmbientChatBuffer(groupId);
      groupConversationContext.removeMembers(groupId, [String(message.user_id)]);
      groupChatLearning.excludeMembers(groupId, [String(message.user_id)]);
      stickerLibrary.excludeMembers(groupId);
      console.log(`[bot] reply loop blocked group=${groupId} user=${message.user_id}`);
    }
    return;
  }
  if (control) {
    await handleAdminCommand(message, control, client);
    return;
  }
  const canRespond = groupBotLoopGuard.responseCheck(groupId, message.user_id);
  const sessionId = getSessionId(message);
  let incomingEntry = recordIncomingGroupMessage(message, text);
  if (await handleMemoryCommand(message, text, client)) return;
  stickerLibrary.observe(groupId, message, getGroupConversationContext(groupId));
  if (text === "学习状态" || isLearningResetCommand(text)) {
    clearAmbientChatBuffer(groupId);
    if (!botMentioned || text !== "学习状态") return;
    const state = groupChatLearning.getStatus(groupId);
    const reply = !state.enabled ? "群聊学习已关闭。" : state.blocked
      ? "本群学习文件无法读取，暂用默认表达。可以请管理员用“重置学习模块”重新开始。"
      : state.rules.length ? `本群目前学到的表达习惯和回复指导：\n${state.rules.map(rule => rule.text).join("\n")}`
        : "本群还在积累聊天样本，暂时没有可靠的学习结果。";
    await sendBotReply(client, groupId, reply, message.user_id);
    return;
  }
  if (isHelpCommand(text)) {
    if (!botMentioned) {
      clearAmbientChatBuffer(groupId);
      return;
    }
    clearAmbientChatBuffer(groupId);
    await sendBotReply(client,
      groupId,
      buildHelpText(),
      message.user_id,
    );
    return;
  }

  const forwarded = await groupMessageCache.resolveForwardedMessage(
    message,
    client,
  );
  if (!canRespond()) return;
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
    await handleBilibiliMessage(groupId, text, client, message.user_id);
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
    await sendBotReply(client, groupId, reply, message.user_id);
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
    await sendBotReply(client, groupId, "已清空当前群聊会话上下文。", message.user_id);
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
    if (!canRespond()) return;
    const webSearch = shouldUseWebSearch(text);
    const thinking = shouldUseThinking(text);
    console.log(
      `[bot] chat hit in group ${groupId}, user ${message.user_id}, webSearch=${webSearch}, thinking=${thinking}: ${text}`,
    );
    await runGroupTurn(groupId, () => withMemoryTurn(groupId, text, canRespond, async memoryMeta => {
    const contextMessages = memoryMeta.memoryContext || getGroupConversationContext(groupId);
    const reply = await chatService.chat(sessionId, text, {
      ...memoryMeta,
      thinking,
      webSearch,
      images: extractImageSources(message),
      qwenForwardedContext: incomingEntry?.hasForwardedContent === true,
      groupContextMessages: contextMessages,
      groupChatStyle: groupChatLearning.getRules(groupId),
      ...getGroupReplyMeta(contextMessages),
    });
    if (!memoryMeta.isCurrent() || reply === null || isRepeatedOwnReply(getGroupConversationContext(groupId), reply)) return;
    try {
      await sendAiReply(client, groupId, reply, message.user_id);
    } catch (error) {
      const chunk =
        Number.isInteger(error.chunkIndex) && Number.isInteger(error.chunkCount)
          ? ` chunk=${error.chunkIndex + 1}/${error.chunkCount}`
          : "";
      console.error(`[onebot] AI reply delivery failed${chunk}: ${error.message}`);
      if (!canRespond()) return;
      try {
        await sendBotReply(client,
          groupId,
          "回答已经生成，但发送到 QQ 时失败了，请稍后重试。",
          message.user_id,
        );
      } catch (fallbackError) {
        console.error(
          `[onebot] delivery failure notice failed: ${fallbackError.message}`,
        );
      }
    }
    }));
  } catch (error) {
    console.error("[ai] chat failed:", error.message);
    if (!canRespond()) return;
    await sendBotReply(client, groupId, "AI 服务暂时没有回复成功，稍后再试一下。", message.user_id);
  }
}

async function handleBilibiliMessage(groupId, text, client, userId) {
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
    await sendBotReply(client, groupId, message, userId);
    logBilibili("info", "request.complete", {
      traceId,
      outcome: "resolve_failure",
      durationMs: Date.now() - requestStartedAt,
    });
    return;
  }

  if (!config.bilibiliSendVideo) {
    await sendBotReply(client, groupId, formatBilibiliResolveText(result), userId);
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
    await sendBotReply(client, groupId, formatBilibiliResolveBrief(result), userId);
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
    await sendBotReply(client, groupId, formatBilibiliUploadFallback(result, error), userId);
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

async function shutdown() {
  console.log("[bot] shutting down");
  ambientReplyScheduler.clear();
  for (const groupId of ambientChatBuffers.keys()) clearAmbientChatBuffer(groupId);
  chatService.stop();
  groupChatLearning.stop();
  await Promise.allSettled([agentMemory.close(), stickerLibrary.close(), groupChatLearning.flush()]);
  server.close(() => process.exit(0));
}
