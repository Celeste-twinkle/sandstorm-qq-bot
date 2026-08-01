const { DeepSeekChatService } = require("./deepseek");
const { LocalQwenChatService, LocalQwenRequestError } = require("./qwen");

class AiChatService {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || console;
    this.deepseek =
      options.deepseekService ||
      new DeepSeekChatService(config);
    this.localQwen =
      options.localQwenService ||
      new LocalQwenChatService(config, {
        fetch: options.fetch,
        logger: this.logger,
      });
    this.sessions = new Map();
    this.sessionLocks = new Map();
  }

  async start() {
    await this.localQwen.startHealthChecks();
  }

  stop() {
    this.localQwen.stopHealthChecks();
  }

  isConfigured() {
    return this.localQwen.isConfigured() || this.deepseek.isConfigured();
  }

  resetSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  async chat(sessionId, userText, meta = {}) {
    if (!this.isConfigured()) {
      return "AI 服务还没有配置，请在 .env 中设置 Local Qwen 或 DeepSeek API Key。";
    }

    const previousLock = this.sessionLocks.get(sessionId) || Promise.resolve();
    const nextLock = previousLock
      .catch(() => undefined)
      .then(() => this.chatUnlocked(sessionId, userText, meta));

    this.sessionLocks.set(sessionId, nextLock);

    try {
      return await nextLock;
    } finally {
      if (this.sessionLocks.get(sessionId) === nextLock) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  async quickReply(userText, meta = {}) {
    if (!this.isConfigured()) {
      return "AI 服务还没有配置，请在 .env 中设置 Local Qwen 或 DeepSeek API Key。";
    }

    const result = await this.runWithFallback(async (provider) => {
      return provider.quickReply(userText, meta);
    });
    return result.text;
  }

  async chatUnlocked(sessionId, userText, meta) {
    const session = this.getSession(sessionId);
    const storedUserMessage = buildUserMessage(userText, meta, false);
    const currentUserMessage = envelopeCurrentUserMessage(storedUserMessage, meta);
    const options = {
      thinking: Boolean(meta.thinking),
      webSearch: Boolean(meta.webSearch),
    };

    const result = await this.runWithFallback(async (provider, contextScale = 1) => {
      const messages = provider === this.localQwen
        ? this.buildLocalQwenMessages(session, currentUserMessage, options, contextScale)
        : this.buildDeepSeekMessages(session, currentUserMessage);
      return provider.createCompletion(messages, options);
    });

    session.messages.push(storedUserMessage);
    session.messages.push({ role: "assistant", content: result.text });
    session.updatedAt = Date.now();
    this.trimSession(session);
    this.cleanupExpiredSessions();

    return result.text;
  }

  async runWithFallback(operation) {
    const qwenConfigured = this.localQwen.isConfigured();
    const deepseekConfigured = this.deepseek.isConfigured();
    const shouldTryQwen =
      qwenConfigured &&
      (this.localQwen.isHealthy() || !deepseekConfigured);
    let qwenError;

    if (shouldTryQwen) {
      try {
        const text = await operation(this.localQwen, 1);
        return { text, provider: this.config.localQwenProviderId };
      } catch (error) {
        qwenError = error;

        if (isContextLengthError(error)) {
          this.logger.warn(
            `[ai] provider=${this.config.localQwenProviderId} context limit hit; retrying with a smaller prompt`,
          );
          try {
            const text = await operation(this.localQwen, 0.85);
            return { text, provider: this.config.localQwenProviderId };
          } catch (retryError) {
            qwenError = retryError;
          }
        }

        if (isProviderUnavailableError(qwenError)) {
          this.localQwen.markUnavailable(sanitizeErrorMessage(qwenError, this.config));
        }

        this.logger.warn(
          `[ai] provider=${this.config.localQwenProviderId} request failed; fallback=${deepseekConfigured ? "deepseek" : "none"} error=${sanitizeErrorMessage(qwenError, this.config)}`,
        );
      }
    }

    if (deepseekConfigured) {
      const text = await operation(this.deepseek, 1);
      return { text, provider: "deepseek" };
    }

    if (qwenError) {
      throw qwenError;
    }

    throw new Error("Local Qwen is unavailable and DeepSeek is not configured.");
  }

  getSession(sessionId) {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);

    if (existing && !this.isExpired(existing, now)) {
      existing.updatedAt = now;
      return existing;
    }

    const session = { messages: [], updatedAt: now };
    this.sessions.set(sessionId, session);
    return session;
  }

  isExpired(session, now = Date.now()) {
    const ttlMs = this.config.chatSessionTtlMinutes * 60 * 1000;
    return ttlMs > 0 && now - session.updatedAt > ttlMs;
  }

  buildDeepSeekMessages(session, currentUserMessage) {
    const maxHistory = Math.max(2, this.config.chatMaxHistoryMessages);
    const history = session.messages.slice(-maxHistory);
    const messages = [
      {
        role: "system",
        content: this.deepseek.buildSystemPrompt(this.config.deepseekSystemPrompt),
      },
      ...history,
      currentUserMessage,
    ].map(convertMessageForTextProvider);

    return this.deepseek.trimMessages(messages);
  }

  buildLocalQwenMessages(session, currentUserMessage, options, contextScale = 1) {
    const maxHistory = Math.max(2, this.config.localQwenMaxHistoryMessages);
    const history = selectCompleteRecentHistory(session.messages, maxHistory);
    const basePrompt = [
      this.config.localQwenSystemPrompt,
      this.config.localQwenDialoguePrompt,
      this.config.localQwenConcisePrompt,
    ]
      .filter((part) => String(part || "").trim())
      .join("\n\n");
    const messages = [
      {
        role: "system",
        content: this.localQwen.buildSystemPrompt(basePrompt),
      },
      ...history,
      currentUserMessage,
    ].map(cloneMessageForQwen);

    limitImagesInMessages(messages, this.config.localQwenMaxImages);

    const maxOutputTokens = options.thinking
      ? this.config.localQwenThinkingMaxOutputTokens
      : this.config.localQwenMaxOutputTokens;
    return trimQwenMessagesToBudget(
      messages,
      this.config,
      maxOutputTokens,
      contextScale,
    );
  }

  trimSession(session) {
    const maxHistory = Math.max(2, this.config.localQwenMaxHistoryMessages);
    session.messages = selectCompleteRecentHistory(session.messages, maxHistory);
    limitImagesInMessages(session.messages, this.config.localQwenMaxImages);
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isExpired(session, now)) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

function buildUserMessage(userText, meta, includeEnvelope) {
  const text = String(userText || "").trim();
  const images = normalizeImageSources(meta.images);
  const fallbackText = text || (images.length > 0 ? "[用户发送了图片]" : "[空消息]");
  const formattedText = includeEnvelope
    ? `${meta.senderName ? `用户昵称：${meta.senderName}\n` : ""}用户消息：${fallbackText}`
    : fallbackText;

  if (images.length === 0) {
    return {
      role: "user",
      content: formattedText,
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: formattedText,
      },
      ...images.map((source) => ({
        type: "image_ref",
        source,
      })),
    ],
  };
}

