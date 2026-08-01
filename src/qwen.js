const { DeepSeekChatService } = require("./deepseek");

class LocalQwenRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LocalQwenRequestError";
    this.status = options.status;
    this.responseDetails = options.responseDetails || "";
    this.code = options.code || "LOCAL_QWEN_REQUEST_FAILED";
  }
}

class LocalQwenChatService extends DeepSeekChatService {
  constructor(config, options = {}) {
    super(config);
    this.fetch = options.fetch || globalThis.fetch;
    this.logger = options.logger || console;
    this.healthStatus = "unknown";
    this.healthReason = "";
    this.healthTimer = null;
    this.healthCheckPromise = null;
  }

  isConfigured() {
    return Boolean(
      this.config.localQwenEnabled &&
      this.config.localQwenApiKey &&
      this.config.localQwenBaseUrl &&
      this.config.localQwenModel
    );
  }

  isHealthy() {
    return this.isConfigured() && this.healthStatus === "healthy";
  }

  async startHealthChecks(options = {}) {
    if (!this.isConfigured() || this.healthTimer) {
      return this.isHealthy();
    }

    if (options.probeImmediately !== false) {
      await this.checkHealth();
    }

    this.healthTimer = setInterval(() => {
      this.checkHealth().catch((error) => {
        this.logger.error("[ai] Local Qwen health check failed:", error.message);
      });
    }, this.config.localQwenHealthIntervalMs);
    this.healthTimer.unref?.();

    return this.isHealthy();
  }

  stopHealthChecks() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  checkHealth() {
    if (!this.isConfigured()) {
      this.setHealth("unhealthy", "not configured");
      return Promise.resolve(false);
    }

    if (this.healthCheckPromise) {
      return this.healthCheckPromise;
    }

    this.healthCheckPromise = this.checkHealthUnlocked()
      .catch((error) => {
        this.setHealth("unhealthy", error.message);
        return false;
      })
      .finally(() => {
        this.healthCheckPromise = null;
      });

    return this.healthCheckPromise;
  }

  async checkHealthUnlocked() {
    const controller = new AbortController();
    const timeoutMs = this.config.localQwenHealthTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetch(this.buildEndpoint(this.config.localQwenHealthPath), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.localQwenApiKey}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = redactSecret(
          await readResponseText(response),
          this.config.localQwenApiKey,
        );
        throw new LocalQwenRequestError(
          `health endpoint returned ${response.status}${details ? `: ${details}` : ""}`,
          {
            status: response.status,
            responseDetails: details,
            code: "LOCAL_QWEN_HEALTH_FAILED",
          },
        );
      }

