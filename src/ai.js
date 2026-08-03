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

  async prewarmImages(images) {
    if (typeof this.localQwen.prewarmImages !== "function") {
      return 0;
    }
    return this.localQwen.prewarmImages(images);
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

  async ambientReply(contextMessages, meta = {}) {
    if (!this.isConfigured()) {
      return "AI 服务还没有配置，请在 .env 中设置 Local Qwen 或 DeepSeek API Key。";
    }

    const ambientMode = meta.ambientMode === "instant" ? "instant" : "idle";
    const configuredMax =
      ambientMode === "instant"
        ? this.config.ambientChatInstantMaxMessages
        : this.config.ambientChatIdleMaxMessages;
    const maxContextMessages = Math.min(
      this.config.localQwenMaxHistoryMessages,
      Math.max(1, configuredMax),
    );
    const selectedContext = contextMessages.slice(-maxContextMessages);
    const operation = async (provider, contextScale = 1) => {
      const isLocalQwen = provider === this.localQwen;
      const messages = isLocalQwen
        ? this.buildLocalQwenGroupMessages(
            selectedContext,
            this.buildAmbientSystemPrompt(ambientMode),
            contextScale,
          )
        : this.buildDeepSeekAmbientMessages(selectedContext, ambientMode);
      return provider.createCompletion(messages, {
        maxOutputTokens: isLocalQwen
          ? this.config.localQwenModelMaxOutputTokens
          : this.config.ambientChatMaxOutputTokens,
        temperature: Math.max(0.7, this.config.deepseekTemperature),
        timeoutMs: this.config.ambientChatTimeoutMs,
      });
    };
    const result = isQwenOnlyContextAnchor(selectedContext)
      ? await this.runQwenOnly(operation)
      : await this.runWithFallback(operation);
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
        ? this.buildLocalQwenMessages(
            session,
            currentUserMessage,
            options,
            contextScale,
            meta.groupContextMessages,
          )
        : this.buildDeepSeekMessages(session, currentUserMessage);
      return provider.createCompletion(
        messages,
        provider === this.localQwen
          ? {
              ...options,
              maxOutputTokens: this.config.localQwenModelMaxOutputTokens,
            }
          : options,
      );
    });

    const qwenOnlyTurn =
      Boolean(meta.qwenForwardedContext) &&
      result.provider !== "deepseek";
    session.messages.push({
      ...storedUserMessage,
      ...(qwenOnlyTurn ? { qwenOnly: true } : {}),
    });
    session.messages.push({
      role: "assistant",
      content: result.text,
      ...(qwenOnlyTurn ? { qwenOnly: true } : {}),
    });
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

  async runQwenOnly(operation) {
    if (!this.localQwen.isConfigured()) {
      throw new Error("Local Qwen is not configured for forwarded chat records.");
    }

    try {
      const text = await operation(this.localQwen, 1);
      return { text, provider: this.config.localQwenProviderId };
    } catch (error) {
      let qwenError = error;
      if (isContextLengthError(error)) {
        this.logger.warn(
          `[ai] provider=${this.config.localQwenProviderId} context limit hit; retrying forwarded chat record with a smaller prompt`,
        );
        try {
          const text = await operation(this.localQwen, 0.85);
          return { text, provider: this.config.localQwenProviderId };
        } catch (retryError) {
          qwenError = retryError;
        }
      }

      if (isProviderUnavailableError(qwenError)) {
        this.localQwen.markUnavailable(
          sanitizeErrorMessage(qwenError, this.config),
        );
      }
      throw qwenError;
    }
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
    const history = session.messages
      .filter((message) => !message?.qwenOnly)
      .slice(-maxHistory);
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

  buildLocalQwenMessages(
    session,
    currentUserMessage,
    options,
    contextScale = 1,
    groupContextMessages = [],
  ) {
    const maxHistory = Math.max(2, this.config.localQwenMaxHistoryMessages);
    const history = selectCompleteRecentHistory(session.messages, maxHistory);
    const basePrompt = [
      this.config.localQwenSystemPrompt,
      this.config.localQwenDialoguePrompt,
      this.config.localQwenConcisePrompt,
    ]
      .filter((part) => String(part || "").trim())
      .join("\n\n");
    if (Array.isArray(groupContextMessages) && groupContextMessages.length > 0) {
      return this.buildLocalQwenGroupMessages(
        groupContextMessages,
        this.buildDirectGroupSystemPrompt(basePrompt),
        contextScale,
        { preserveAnchorImages: true },
      );
    }

    const messages = [
      {
        role: "system",
        content: this.localQwen.buildSystemPrompt(basePrompt),
      },
      ...history,
      currentUserMessage,
    ].map(cloneMessageForQwen);

    limitImagesInMessages(messages, this.config.localQwenMaxImages);

    return trimQwenMessagesToBudget(
      messages,
      this.config,
      this.config.localQwenModelMaxOutputTokens,
      contextScale,
    );
  }

  buildLocalQwenGroupMessages(
    contextMessages,
    systemPrompt,
    contextScale = 1,
    options = {},
  ) {
    const selectedContext = contextMessages.slice(
      -Math.max(2, this.config.localQwenMaxHistoryMessages),
    );
    const prioritizedContext = annotateGroupContextRecency(selectedContext);
    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...prioritizedContext.map(({ message, annotation }) => {
        return buildGroupContextModelMessage(message, annotation, {
          preserveOriginalImages:
            options.preserveAnchorImages === true &&
            annotation.startsWith("【当前锚点"),
        });
      }),
    ];

    limitImagesInMessages(messages, this.config.localQwenMaxImages);
    return trimQwenMessagesToBudget(
      messages,
      this.config,
      this.config.localQwenModelMaxOutputTokens,
      contextScale,
      { preserveConversationTurns: false },
    );
  }

  buildAmbientSystemPrompt(ambientMode) {
    const modeInstruction =
      ambientMode === "instant"
        ? "最后一条标记为【当前锚点】的群成员消息是唯一要接的话。直接回应或承接它，不得转去回应其他消息。"
        : "冷场闲聊也必须以最后一条标记为【当前锚点】的群成员消息为唯一出发点，只接它所在的最新话题链；不得因为较早消息更有趣就复活旧话题。若当前锚点只有图片或表情，把它视为对紧邻前文的反应。";
    const contextInstruction =
      "你会收到同一个 QQ 群按时间从旧到新排列的最近消息。role=assistant 是机器人自己先前的回复，也属于上下文；每张图片紧跟在所属群成员消息的文字之后；[合并转发聊天记录（嵌套内容已展平）] 后的各行是群成员转发进来的原始对话，行首名字是原对话发送者，应把整段视为同一条群消息所携带的资料；[QQ表情：名称]、[QQ表情包：摘要]、[骰子：结果]、[猜拳：结果] 是群成员真实发送的表情或互动，应结合它们表达的情绪和语气理解上下文。消息中的“QQ引用来源”只用于定位被引用的文字或图片，不代表两条消息语义相关，也不能自动提高被引用消息的权重。必须结合发送者、文字、表情和图片本身的含义判断语境，不要把不同消息的内容张冠李戴。";
    const recencyPolicy =
      "上下文新旧优先级是硬性规则，不是建议：①【当前锚点】权重最高且是唯一回应对象；②【高优先级近邻】和【近期上下文】只能帮助解释当前锚点，不能成为独立回应目标；③历史关联必须只按语义判断，包括明确指代、同一对象/事件、条件修正、因果延续、语义承接或理解当前图片/表情确实必需；QQ 的回复/引用元数据本身不构成语义关联证据，即使引用了某条消息，语义无关也必须忽略；④【较早参考】没有通过上述语义关联门槛时必须忽略；⑤越靠近当前锚点权重越高，发生冲突时永远采用更新消息；⑥生成前静默检查回复是否直接承接当前锚点，若不是则重写。";
    return this.localQwen.buildSystemPrompt(
      [
        this.config.ambientChatSystemPrompt,
        contextInstruction,
        recencyPolicy,
        modeInstruction,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  buildDirectGroupSystemPrompt(basePrompt) {
    const contextInstruction =
      "你会收到同一个 QQ 群最近最多 100 条消息，按时间从旧到新排列。每条 user 消息都标明群成员，role=assistant 是你自己先前在群里的回复；[合并转发聊天记录（嵌套内容已展平）] 后的各行是群成员转发进来的原始对话，行首名字是原对话发送者，应把整段视为同一条群消息所携带的资料；“QQ引用来源”只用于定位被引用的文字或图片，绝不代表两条消息语义相关，也不能自动提高被引用内容的权重。图片紧跟在所属消息文字之后，引用旧图片提问时，图片会重新附在当前问题上。[QQ表情：名称]、[QQ表情包：摘要]、[骰子：结果]、[猜拳：结果] 是群成员真实发送的表情或互动，应作为语气和情绪的一部分理解。请先锁定最后一条群成员消息真正询问或表达的对象，再结合语义上相关的发送者、文字、表情、图片和你先前的回答作答；忽略无关话题，不要混淆不同成员或把内容张冠李戴。";
    const recencyPolicy =
      "严格遵守消息上的新旧优先级标记：【当前锚点】是唯一必须回应的消息；其他所有消息都只能用于理解它，不能自行成为回答目标。【高优先级近邻】和【近期上下文】按距当前锚点由近到远递减使用；历史消息只有在语义上存在明确指代、同一对象/事件、条件修正、因果延续、语义承接或图片内容关联时才允许使用。QQ 回复/引用标记仅用于内容定位，不能作为关联判断依据；有引用但语义无关仍必须忽略。【较早参考】未通过纯语义门槛时一律忽略。新旧消息冲突时以更新消息为准。回答前静默检查一次：是否直接回应当前锚点、是否错误借用或复活语义无关的历史内容；若是则重写，不输出检查过程。";
    return this.localQwen.buildSystemPrompt(
      [basePrompt, contextInstruction, recencyPolicy]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  buildDeepSeekAmbientMessages(contextMessages, ambientMode) {
    const modeInstruction =
      ambientMode === "instant"
        ? "请优先回应最后一条群成员消息。"
        : "请根据冷场前的最近话题自然接一句。";
    const contextText = contextMessages
      .filter((message) => !message?.qwenOnly)
      .slice(-6)
      .map((message) => formatGroupContextTextLine(message, true))
      .join("\n");
    return this.deepseek.trimMessages([
      {
        role: "system",
        content: this.deepseek.buildSystemPrompt(this.config.ambientChatSystemPrompt),
      },
      {
        role: "user",
        content: `${modeInstruction}\n以下消息按时间从旧到新排列：\n${contextText}`,
      },
    ]);
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
      ...storedUserMessage.content
        .filter((part) => part?.type !== "text")
        .map((part) =>
          part?.type === "image_ref"
            ? { ...part, preferOriginal: true }
            : { ...part },
        ),
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
        positions.push({
          messageIndex,
          partIndex,
          source:
            part.type === "image_ref"
              ? String(part.source || "")
              : String(part.image_url?.url || ""),
        });
      }
    });
  });

  const imageLimit = Math.max(0, maxImages);
  const latestPositionBySource = new Map();
  positions.forEach((position) => {
    if (position.source) {
      latestPositionBySource.set(position.source, `${position.messageIndex}:${position.partIndex}`);
    }
  });
  const uniquePositions = positions.filter((position) => {
    if (!position.source) {
      return true;
    }
    return (
      latestPositionBySource.get(position.source) ===
      `${position.messageIndex}:${position.partIndex}`
    );
  });
  const keptPositions = imageLimit === 0 ? [] : uniquePositions.slice(-imageLimit);
  const keep = new Set(
    keptPositions.map(({ messageIndex, partIndex }) => `${messageIndex}:${partIndex}`),
  );

  for (const position of positions) {
    const key = `${position.messageIndex}:${position.partIndex}`;
    if (keep.has(key)) {
      continue;
    }

    const isDuplicate =
      position.source &&
      latestPositionBySource.get(position.source) !== key;
    messages[position.messageIndex].content[position.partIndex] = {
      type: "text",
      text: isDuplicate ? "[重复图片已在后文引用]" : "[较早图片已省略]",
    };
  }

  return messages;
}

