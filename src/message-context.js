const {
  extractImageSources,
  extractSemanticMessageText,
} = require("./ai");

const MAX_FORWARD_DEPTH = 12;
const MAX_FORWARD_RECORDS = 200;
const MAX_FORWARD_TEXT_CHARS = 60000;

class GroupMessageCache {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || console;
    this.now = options.now || Date.now;
    this.groups = new Map();
  }

  add(
    message,
    text = extractPlainMessageText(message),
    groupIdOverride = "",
    options = {},
  ) {
    const groupId = String(groupIdOverride || message?.group_id || "");
    const messageId = getMessageId(message);
    const images = extractImageSources(message);
    const normalizedText = String(text || "").trim();
    const forwarded = normalizeForwardedContent(options.forwarded);
    const qwenText = forwarded
      ? [normalizedText, forwarded.text].filter(Boolean).join("\n\n")
      : "";
    const qwenImages = forwarded
      ? dedupeStrings([...images, ...forwarded.images])
      : [];
    const qwenOnly =
      Boolean(forwarded) && !normalizedText && images.length === 0;

    if (
      !groupId ||
      !messageId ||
      (!normalizedText && images.length === 0 && !forwarded)
    ) {
      return null;
    }

    const entry = {
      messageId,
      senderName: getSenderName(message) || String(message?.user_id || "unknown"),
      text: normalizedText,
      images,
      qwenText,
      qwenImages,
      qwenOnly,
      hasForwardedContent: Boolean(forwarded),
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

      const forwarded = await this.resolveForwardedMessage(resolved, client);
      const entry = this.add(
        {
          ...resolved,
          message_id: resolved.message_id ?? replyMessageId,
          group_id: resolved.group_id ?? groupId,
        },
        extractPlainMessageText(resolved),
        groupId,
        { forwarded },
      );
      return entry;
    } catch (error) {
      this.logger.warn(
        `[onebot] get_msg failed messageId=${replyMessageId}: ${error.message}`,
      );
      return null;
    }
  }

  async resolveForwardedMessage(message, client) {
    const forwardSegments = getForwardSegments(message);
    if (forwardSegments.length === 0) {
      return null;
    }

    const state = {
      client,
      logger: this.logger,
      records: [],
      visitedIds: new Set(),
    };

    for (const segment of forwardSegments) {
      await flattenForwardSegment(segment, state, 0);
    }

    return formatFlattenedForwardRecords(state.records);
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

function getForwardSegments(message) {
  if (Array.isArray(message?.message)) {
    return message.message.filter((segment) => {
      return String(segment?.type || "").toLowerCase() === "forward";
    });
  }

  const rawText =
    typeof message?.raw_message === "string"
      ? message.raw_message
      : typeof message?.message === "string"
        ? message.message
        : "";
  const segments = [];
  const pattern = /\[CQ:forward,([^\]]+)\]/gi;
  for (const match of rawText.matchAll(pattern)) {
    const idMatch = match[1].match(/(?:^|,)id=([^,\]]+)/i);
    if (idMatch?.[1]) {
      segments.push({
        type: "forward",
        data: { id: decodeCqValue(idMatch[1]) },
      });
    }
  }
  return segments;
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

async function flattenForwardSegment(segment, state, depth) {
  if (depth > MAX_FORWARD_DEPTH) {
    state.records.push({
      senderName: "系统",
      text: "[嵌套转发层数过深，后续内容已省略]",
      images: [],
    });
    return;
  }

  const inlineContent =
    segment?.data?.content ??
    segment?.data?.message;
  if (Array.isArray(inlineContent) && inlineContent.length > 0) {
    await flattenForwardItems(inlineContent, state, depth + 1);
    return;
  }

  const forwardId = String(
    segment?.data?.id ??
    segment?.data?.message_id ??
    "",
  ).trim();
  if (!forwardId || state.visitedIds.has(forwardId)) {
    return;
  }

  if (typeof state.client?.getForwardMessage !== "function") {
    return;
  }

  state.visitedIds.add(forwardId);
  try {
    const payload = await state.client.getForwardMessage(forwardId);
    await flattenForwardItems(unwrapForwardItems(payload), state, depth + 1);
  } catch (error) {
    state.logger.warn(
      `[onebot] get_forward_msg failed forwardId=${forwardId}: ${error.message}`,
    );
  }
}

async function flattenForwardItems(items, state, depth) {
  for (const item of Array.isArray(items) ? items : []) {
    if (isForwardSegment(item)) {
      await flattenForwardSegment(item, state, depth);
      continue;
    }

    if (isNodeSegment(item)) {
      await flattenForwardNode(item, state, depth);
      continue;
    }

    if (isForwardMessageObject(item)) {
      await flattenForwardMessageObject(item, state, depth);
      continue;
    }

    if (Array.isArray(item)) {
      await flattenForwardItems(item, state, depth);
      continue;
    }

    if (typeof item === "string" && item.trim()) {
      appendForwardRecord(state, "群成员", {
        message: item,
      });
    }
  }
}

