const {
  DeepSeekSearchProvider,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
} = require("./vendor/deepseek-harness/search-provider");
const {
  WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_RESULTS,
  parseSearchArgs, runSearchQueries, formatSearchOutput,
} = require("./vendor/deepseek-harness/search-tool");
const { HttpFetchProvider } = require("./vendor/deepseek-harness/fetch-provider");
const { renderFetchOutput, TRUNCATION_FOOTER } = require("./vendor/deepseek-harness/fetch-tool");
const { EXTERNAL_WEB_CONTENT_NOTICE } = require("./vendor/deepseek-harness/trust");
const { WebError, deadline, timeoutOf } = require("./vendor/deepseek-harness/runtime");

function usesDeepSeekHarness(config = {}) {
  return ["deepseek-official", "deepseek", "deepseek-harness"].includes(
    String(config.webSearchProvider || DEEPSEEK_PROVIDER_ID).trim().toLowerCase(),
  );
}

// The Cordis/plugin services are replaced by this small bot adapter. Wire protocol,
// result mapping, multi-query merge, public HTTP transport and Markdown rendering
// live in the reviewed upstream port under vendor/deepseek-harness.
class DeepSeekHarnessWebToolRunner {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || console;
    this.maxQueries = positiveInteger(config.webSearchMaxQueries, WEB_SEARCH_MAX_QUERIES, 4);
    this.maxResults = positiveInteger(config.webSearchMaxResults, WEB_SEARCH_MAX_RESULTS, 50);
    this.fetchMaxOutputChars = positiveInteger(config.webFetchMaxOutputChars, 200000, 200000);
    this.searchProvider = options.searchProvider || new DeepSeekSearchProvider(() => {
      // Resolve one immutable endpoint/key/model snapshot per auxiliary request.
      const baseURL = String(config.deepseekSearchBaseUrl || DEEPSEEK_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
      const parsed = new URL(baseURL);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new WebError("DEEPSEEK_SEARCH_BASE_URL must be a trusted HTTP(S) API base without credentials, query or fragment", "WEB_INVALID_URL");
      }
      return {
        apiKey: config.deepseekApiKey || "",
        baseURL,
        model: config.deepseekSearchModel || DEEPSEEK_DEFAULT_MODEL,
        apiVersion: config.deepseekSearchApiVersion || DEEPSEEK_DEFAULT_API_VERSION,
        maxTokens: positiveInteger(config.deepseekSearchMaxTokens, DEEPSEEK_DEFAULT_MAX_TOKENS, 32768),
        maxUses: positiveInteger(config.deepseekSearchMaxUses, DEEPSEEK_DEFAULT_MAX_USES, 20),
        recordRequest: options.recordSearchRequest,
        recordResponse: (payload) => {
          const usage = payload?.usage;
          if (usage && config.webSearchDiagnosticsEnabled !== false) {
            this.logger.log(`[webtools] provider=${DEEPSEEK_PROVIDER_ID} model=${payload.model || config.deepseekSearchModel || DEEPSEEK_DEFAULT_MODEL} input_tokens=${usage.input_tokens || 0} cache_read_input_tokens=${usage.cache_read_input_tokens || 0} output_tokens=${usage.output_tokens || 0} native_searches=${usage.server_tool_use?.web_search_requests || 0}`);
          }
          options.recordSearchResponse?.(payload);
        },
      };
    }, options.fetch || globalThis.fetch);
    this.fetchProvider = options.fetchProvider || new HttpFetchProvider({
      maxResponseBytes: positiveInteger(config.webFetchMaxResponseBytes, 5000000, 16 * 1024 * 1024),
      maxBodyChars: positiveInteger(config.webFetchMaxBodyChars, 100000, 200000),
      timeoutMs: positiveInteger(config.webFetchTimeoutMs, 30000, 120000),
      maxRedirects: 5,
      userAgent: "sandstorm-qq-bot/1.0 deepseek-harness-web",
    });
  }

  setUserQuery() {
    // Harness forwards only the model's queries, without rewriting from group history.
  }

  getToolDefinitions() {
    return [{
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information. Returns source URLs and citation snippets.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            queries: { type: "array", minItems: 1, maxItems: this.maxQueries,
              items: { type: "string" }, description: `1–${this.maxQueries} search queries; their results are merged.` },
          },
          required: ["queries"],
        },
      },
    }, {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the content of a specific HTTP(S) URL and return it decoded to text.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { url: { type: "string", description: "The HTTP(S) URL to fetch." } },
          required: ["url"],
        },
      },
    }];
  }

  async runToolCall(toolCall, options = {}) {
    try {
      const args = JSON.parse(toolCall?.function?.arguments || "{}");
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new WebError("Tool arguments must be a JSON object", "WEB_INVALID_ARGUMENT");
      }
      if (toolCall?.function?.name === "web_search") return await this.search(args, options.signal);
      if (toolCall?.function?.name === "web_fetch") return await this.fetchPage(args, options.signal);
      throw new WebError("Unknown web tool", "WEB_INVALID_ARGUMENT");
    } catch (error) {
      const message = String(error?.message || error);
      const secret = this.config.deepseekApiKey;
      return {
        error: secret ? message.split(secret).join("[REDACTED]") : message,
        code: error?.code || "WEB_INVALID_ARGUMENT",
        provider: DEEPSEEK_PROVIDER_ID,
      };
    }
  }

  async search(args, signal) {
    assertKeys(args, ["queries"]);
    const queries = parseSearchArgs(args, this.maxQueries);
    const d = deadline(signal, positiveInteger(this.config.webSearchTimeoutMs, 30000, 120000), "WEB_SEARCH_TIMEOUT");
    const ctx = { web: { search: async (request, requestSignal) => {
      const result = await this.searchProvider.search(request, requestSignal);
      // In Harness the shared web service applies this per-query source cap.
      return { sources: result.sources.slice(0, request.maxResults),
        truncated: result.truncated || result.sources.length > request.maxResults };
    } } };
    try {
      return await runSearchQueries(ctx, queries, this.maxResults, d.signal);
    } catch (error) {
      if (timeoutOf(d.signal, "WEB_SEARCH_TIMEOUT")) {
        throw new WebError("DeepSeek web search timed out", "WEB_SEARCH_TIMEOUT", { cause: error });
      }
      throw error;
    } finally {
      d.dispose();
    }
  }

  async fetchPage(args, signal) {
    assertKeys(args, ["url"]);
    if (typeof args.url !== "string" || !args.url.trim()) {
      throw new WebError("url must be a non-empty string", "WEB_INVALID_ARGUMENT");
    }
    // Direct public URLs are supported, including links supplied by the user.
    // The upstream provider validates DNS, pins addresses and rejects cross-origin redirects.
    return this.fetchProvider.fetch({ url: args.url }, signal);
  }

  formatToolResult(toolCall, result) {
    if (result?.error) return JSON.stringify(result);
    if (toolCall?.function?.name === "web_search" && Array.isArray(result?.sources)) {
      const text = formatSearchOutput(result);
      const hint = this.getEvidenceRecoveryHint(toolCall, result);
      return hint ? `${text}\n\nEvidence status: discovery_only.\n${hint}` : text;
    }
    if (toolCall?.function?.name === "web_fetch" && result?.body) {
      const text = renderFetchOutput(result, this.fetchMaxOutputChars).text;
      return result.source_id ? `${text}\n\nSource ID: 【${result.source_id}】` : text;
    }
    return JSON.stringify(result);
  }

  getEvidenceRecoveryHint(toolCall, result) {
    if (toolCall?.function?.name !== "web_search" || result?.error
      || !Array.isArray(result?.sources) || !result.sources.some((source) => isWebSourceUrl(source.url))
      || this.hasUsableEvidence(toolCall, result)) return "";
    return "搜索已找到候选网页，但本次结果只有标题和网址，没有引用片段或正文。若要回答具体事实，请先用 web_fetch 读取相关来源；已有候选链接时优先读正文，不要反复搜同一个问题。读取失败可换另一个来源，也可以说明本次未能查证。不能根据标题、网址或模型记忆声称已经核实，也不能把没有读到正文说成没有相关事件。";
  }

  hasUsableEvidence(toolCall, result) {
    if (!result || result.error) return false;
    if (toolCall?.function?.name === "web_search") {
      // Only actual cited_text joined by URL is returned by the native provider.
      // Generated prose, result titles and encrypted_content are never evidence.
      return Array.isArray(result.sources) && result.sources.some((source) =>
        isWebSourceUrl(source.url) && typeof source.snippet === "string" && source.snippet.trim());
    }
    if (toolCall?.function?.name === "web_fetch") {
      return hasReadableHarnessPage(result, this.fetchMaxOutputChars);
    }
    return false;
  }
}

function hasReadableHarnessPage(result, maxOutputChars = 200000) {
  if (!result?.body || result.error || result.statusCode < 200 || result.statusCode >= 300
    || !Number.isInteger(result.statusCode) || !isWebSourceUrl(result.url)) return false;
  const { text } = renderFetchOutput(result, maxOutputChars);
  const header = `Fetched ${result.url} (HTTP ${result.statusCode})\n\n${EXTERNAL_WEB_CONTENT_NOTICE}\n\n`;
  if (!text.startsWith(header)) return false;
  const content = text.slice(header.length).replace(TRUNCATION_FOOTER, "").trim();
  return Boolean(content && content !== "[HTML content omitted: unable to convert safely.]");
}

function isWebSourceUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function assertKeys(args, accepted) {
  if (Object.keys(args).some((key) => !accepted.includes(key))) {
    throw new WebError(`Only these arguments are accepted: ${accepted.join(", ")}`, "WEB_INVALID_ARGUMENT");
  }
}

module.exports = { DeepSeekHarnessWebToolRunner, usesDeepSeekHarness, hasReadableHarnessPage };