function envelopeCurrentUserMessage(storedUserMessage, meta) {
  const sender = meta.senderName ? `用户昵称：${meta.senderName}\n` : "";

  if (!Array.isArray(storedUserMessage.content)) {
    return {
      role: "user",
      content: `${sender}用户消息：${storedUserMessage.content}`,
    };
  }

  const textPart = storedUserMessage.content.find((part) => part?.type === "text");
  const text = String(textPart?.text || "[用户发送了图片]");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${sender}用户消息：${text}`,
      },
      ...storedUserMessage.content.filter((part) => part?.type !== "text"),
    ],
  };
}

function normalizeImageSources(images) {
  const values = Array.isArray(images) ? images : [];
  const normalized = [];
  const seen = new Set();

  for (const image of values) {
    const source = String(
      typeof image === "string"
        ? image
        : image?.source || image?.url || image?.file || "",
    ).trim();

    if (!source || seen.has(source)) {
      continue;
    }

    seen.add(source);
    normalized.push(source);
  }

  return normalized;
}

function convertMessageForTextProvider(message) {
  if (!Array.isArray(message?.content)) {
    return { ...message };
  }

  const text = message.content
    .map((part) => {
      if (part?.type === "text") {
        return String(part.text || "");
      }
      if (part?.type === "image_ref" || part?.type === "image_url") {
        return "[图片]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return {
    ...message,
    content: text || "[空消息]",
  };
}

function cloneMessageForQwen(message) {
  if (!Array.isArray(message?.content)) {
    return { ...message };
  }

  return {
    ...message,
    content: message.content.map((part) => {
      if (part?.type === "image_ref") {
        return part;
      }
      return { ...part };
    }),
  };
}

function selectCompleteRecentHistory(messages, maxMessages) {
  const selected = messages.slice(-Math.max(2, maxMessages));

  while (selected.length > 0 && selected[0]?.role === "assistant") {
    selected.shift();
  }

  return selected;
}

function limitImagesInMessages(messages, maxImages) {
  const positions = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message?.content)) {
      return;
    }

    message.content.forEach((part, partIndex) => {
      if (part?.type === "image_ref" || part?.type === "image_url") {
        positions.push({ messageIndex, partIndex });
      }
    });
  });

  const imageLimit = Math.max(0, maxImages);
  const keptPositions = imageLimit === 0 ? [] : positions.slice(-imageLimit);
  const keep = new Set(
    keptPositions.map(({ messageIndex, partIndex }) => `${messageIndex}:${partIndex}`),
  );

  for (const { messageIndex, partIndex } of positions) {
    if (keep.has(`${messageIndex}:${partIndex}`)) {
      continue;
    }

    messages[messageIndex].content[partIndex] = {
      type: "text",
      text: "[较早图片已省略]",
    };
  }

  return messages;
}

function trimQwenMessagesToBudget(messages, config, maxOutputTokens, contextScale = 1) {
  const rawPromptBudget =
    config.localQwenContextTokens -
    Math.min(maxOutputTokens, config.localQwenModelMaxOutputTokens) -
    config.localQwenContextSafetyTokens;
  const promptBudget = Math.max(1024, Math.floor(rawPromptBudget * contextScale));
  const trimmed = messages.slice();

  while (trimmed.length > 2 && estimateMessagesTokens(trimmed, config) > promptBudget) {
    removeOldestConversationTurn(trimmed);
  }

  let previousEstimate = Number.POSITIVE_INFINITY;
  while (estimateMessagesTokens(trimmed, config) > promptBudget) {
    const currentEstimate = estimateMessagesTokens(trimmed, config);
    if (currentEstimate >= previousEstimate || !shrinkLatestUserText(trimmed)) {
      break;
    }
    previousEstimate = currentEstimate;
  }

  return trimmed;
}

function removeOldestConversationTurn(messages) {
  const firstConversationIndex = messages[0]?.role === "system" ? 1 : 0;
  if (firstConversationIndex >= messages.length - 1) {
    return;
  }

  const first = messages[firstConversationIndex];
  messages.splice(firstConversationIndex, 1);

  if (
    first?.role === "user" &&
    messages[firstConversationIndex]?.role === "assistant" &&
    firstConversationIndex < messages.length - 1
  ) {
    messages.splice(firstConversationIndex, 1);
  }
}

function shrinkLatestUserText(messages) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      if (message.content.length <= 256) {
        return false;
      }
      message.content = `[前文过长已截断]${message.content.slice(-Math.floor(message.content.length * 0.75))}`;
      return true;
    }

    if (Array.isArray(message.content)) {
      const textPart = message.content.find((part) => {
        return part?.type === "text" && String(part.text || "").length > 256;
      });
      if (!textPart) {
        return false;
      }
      const text = String(textPart.text);
      textPart.text = `[前文过长已截断]${text.slice(-Math.floor(text.length * 0.75))}`;
      return true;
    }
  }

  return false;
}

function estimateMessagesTokens(messages, config) {
  return messages.reduce((total, message) => {
    return total + 4 + estimateContentTokens(message?.content, config);
  }, 2);
}

function estimateContentTokens(content, config) {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }

  if (!Array.isArray(content)) {
    return estimateTextTokens(JSON.stringify(content || ""));
  }

  return content.reduce((total, part) => {
    if (part?.type === "text") {
      return total + estimateTextTokens(part.text);
    }
    if (part?.type === "image_ref" || part?.type === "image_url") {
      return total + config.localQwenImageTokenEstimate;
    }
    return total + estimateTextTokens(JSON.stringify(part || ""));
  }, 0);
}

function estimateTextTokens(value) {
  const text = String(value || "");
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;

  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiCharacters += 1;
    }
  }

  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters;
}

function extractImageSources(message) {
  const sources = [];

  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (segment?.type !== "image") {
        continue;
      }
      sources.push(segment.data?.url || segment.data?.file || "");
    }
  }

  const rawText =
    typeof message?.raw_message === "string"
      ? message.raw_message
      : typeof message?.message === "string"
        ? message.message
        : "";

  const imagePattern = /\[CQ:image,([^\]]+)\]/gi;
  for (const match of rawText.matchAll(imagePattern)) {
    const attributes = parseCqAttributes(match[1]);
    sources.push(attributes.url || attributes.file || "");
  }

  return normalizeImageSources(sources);
}

function parseCqAttributes(value) {
  const attributes = {};
  for (const item of String(value || "").split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const name = item.slice(0, separator).trim();
    const rawValue = item.slice(separator + 1);
    attributes[name] = decodeCqValue(rawValue);
  }
  return attributes;
}

function decodeCqValue(value) {
  const decoded = String(value || "")
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");

  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

function isContextLengthError(error) {
  const details = `${error?.message || ""} ${error?.responseDetails || ""}`;
  return (
    error?.status === 400 &&
    /(context|token).*(length|limit|exceed|maximum)|maximum.*(context|token)/i.test(details)
  );
}

function isProviderUnavailableError(error) {
  if (!(error instanceof LocalQwenRequestError)) {
    return true;
  }

  if (error.status === undefined) {
    return true;
  }

  return (
    [401, 403, 404, 408, 425, 429].includes(error.status) ||
    error.status >= 500
  );
}

function sanitizeErrorMessage(error, config) {
  let message = String(error?.message || error || "unknown error");
  for (const secret of [config.localQwenApiKey, config.deepseekApiKey]) {
    if (secret) {
      message = message.split(secret).join("<redacted>");
    }
  }
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

module.exports = {
  AiChatService,
  buildUserMessage,
  convertMessageForTextProvider,
  estimateMessagesTokens,
  extractImageSources,
  limitImagesInMessages,
  selectCompleteRecentHistory,
  trimQwenMessagesToBudget,
};
