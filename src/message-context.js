const {
  extractImageSources,
  extractSemanticMessageText,
} = require("./ai");

class GroupMessageCache {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || console;
    this.now = options.now || Date.now;
    this.groups = new Map();
  }

  add(message, text = extractPlainMessageText(message), groupIdOverride = "") {
    const groupId = String(groupIdOverride || message?.group_id || "");
    const messageId = getMessageId(message);
    const images = extractImageSources(message);
    const normalizedText = String(text || "").trim();

    if (!groupId || !messageId || (!normalizedText && images.length === 0)) {
      return null;
    }

    const entry = {
      messageId,
      senderName: getSenderName(message) || String(message?.user_id || "unknown"),
      text: normalizedText,
      images,
      timestamp: this.now(),
    };
    const existing = this.groups.get(groupId) || [];
    const deduped = existing.filter((item) => item.messageId !== messageId);
    deduped.push(entry);
    this.groups.set(groupId, this.trim(deduped, this.now()));
    return entry;
  }

  get(groupId, messageId) {
    if (!messageId) {
      return null;
    }

    const key = String(groupId || "");
    const messages = this.trim(this.groups.get(key) || [], this.now());
    this.groups.set(key, messages);

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].messageId === String(messageId)) {
        return messages[index];
      }
    }

    return null;
  }

  async resolveRepliedMessage(message, client) {
    const replyMessageId = getReplyMessageId(message);
    if (!replyMessageId) {
      return null;
    }

    const groupId = String(message?.group_id || "");
    const cached = this.get(groupId, replyMessageId);
    if (cached) {
      return cached;
    }

    if (typeof client?.getMessage !== "function") {
      return null;
    }

    try {
      const resolved = await client.getMessage(replyMessageId);
      if (!resolved) {
        return null;
      }

      const entry = this.add(
        {
          ...resolved,
          message_id: resolved.message_id ?? replyMessageId,
          group_id: resolved.group_id ?? groupId,
        },
        extractPlainMessageText(resolved),
        groupId,
      );
      return entry;
    } catch (error) {
      this.logger.warn(
        `[onebot] get_msg failed messageId=${replyMessageId}: ${error.message}`,
      );
      return null;
    }
  }

  async collectRelatedImages(message, client) {
    const repliedMessage = await this.resolveRepliedMessage(message, client);
    return dedupeStrings([
      ...(repliedMessage?.images || []),
      ...extractImageSources(message),
    ]);
  }

  trim(messages, now) {
    const ambientContextMs =
      Math.max(1, Number(this.config.ambientChatContextSeconds) || 1) * 1000;
    const sessionContextMs =
      Math.max(1, Number(this.config.chatSessionTtlMinutes) || 1) * 60 * 1000;
    const retentionMs = Math.max(ambientContextMs, sessionContextMs);
    const maxMessages = Math.max(
      100,
      (Number(this.config.localQwenMaxHistoryMessages) || 100) * 4,
      (Number(this.config.ambientChatInstantMaxMessages) || 1) * 4,
      (Number(this.config.ambientChatIdleMaxMessages) || 1) * 4,
    );

    return messages
      .filter((entry) => now - entry.timestamp <= retentionMs)
      .slice(-maxMessages);
  }
}

function getMessageId(message) {
  const id = message?.message_id ?? message?.messageId;
  return id === undefined || id === null || id === "" ? "" : String(id);
}

function getReplyMessageId(message) {
  if (Array.isArray(message?.message)) {
    const replySegment = message.message.find((segment) => segment?.type === "reply");
    const id = replySegment?.data?.id;
    return id === undefined || id === null || id === "" ? "" : String(id);
  }

  const rawText =
    typeof message?.raw_message === "string"
      ? message.raw_message
      : typeof message?.message === "string"
        ? message.message
        : "";
  const match = rawText.match(/\[CQ:reply,[^\]]*id=([^,\]]+)/i);
  return match ? String(match[1]) : "";
}

function getSenderName(message) {
  return message?.sender?.card || message?.sender?.nickname || "";
}

function extractPlainMessageText(message) {
  return extractSemanticMessageText(message);
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

module.exports = {
  GroupMessageCache,
  extractPlainMessageText,
  getMessageId,
  getReplyMessageId,
  getSenderName,
};