      this.setHealth("healthy", `HTTP ${response.status}`);
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new LocalQwenRequestError(`health check timed out after ${timeoutMs}ms`, {
          code: "LOCAL_QWEN_HEALTH_TIMEOUT",
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  markUnavailable(reason) {
    this.setHealth("unhealthy", reason || "request failed");
  }

  markHealthy(reason) {
    this.setHealth("healthy", reason || "request succeeded");
  }

  setHealth(status, reason) {
    const previous = this.healthStatus;
    this.healthStatus = status;
    this.healthReason = redactSecret(String(reason || ""), this.config.localQwenApiKey);

    if (previous === status) {
      return;
    }

    const level = status === "healthy" ? "log" : "warn";
    this.logger[level](
      `[ai] provider=${this.config.localQwenProviderId} health=${status} reason=${this.healthReason}`,
    );
  }

  buildEndpoint(path) {
    const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
    return `${this.config.localQwenBaseUrl}${normalizedPath}`;
  }

  async createCompletion(messages, options = {}) {
    const preparedMessages = await prepareQwenMessages(
      messages,
      this.config,
      this.fetch,
      this.logger,
    );
    return super.createCompletion(preparedMessages, options);
  }

  buildCompletionBody(messages, useThinking, overrides = {}) {
    const configuredLimit = Math.min(
      this.config.localQwenModelMaxOutputTokens,
      useThinking
        ? this.config.localQwenThinkingMaxOutputTokens
        : this.config.localQwenMaxOutputTokens,
    );
    const requestedLimit = overrides.maxOutputTokens || configuredLimit;
    const maxOutputTokens = Math.max(
      1,
      Math.min(requestedLimit, this.config.localQwenModelMaxOutputTokens),
    );
    const body = {
      model: this.config.localQwenModel,
      messages,
      stream: false,
      max_tokens: maxOutputTokens,
    };

    if (useThinking) {
      body.reasoning_effort = this.config.localQwenReasoningEffort;
    } else {
      body.temperature = overrides.temperature ?? this.config.localQwenTemperature;
    }

    return body;
  }

  async requestCompletion(body, options = {}) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || this.config.localQwenTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetch(this.buildEndpoint("/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.localQwenApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = redactSecret(
          await readResponseText(response),
          this.config.localQwenApiKey,
        );
        throw new LocalQwenRequestError(
          `Local Qwen API ${response.status}: ${details || response.statusText}`,
          {
            status: response.status,
            responseDetails: details,
          },
        );
      }

      const payload = await response.json();
      logCompletionUsage(this.config, body, payload, this.logger);
      this.markHealthy("chat completion succeeded");
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new LocalQwenRequestError(`Local Qwen API timed out after ${timeoutMs}ms`, {
          code: "LOCAL_QWEN_TIMEOUT",
        });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function prepareQwenMessages(messages, config, fetchImpl, logger) {
  const imageEntries = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message?.content)) {
      return;
    }

    message.content.forEach((part, partIndex) => {
      if (part?.type === "image_ref" || part?.type === "image_url") {
        imageEntries.push({
          position: `${messageIndex}:${partIndex}`,
          part,
        });
      }
    });
  });

  const imageLimit = Math.max(0, config.localQwenMaxImages);
  const selectedImageEntries =
    imageLimit === 0 ? [] : imageEntries.slice(-imageLimit);
  const allowedImagePositions = new Set(
    selectedImageEntries.map((entry) => entry.position),
  );
  let totalImageBytes = 0;
  const preparedImages = new Map();
  const imageOmissions = new Map();

  for (const entry of selectedImageEntries.slice().reverse()) {
    if (entry.part.type === "image_url") {
      preparedImages.set(entry.position, entry.part);
      continue;
    }

    try {
      const image = await loadImageAsDataUrl(entry.part, config, fetchImpl);
      if (totalImageBytes + image.byteLength > config.localQwenImagesMaxTotalBytes) {
        delete entry.part.cachedDataUrl;
        delete entry.part.cachedByteLength;
        imageOmissions.set(entry.position, "total-size");
        continue;
      }

      totalImageBytes += image.byteLength;
      preparedImages.set(entry.position, {
        type: "image_url",
        image_url: {
          url: image.dataUrl,
        },
      });
    } catch (error) {
      logger.warn(
        `[ai] Local Qwen image omitted source=${safeImageSource(entry.part.source)} reason=${error.message}`,
      );
      imageOmissions.set(entry.position, "load-failed");
    }
  }

  const prepared = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!Array.isArray(message?.content)) {
      prepared.push({ ...message });
      continue;
    }

    const content = [];
    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex];
      const position = `${messageIndex}:${partIndex}`;

      if (part?.type === "text") {
        content.push({ type: "text", text: String(part.text || "") });
        continue;
      }

      if (part?.type !== "image_ref" && part?.type !== "image_url") {
        continue;
      }

      if (!allowedImagePositions.has(position)) {
        content.push({ type: "text", text: "[较早图片已省略]" });
        continue;
      }

      if (preparedImages.has(position)) {
        content.push(preparedImages.get(position));
      } else if (imageOmissions.get(position) === "total-size") {
        content.push({ type: "text", text: "[图片因总大小限制未发送]" });
      } else {
        content.push({ type: "text", text: "[图片加载失败，无法发送给视觉模型]" });
      }
    }

    prepared.push({
      ...message,
      content: compactMultimodalContent(content),
    });
  }

  return prepared;
}