async function flattenForwardNode(node, state, depth) {
  const data = node?.data || {};
  const senderName =
    String(data.nickname || data.name || data.user_id || "").trim() ||
    "群成员";
  const content = data.content ?? data.message;

  if (Array.isArray(content)) {
    await flattenForwardMessageSegments(content, senderName, state, depth);
    return;
  }

  if (typeof content === "string") {
    appendForwardRecord(state, senderName, { message: content });
    for (const nested of getForwardSegments({ message: content })) {
      await flattenForwardSegment(nested, state, depth);
    }
  }
}

async function flattenForwardMessageObject(message, state, depth) {
  const senderName =
    getSenderName(message) ||
    String(message?.sender?.user_id || message?.user_id || "").trim() ||
    "群成员";
  const content = message?.message ?? message?.content;

  if (Array.isArray(content)) {
    await flattenForwardMessageSegments(content, senderName, state, depth);
    return;
  }

  if (typeof content === "string") {
    appendForwardRecord(state, senderName, { message: content });
    for (const nested of getForwardSegments({ message: content })) {
      await flattenForwardSegment(nested, state, depth);
    }
  }
}

async function flattenForwardMessageSegments(
  segments,
  senderName,
  state,
  depth,
) {
  let chunk = [];

  const flushChunk = () => {
    if (chunk.length === 0) {
      return;
    }
    appendForwardRecord(state, senderName, { message: chunk });
    chunk = [];
  };

  for (const segment of segments) {
    if (isForwardSegment(segment)) {
      flushChunk();
      await flattenForwardSegment(segment, state, depth);
      continue;
    }

    if (isNodeSegment(segment)) {
      flushChunk();
      await flattenForwardNode(segment, state, depth);
      continue;
    }

    chunk.push(segment);
  }

  flushChunk();
}

function appendForwardRecord(state, senderName, message) {
  const text = extractSemanticMessageText(message);
  const images = extractImageSources(message);
  if (!text && images.length === 0) {
    return;
  }

  state.records.push({
    senderName: String(senderName || "").trim() || "群成员",
    text,
    images,
  });
}

function unwrapForwardItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.messages)) {
    return payload.messages;
  }
  if (Array.isArray(payload?.message)) {
    return payload.message;
  }
  if (payload?.data && payload.data !== payload) {
    return unwrapForwardItems(payload.data);
  }
  return [];
}

function formatFlattenedForwardRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  const retained = records.slice(-MAX_FORWARD_RECORDS);
  let omitted = records.length - retained.length;
  let lines = retained.map(formatForwardRecordLine);

  while (
    lines.length > 1 &&
    lines.join("\n").length > MAX_FORWARD_TEXT_CHARS
  ) {
    lines.shift();
    retained.shift();
    omitted += 1;
  }

  const header =
    omitted > 0
      ? `[合并转发聊天记录（嵌套内容已展平，前 ${omitted} 条过长内容已省略）]`
      : "[合并转发聊天记录（嵌套内容已展平）]";
  return {
    text: `${header}\n${lines.join("\n")}`,
    images: dedupeStrings(retained.flatMap((record) => record.images)),
    recordCount: records.length,
    omittedCount: omitted,
  };
}

function formatForwardRecordLine(record) {
  const text = String(record?.text || "").trim() || "[图片消息]";
  const indentedText = text.replace(/\n/g, "\n  ");
  const imageCount = Array.isArray(record?.images) ? record.images.length : 0;
  const imageText = imageCount > 0 ? ` [图片×${imageCount}]` : "";
  return `${record.senderName || "群成员"}：${indentedText}${imageText}`;
}

function normalizeForwardedContent(forwarded) {
  const text = String(forwarded?.text || "").trim();
  const images = dedupeStrings(
    Array.isArray(forwarded?.images) ? forwarded.images : [],
  );
  if (!text && images.length === 0) {
    return null;
  }
  return { ...forwarded, text, images };
}

function isForwardMessageObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !value.type &&
    (
      value.message !== undefined ||
      value.content !== undefined ||
      value.sender !== undefined
    ),
  );
}

function isForwardSegment(value) {
  return String(value?.type || "").toLowerCase() === "forward";
}

function isNodeSegment(value) {
  return String(value?.type || "").toLowerCase() === "node";
}

function decodeCqValue(value) {
  return String(value || "")
    .replace(/&#44;/gi, ",")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&amp;/gi, "&");
}

module.exports = {
  GroupMessageCache,
  extractPlainMessageText,
  getForwardSegments,
  getMessageId,
  getReplyMessageId,
  getSenderName,
};