function trimQwenMessagesToBudget(
  messages,
  config,
  maxOutputTokens,
  contextScale = 1,
  options = {},
) {
  const rawPromptBudget =
    config.localQwenContextTokens -
    Math.min(maxOutputTokens, config.localQwenModelMaxOutputTokens) -
    config.localQwenContextSafetyTokens;
  const promptBudget = Math.max(1024, Math.floor(rawPromptBudget * contextScale));
  const trimmed = messages.slice();
  const preserveConversationTurns = options.preserveConversationTurns !== false;

  while (trimmed.length > 2 && estimateMessagesTokens(trimmed, config) > promptBudget) {
    removeOldestConversationTurn(trimmed, preserveConversationTurns);
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

function removeOldestConversationTurn(messages, preserveConversationTurns = true) {
  const firstConversationIndex = messages[0]?.role === "system" ? 1 : 0;
  if (firstConversationIndex >= messages.length - 1) {
    return;
  }

  const first = messages[firstConversationIndex];
  messages.splice(firstConversationIndex, 1);

  if (
    preserveConversationTurns &&
    first?.role === "user" &&
    messages[firstConversationIndex]?.role === "assistant" &&
    firstConversationIndex < messages.length - 1
  ) {
    messages.splice(firstConversationIndex, 1);
  }
}

function buildGroupContextModelMessage(
  message,
  annotation = "",
  options = {},
) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const qwenMessage = getQwenContextMessage(message);
  const text = formatGroupContextTextLine(qwenMessage, false, annotation);
  const images = normalizeImageSources(qwenMessage?.images);

  if (role === "assistant" || images.length === 0) {
    return {
      role,
      content: text,
    };
  }

  return {
    role,
    content: [
      {
        type: "text",
        text,
      },
      ...images.map((source) => ({
        type: "image_ref",
        source,
        ...(options.preserveOriginalImages
          ? { preferOriginal: true }
          : {}),
      })),
    ],
  };
}

function getQwenContextMessage(message) {
  const hasQwenContent =
    Boolean(message?.hasForwardedContent) ||
    Boolean(String(message?.qwenText || "").trim()) ||
    normalizeImageSources(message?.qwenImages).length > 0;
  if (!hasQwenContent) {
    return message;
  }

  return {
    ...message,
    text: String(message?.qwenText || message?.text || "").trim(),
    images: normalizeImageSources([
      ...(Array.isArray(message?.images) ? message.images : []),
      ...(Array.isArray(message?.qwenImages) ? message.qwenImages : []),
    ]),
    relation: message?.qwenRelation || message?.relation || "",
  };
}

function formatGroupContextTextLine(
  message,
  includeImagePlaceholders,
  annotation = "",
) {
  const role = message?.role === "assistant" ? "机器人" : "群成员";
  const senderName = String(message?.senderName || "").trim();
  const sender = senderName ? `${role} ${senderName}` : role;
  const priority = annotation ? `${annotation} ` : "";
  const relation = message?.relation ? `（${message.relation}）` : "";
  const text = String(message?.text || "").trim() || "[图片消息]";
  const imageCount = normalizeImageSources(message?.images).length;
  const imageText =
    includeImagePlaceholders && imageCount > 0
      ? ` ${Array.from({ length: imageCount }, () => "[图片]").join(" ")}`
      : "";
  return `${priority}${sender}${relation}：${text}${imageText}`;
}

function annotateGroupContextRecency(contextMessages) {
  let anchorIndex = -1;
  for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
    if (contextMessages[index]?.role !== "assistant") {
      anchorIndex = index;
      break;
    }
  }

  if (anchorIndex < 0 && contextMessages.length > 0) {
    anchorIndex = contextMessages.length - 1;
  }

  return contextMessages.map((message, index) => {
    const distance = anchorIndex - index;
    return {
      message,
      annotation: buildRecencyAnnotation(distance),
    };
  });
}