async function loadImageAsDataUrl(part, config, fetchImpl) {
  if (part.cachedDataUrl) {
    return {
      dataUrl: part.cachedDataUrl,
      byteLength: part.cachedByteLength,
    };
  }

  const source = String(part.source || "").trim();
  if (!source) {
    throw new Error("empty image source");
  }

  if (source.startsWith("data:image/")) {
    const parsed = parseDataUrl(source);
    enforceImageSize(parsed.byteLength, config.localQwenImageMaxBytes);
    part.cachedDataUrl = source;
    part.cachedByteLength = parsed.byteLength;
    return { dataUrl: source, byteLength: parsed.byteLength };
  }

  if (source.startsWith("base64://")) {
    const dataUrl = `data:image/jpeg;base64,${source.slice("base64://".length)}`;
    const parsed = parseDataUrl(dataUrl);
    enforceImageSize(parsed.byteLength, config.localQwenImageMaxBytes);
    part.cachedDataUrl = dataUrl;
    part.cachedByteLength = parsed.byteLength;
    return { dataUrl, byteLength: parsed.byteLength };
  }

  if (!/^https?:\/\//i.test(source)) {
    throw new Error("unsupported image source");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.localQwenImageFetchTimeoutMs);

  try {
    const response = await fetchImpl(source, {
      method: "GET",
      headers: {
        Accept: "image/*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`image download returned HTTP ${response.status}`);
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength)) {
      enforceImageSize(declaredLength, config.localQwenImageMaxBytes);
    }

    const buffer = await readBodyWithLimit(response, config.localQwenImageMaxBytes);
    const contentType = normalizeImageContentType(
      response.headers.get("content-type"),
      buffer,
    );
    const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    part.cachedDataUrl = dataUrl;
    part.cachedByteLength = buffer.length;
    return { dataUrl, byteLength: buffer.length };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`image download timed out after ${config.localQwenImageFetchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyWithLimit(response, limit) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    enforceImageSize(buffer.length, limit);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      total += chunk.length;
      enforceImageSize(total, limit);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return Buffer.concat(chunks, total);
}

function enforceImageSize(byteLength, limit) {
  if (byteLength > limit) {
    throw new Error(`image exceeds ${limit} byte limit`);
  }
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error("invalid image data URL");
  }

  return {
    contentType: match[1].toLowerCase(),
    byteLength: Buffer.from(match[2], "base64").length,
  };
}

function normalizeImageContentType(value, buffer) {
  const contentType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType.startsWith("image/")) {
    return contentType;
  }

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return "image/gif";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  throw new Error(`unsupported image content type: ${contentType || "unknown"}`);
}

function compactMultimodalContent(content) {
  const compacted = content.filter((part) => {
    return part.type !== "text" || String(part.text || "").trim();
  });

  if (compacted.length === 0) {
    return "[空消息]";
  }

  if (compacted.length === 1 && compacted[0].type === "text") {
    return compacted[0].text;
  }

  return compacted;
}

function safeImageSource(value) {
  const source = String(value || "");
  if (source.startsWith("data:") || source.startsWith("base64://")) {
    return "inline-image";
  }

  try {
    return new URL(source).host || "unknown";
  } catch {
    return "unknown";
  }
}

function logCompletionUsage(config, body, payload, logger) {
  const usage = payload?.usage;
  if (!usage) {
    return;
  }

  const prompt = usage.prompt_tokens ?? "?";
  const completion = usage.completion_tokens ?? "?";
  const total = usage.total_tokens ?? "?";
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const finishReason = payload?.choices?.[0]?.finish_reason || "?";
  logger.log(
    `[ai] provider=${config.localQwenProviderId} model=${body.model} tools=${Boolean(body.tools)} finish=${finishReason} prompt=${prompt} completion=${completion} total=${total} cached=${cached}`,
  );
}

async function readResponseText(response) {
  const text = await response.text();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function redactSecret(value, secret) {
  if (!secret) {
    return value;
  }
  return String(value).split(secret).join("<redacted>");
}

module.exports = {
  LocalQwenChatService,
  LocalQwenRequestError,
  prepareQwenMessages,
};
