const { WebToolRunner } = require("./webtools");

class DeepSeekChatService {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.sessionLocks = new Map();
  }

  isConfigured() {
    return Boolean(this.config.deepseekApiKey);
  }

  resetSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  async chat(sessionId, userText, meta = {}) {
    if (!this.isConfigured()) {
      return "DeepSeek API Key 还没有配置，请在 .env 中设置 DEEPSEEK_API_KEY。";
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
      return "DeepSeek API Key 还没有配置，请在 .env 中设置 DEEPSEEK_API_KEY。";
    }

    const messages = this.trimMessages([
      {
        role: "system",
        content: this.buildSystemPrompt(this.config.ambientChatSystemPrompt),
      },
      {
        role: "user",
        content: this.formatUserMessage(userText, meta),
      },
    ]);

    const payload = await this.requestCompletion(
      this.buildCompletionBody(messages, false, {
        maxOutputTokens: this.config.ambientChatMaxOutputTokens,
        temperature: Math.max(0.7, this.config.deepseekTemperature),
      }),
      {
        timeoutMs: this.config.ambientChatTimeoutMs,
      },
    );
    return extractAssistantContent(payload);
  }

  async chatUnlocked(sessionId, userText, meta) {
    const session = this.getSession(sessionId);
    const userMessage = {
      role: "user",
      content: this.formatUserMessage(userText, meta),
    };

    const messages = this.buildMessages(session, userMessage);
    const assistantText = await this.createCompletion(messages, {
      thinking: Boolean(meta.thinking),
      webSearch: Boolean(meta.webSearch),
    });

    session.messages.push({ role: "user", content: userText });
    session.messages.push({ role: "assistant", content: assistantText });
    session.updatedAt = Date.now();
    this.trimSession(session);
    this.cleanupExpiredSessions();

    return assistantText;
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

  buildMessages(_session, userMessage) {
    return this.trimMessages([
      {
        role: "system",
        content: this.buildSystemPrompt(this.config.deepseekSystemPrompt),
      },
      userMessage,
    ]);
  }

  buildSystemPrompt(basePrompt) {
    return [basePrompt, this.config.responseNeutralityPrompt]
      .filter((part) => String(part || "").trim())
      .join("\n\n");
  }

  trimSession(session) {
    const maxHistory = Math.max(2, this.config.chatMaxHistoryMessages);
    if (session.messages.length > maxHistory) {
      session.messages = session.messages.slice(-maxHistory);
    }

    session.messages = this.trimMessages(session.messages);
  }

  trimMessages(messages) {
    const maxChars = Math.max(1000, this.config.chatMaxContextChars);
    const trimmed = messages.slice();

    while (trimmed.length > 1 && countChars(trimmed) > maxChars) {
      const removeIndex = trimmed[0]?.role === "system" && trimmed.length > 2 ? 1 : 0;
      trimmed.splice(removeIndex, 1);
    }

    return trimmed;
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isExpired(session, now)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  formatUserMessage(userText, meta) {
    const sender = meta.senderName ? `用户昵称：${meta.senderName}\n` : "";
    return `${sender}用户消息：${userText}`;
  }

  async createCompletion(messages, options = {}) {
    const normalizedOptions = typeof options === "boolean" ? { thinking: options } : options;
    const useThinking = Boolean(normalizedOptions.thinking);
    const useWebSearch = Boolean(normalizedOptions.webSearch);

    if (useWebSearch) {
      return this.createCompletionWithWebTools(messages, useThinking);
    }

    const payload = await this.requestCompletion(this.buildCompletionBody(messages, useThinking));
    return extractAssistantContent(payload);
  }

  async createCompletionWithWebTools(messages, useThinking) {
    const runner = new WebToolRunner(this.config);
    runner.setUserQuery(extractLatestUserText(messages));
    const workingMessages = this.buildWebSearchMessages(messages);
    const maxRounds = Math.max(1, this.config.webSearchMaxToolRounds);
    const maxCallsPerRound = Math.max(1, this.config.webSearchMaxToolCallsPerRound);

    for (let round = 1; round <= maxRounds; round += 1) {
      const payload = await this.requestCompletion({
        ...this.buildCompletionBody(workingMessages, useThinking),
        tools: runner.getToolDefinitions(),
        tool_choice: "auto",
      });

      const message = payload?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length === 0) {
        return extractAssistantContent(payload);
      }

      workingMessages.push(buildAssistantToolMessage(message));

      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index];
        let result;

        if (index >= maxCallsPerRound) {
          result = {
            error: `Skipped: maximum tool calls per round is ${maxCallsPerRound}.`,
            reliability_guidance: "Use the available tool results only. If evidence is insufficient, say so.",
          };
        } else {
          try {
            result = await runner.runToolCall(toolCall);
          } catch (error) {
            console.error(`[webtools] ${toolCall?.function?.name || "unknown"} failed:`, error.message);
            result = {
              error: error.message,
              reliability_guidance:
                "This tool call failed. Use other available tool results only. If evidence is insufficient, say so.",
            };
          }
        }

        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    workingMessages.push({
      role: "user",
      content:
        "工具轮次已用完。请仅基于已有工具结果回答；关键事实标注来源，证据不足就说明不确定。",
    });

    const payload = await this.requestCompletion({
      ...this.buildCompletionBody(workingMessages, useThinking),
    });
    return extractAssistantContent(payload);
  }

  buildCompletionBody(messages, useThinking, overrides = {}) {
    const body = {
      model: useThinking ? "deepseek-v4-pro" : this.config.deepseekModel,
      messages,
      stream: false,
      max_tokens:
        overrides.maxOutputTokens ||
        (useThinking ? this.config.deepseekThinkingMaxOutputTokens : this.config.deepseekMaxOutputTokens),
      thinking: {
        type: useThinking ? "enabled" : "disabled",
      },
    };

    if (useThinking) {
      body.reasoning_effort = this.config.deepseekReasoningEffort;
    } else {
      body.temperature = overrides.temperature ?? this.config.deepseekTemperature;
    }

    return body;
  }

  buildWebSearchMessages(messages) {
    const now = new Date();
    const currentTime = formatCurrentTime(now);
    const webSearchSystemMessage = {
      role: "system",
      content:
        `联网搜索开启。当前真实时间：${currentTime}。必须先用 web_search；仅在摘要不足以确认关键事实时 web_fetch，最多抓取 ${this.config.webSearchMaxToolCallsPerRound} 个页面。最终只基于工具结果回答，数字/日期/政策/新闻等标注来源；证据弱或冲突就说明不确定。`,
    };

    if (messages[0]?.role === "system") {
      return [messages[0], webSearchSystemMessage, ...messages.slice(1)];
    }

    return [webSearchSystemMessage, ...messages];
  }

  async requestCompletion(body, options = {}) {
    const controller = new AbortController();
    const timeoutMs =
      options.timeoutMs ||
      (body.thinking?.type === "enabled" ? this.config.deepseekThinkingTimeoutMs : this.config.deepseekTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.deepseekApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = await readResponseText(response);
        throw new Error(`DeepSeek API ${response.status}: ${details || response.statusText}`);
      }

      const payload = await response.json();
      logCompletionUsage(body, payload);
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`DeepSeek API timed out after ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function formatCurrentTime(date) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  const offset = `${sign}${hours}:${minutes}`;
  const localTime = formatDateTimeParts(date);

  return `${localTime} ${offset} (${timeZone}); UTC ${date.toISOString()}`;
}

function formatDateTimeParts(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildAssistantToolMessage(message) {
  const result = {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    tool_calls: message.tool_calls,
  };

  if (typeof message.reasoning_content === "string") {
    result.reasoning_content = message.reasoning_content;
  }

  return result;
}

function extractAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    const finishReason = payload?.choices?.[0]?.finish_reason || "unknown";
    const usage = payload?.usage ? ` usage=${JSON.stringify(payload.usage)}` : "";
    throw new Error(`DeepSeek API returned an empty response finish_reason=${finishReason}${usage}`);
  }

  return content.trim();
}

function extractLatestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const content = String(message.content || "");
    const match = content.match(/用户消息：([\s\S]*)$/);
    return (match ? match[1] : content).trim();
  }

  return "";
}

function logCompletionUsage(body, payload) {
  const usage = payload?.usage;
  if (!usage) {
    return;
  }

  const prompt = usage.prompt_tokens ?? "?";
  const completion = usage.completion_tokens ?? "?";
  const total = usage.total_tokens ?? "?";
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const finishReason = payload?.choices?.[0]?.finish_reason || "?";
  console.log(
    `[deepseek] usage model=${body.model} tools=${Boolean(body.tools)} finish=${finishReason} prompt=${prompt} completion=${completion} total=${total} cached=${cached}`,
  );
}

function countChars(messages) {
  return messages.reduce((total, message) => {
    return total + String(message.content || "").length;
  }, 0);
}

async function readResponseText(response) {
  const text = await response.text();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

module.exports = { DeepSeekChatService };