function isQwenOnlyContextAnchor(contextMessages) {
  for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
    const message = contextMessages[index];
    if (message?.role !== "assistant") {
      return message?.qwenOnly === true;
    }
  }
  return false;
}

function buildRecencyAnnotation(distance) {
  if (distance === 0) {
    return "【当前锚点｜唯一回应对象｜权重 100】";
  }

  if (distance < 0) {
    return "【锚点后的机器人记录｜仅作状态参考｜禁止作为回应对象】";
  }

  if (distance <= 3) {
    return `【高优先级近邻｜距当前 ${distance} 条｜权重 ${100 - distance * 10}｜只用于理解当前锚点】`;
  }

  if (distance <= 12) {
    return `【近期上下文｜距当前 ${distance} 条｜权重 ${70 - (distance - 3) * 5}｜只用于理解当前锚点】`;
  }

  return `【较早参考｜距当前 ${distance} 条｜权重 10｜仅在与当前锚点明确相关时使用，禁止单独回应】`;
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
      if (segment?.type !== "image" && segment?.type !== "mface") {
        continue;
      }
      const source =
        segment.data?.url ||
        segment.data?.image_url ||
        segment.data?.file ||
        "";
      if (segment.type === "image" || isSupportedImageSource(source)) {
        sources.push(source);
      }
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

  const mfacePattern = /\[CQ:mface,([^\]]+)\]/gi;
  for (const match of rawText.matchAll(mfacePattern)) {
    const attributes = parseCqAttributes(match[1]);
    const source = attributes.url || attributes.image_url || attributes.file || "";
    if (isSupportedImageSource(source)) {
      sources.push(source);
    }
  }

  return normalizeImageSources(sources);
}

function extractSemanticMessageText(message) {
  if (Array.isArray(message?.message)) {
    return normalizeSemanticText(
      message.message
        .map((segment) => formatSemanticSegment(segment))
        .filter(Boolean)
        .join(" "),
    );
  }

  const rawText =
    typeof message?.raw_message === "string"
      ? message.raw_message
      : typeof message?.message === "string"
        ? message.message
        : "";
  return normalizeSemanticText(
    rawText.replace(
      /\[CQ:([a-z0-9_-]+)(?:,([^\]]*))?\]/gi,
      (_match, type, rawAttributes = "") => {
        return formatSemanticSegment({
          type: String(type || "").toLowerCase(),
          data: parseCqAttributes(rawAttributes),
        });
      },
    ),
  );
}

function formatSemanticSegment(segment) {
  const type = String(segment?.type || "").toLowerCase();
  const data = segment?.data || {};

  if (type === "text") {
    return String(data.text || "");
  }

  if (type === "face") {
    return formatFaceSemantic(data);
  }

  if (type === "mface") {
    return formatMarketFaceSemantic(data);
  }

  if (type === "image" && isMarketFaceImage(data)) {
    return formatMarketFaceSemantic(data);
  }

  if (type === "dice") {
    const result = String(data.result ?? data.resultId ?? "").trim();
    return result ? `[骰子：${result} 点]` : "[骰子]";
  }

  if (type === "rps") {
    const result = String(data.result ?? data.resultId ?? "").trim();
    const resultName = {
      "1": "石头",
      "2": "剪刀",
      "3": "布",
    }[result];
    return resultName ? `[猜拳：${resultName}]` : result ? `[猜拳：结果 ${result}]` : "[猜拳]";
  }

  return "";
}

function formatFaceSemantic(data) {
  const id = String(data?.id ?? "").trim();
  const raw = data?.raw && typeof data.raw === "object" ? data.raw : {};
  const providedName = firstMeaningfulText([
    data?.summary,
    data?.name,
    data?.text,
    raw?.summary,
    raw?.faceText,
    raw?.name,
  ]);
  const name = providedName || QQ_FACE_NAMES[id] || "";
  const label = name
    ? `[QQ表情：${name}]`
    : id
      ? `[QQ表情 ID：${id}]`
      : "[QQ表情]";
  const chainCount = Number(data?.chainCount ?? data?.chain_count);
  const resultId = String(data?.resultId ?? data?.result_id ?? "").trim();
  const details = [];
  if (resultId) {
    details.push(`结果 ${resultId}`);
  }
  if (Number.isFinite(chainCount) && chainCount > 1) {
    details.push(`连续 ${Math.floor(chainCount)} 次`);
  }
  return details.length > 0 ? `${label}（${details.join("，")}）` : label;
}

function formatMarketFaceSemantic(data) {
  const summary = firstMeaningfulText([
    data?.summary,
    data?.name,
    data?.text,
  ]);
  if (summary) {
    return `[QQ表情包：${summary}]`;
  }

  const emojiId = String(data?.emoji_id ?? data?.emojiId ?? "").trim();
  return emojiId ? `[QQ表情包 ID：${emojiId}]` : "[QQ表情包]";
}

function firstMeaningfulText(values) {
  for (const value of values) {
    const text = String(value || "")
      .replace(/^\[+|\]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !["图片", "动画表情", "表情"].includes(text)) {
      return text.slice(0, 80);
    }
  }
  return "";
}

function isMarketFaceImage(data) {
  const file = String(data?.file || "").toLowerCase();
  return Boolean(
    data?.emoji_id ||
    data?.emojiId ||
    data?.emoji_package_id ||
    data?.emojiPackageId ||
    file === "marketface",
  );
}

function isSupportedImageSource(value) {
  return /^(?:https?:\/\/|data:image\/|base64:\/\/)/i.test(
    String(value || "").trim(),
  );
}

function normalizeSemanticText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

const QQ_FACE_NAMES = Object.freeze({
  "0": "惊讶",
  "1": "撇嘴",
  "2": "色",
  "3": "发呆",
  "4": "得意",
  "5": "流泪",
  "6": "害羞",
  "7": "闭嘴",
  "8": "睡",
  "9": "大哭",
  "10": "尴尬",
  "11": "发怒",
  "12": "调皮",
  "13": "呲牙",
  "14": "微笑",
  "15": "难过",
  "16": "酷",
  "18": "抓狂",
  "19": "吐",
  "20": "偷笑",
  "21": "可爱",
  "22": "白眼",
  "23": "傲慢",
  "24": "饥饿",
  "25": "困",
  "26": "惊恐",
  "27": "流汗",
  "28": "憨笑",
  "29": "悠闲",
  "30": "奋斗",
  "31": "咒骂",
  "32": "疑问",
  "33": "嘘",
  "34": "晕",
  "35": "折磨",
  "36": "衰",
  "37": "骷髅",
  "38": "敲打",
  "39": "再见",
  "49": "拥抱",
  "53": "蛋糕",
  "63": "玫瑰",
  "64": "凋谢",
  "66": "爱心",
  "67": "心碎",
  "74": "太阳",
  "75": "月亮",
  "76": "赞",
  "77": "踩",
  "78": "握手",
  "79": "胜利",
  "85": "飞吻",
  "89": "西瓜",
  "96": "冷汗",
  "97": "擦汗",
  "98": "抠鼻",
  "99": "鼓掌",
  "100": "糗大了",
  "101": "坏笑",
  "104": "哈欠",
  "105": "鄙视",
  "106": "委屈",
  "107": "快哭了",
  "108": "阴险",
  "109": "亲亲",
  "110": "吓",
  "111": "可怜",
  "118": "抱拳",
  "119": "勾引",
  "120": "拳头",
  "121": "差劲",
  "122": "爱你",
  "123": "NO",
  "124": "OK",
  "174": "眨眼睛",
  "175": "泪奔",
  "176": "无奈",
  "177": "卖萌",
  "178": "小纠结",
  "179": "喷血",
  "180": "斜眼笑",
  "181": "doge",
  "182": "惊喜",
  "183": "骚扰",
  "184": "笑哭",
  "185": "我最美",
  "192": "大笑",
  "193": "不开心",
  "194": "冷漠",
  "198": "机器人",
  "200": "拜托",
});

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
  extractSemanticMessageText,
  limitImagesInMessages,
  selectCompleteRecentHistory,
  trimQwenMessagesToBudget,
};
