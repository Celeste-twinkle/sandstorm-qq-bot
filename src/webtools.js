const dns = require("dns").promises;
const crypto = require("crypto");
const net = require("net");
const path = require("path");

const USER_AGENT = "sandstorm-qq-bot/1.0 web-search";
const OPEN_WEBSEARCH_RUNTIME_BUNDLE = path.join(__dirname, "vendor", "open-websearch-runtime.cjs");
const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const DEFAULT_PROVIDER_CHAIN = ["exa", "parallel", "bing"];
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;

class WebToolRunner {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.logger = options.logger || console;
    this.allowedUrls = new Set();
    this.allowedUrlProviders = new Map();
    this.autoFetchAttemptedUrls = new Set();
    this.autoFetchReservedPages = 0;
    this.openWebSearchRuntimePromise = null;
    this.parallelSessionId = `sandstorm-qq-bot-${crypto.randomUUID()}`;
    this.userQuery = "";
    this.lastSearchQuery = "";
    this.lastRelevanceQuery = "";
  }

  setUserQuery(query) {
    this.userQuery = String(query || "").trim();
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the public web. Returns compact discovery results and may automatically attach readable evidence from top pages.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "A focused search query in the best language for the topic.",
              },
              max_results: {
                type: "integer",
                description: "Maximum results, from 1 to 5.",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          description:
            "Fetch compact readable evidence from an article or primary-source URL returned by web_search. Search-engine result pages are not allowed.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "A URL that appeared in a previous web_search result.",
              },
              max_chars: {
                type: "integer",
                description: "Maximum readable characters, from 500 to the configured cap.",
              },
            },
            required: ["url"],
          },
        },
      },
    ];
  }

  async runToolCall(toolCall) {
    const name = toolCall?.function?.name;
    const args = parseJson(toolCall?.function?.arguments);

    if (name === "web_search") {
      return this.search(args);
    }

    if (name === "web_fetch") {
      return this.fetchPage(args);
    }

    return {
      error: `Unknown web tool: ${name || "missing"}`,
    };
  }

  async search(args) {
    const query = String(args.query || "").trim();
    if (!query) {
      return { error: "web_search requires a non-empty query" };
    }

    this.lastSearchQuery = query;
    const relevanceQuery = combineQueries(this.userQuery, query);
    this.lastRelevanceQuery = relevanceQuery;
    const configuredMaxResults = clampInteger(this.config.webSearchMaxResults, 3, 1, 5);
    const maxResults = clampInteger(args.max_results, configuredMaxResults, 1, configuredMaxResults);
    const candidateResults = clampInteger(this.config.webSearchCandidateResults, 8, maxResults, 12);
    const searchQueries = buildSearchQueries(query, relevanceQuery);
    const payloads = [];

    for (const searchQuery of searchQueries) {
      payloads.push(await this.searchWithFallback(searchQuery, candidateResults));
    }
    const payload = mergeSearchPayloads(query, payloads);

    const rankedResults = rankSearchResults(
      relevanceQuery,
      payload.results || [],
      maxResults,
      this.config.webSearchMinRelevanceScore,
    );

    for (const result of rankedResults.results) {
      const url = normalizeUrl(result.url);
      this.allowedUrls.add(url);
      this.allowedUrlProviders.set(url, result.discovery_provider || payload.provider);
    }

    const autoFetchedPages = await this.autoFetchSearchEvidence(
      rankedResults.results,
    );
    const fetchedCount = autoFetchedPages.filter(
      (page) => page?.evidence_status === "fetched_page" && !page.error,
    ).length;
    const failedFetchCount = autoFetchedPages.length - fetchedCount;
    if (this.config.webSearchDiagnosticsEnabled !== false) {
      const providerFailureCodes = formatProviderFailureCodes(
        payload.partial_failures,
      );
      const autoFetchFailureCodes = formatProviderFailureCodes(
        autoFetchedPages.flatMap((page) => page?.fallback_failures || []),
      );
      this.logger.log(
        `[webtools] search provider=${payload.provider || "unknown"} results=${rankedResults.results.length} provider_failures=${(payload.partial_failures || []).length} provider_failure_codes=${providerFailureCodes} auto_fetch_ok=${fetchedCount} auto_fetch_failed=${failedFetchCount} auto_fetch_failure_codes=${autoFetchFailureCodes}`,
      );
    }

    return {
      ...payload,
      results: rankedResults.results,
      auto_fetched_pages: autoFetchedPages,
      filtered_count: rankedResults.filteredCount,
      searched_at: new Date().toISOString(),
      evidence_status:
        fetchedCount > 0 ? "discovery_with_fetched_pages" : "discovery_only",
      guidance:
        fetchedCount > 0
          ? "Search snippets are discovery only. auto_fetched_pages contains readable page evidence that may be cited by source_id after the caller registers it."
          : "Search snippets are discovery only, not final evidence. Fetch the key primary/article pages; say uncertain if reliable pages are unavailable.",
    };
  }

  async fetchPage(args) {
    const url = normalizeUrl(args.url);
    if (!url) {
      return { error: "web_fetch requires a valid http(s) URL" };
    }

    if (!this.allowedUrls.has(url)) {
      return {
        url,
        error: "Blocked: web_fetch can only open URLs returned by web_search in this conversation.",
      };
    }

    if (isSearchEngineResultsUrl(url)) {
      return {
        url,
        error:
          "Blocked: search-engine result pages are not evidence. Use web_search for discovery, then fetch an article or primary source.",
      };
    }

    await assertPublicHttpUrl(url);

    const configuredMaxChars = clampInteger(this.config.webFetchMaxChars, 3000, 500, 12000);
    const requestedMaxChars = clampInteger(args.max_chars, configuredMaxChars, 500, configuredMaxChars);
    const maxChars = Math.min(requestedMaxChars, configuredMaxChars);
    return this.fetchWithFallback(url, maxChars);
  }

  async autoFetchSearchEvidence(results) {
    const maxPages = clampInteger(
      this.config.webSearchAutoFetchMaxPages,
      0,
      0,
      8,
    );
    const perSearch = clampInteger(
      this.config.webSearchAutoFetchPerSearch,
      1,
      0,
      4,
    );
    const remaining = Math.max(0, maxPages - this.autoFetchReservedPages);
    if (remaining === 0 || perSearch === 0) {
      return [];
    }

    const candidates = [];
    const seenDomains = new Set();
    const usableResults = (Array.isArray(results) ? results : [])
      .map((result, index) => ({
        index,
        url: normalizeUrl(result?.url),
        domain: getDomain(result?.url),
      }))
      .filter(
        (result) =>
          result.url &&
          !isSearchEngineResultsUrl(result.url) &&
          !this.autoFetchAttemptedUrls.has(result.url),
      );

    for (const result of usableResults) {
      if (candidates.length >= Math.min(remaining, perSearch)) {
        break;
      }
      if (result.domain && seenDomains.has(result.domain)) {
        continue;
      }
      seenDomains.add(result.domain);
      candidates.push(result);
    }
    for (const result of usableResults) {
      if (candidates.length >= Math.min(remaining, perSearch)) {
        break;
      }
      if (!candidates.some((candidate) => candidate.url === result.url)) {
        candidates.push(result);
      }
    }

    for (const candidate of candidates) {
      this.autoFetchAttemptedUrls.add(candidate.url);
    }
    this.autoFetchReservedPages += candidates.length;

    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          const result = await this.fetchPage({
            url: candidate.url,
            max_chars: this.config.webFetchMaxChars,
          });
          return {
            ...result,
            discovery_rank: candidate.index + 1,
            auto_fetched: true,
          };
        } catch (error) {
          return {
            ...failedFetchEvidence(
              candidate.url,
              undefined,
              sanitizeProviderError(error, this.config),
            ),
            discovery_rank: candidate.index + 1,
            auto_fetched: true,
          };
        }
      }),
    );
  }

  async searchWithFallback(query, maxResults) {
    const failures = [];
    const providers = buildSearchProviderChain(this.config);

    for (const provider of providers) {
      try {
        let payload;
        if (provider === "exa") {
          payload = await this.searchExaMcp(query, maxResults);
        } else if (provider === "parallel") {
          payload = await this.searchParallelMcp(query, maxResults);
        } else if (provider === "tavily") {
          payload = await searchTavily(this.config, query, maxResults, this.fetch);
        } else if (provider === "brave") {
          payload = await searchBrave(this.config, query, maxResults, this.fetch);
        } else if (provider === "open-websearch") {
          payload = await this.searchOpenWebSearch(query, maxResults);
        } else if (provider === "bing") {
          payload = await searchBingHtml(this.config, query, maxResults, this.fetch);
        } else {
          throw new Error(`Unsupported search provider: ${provider}`);
        }

        const results = (payload.results || []).filter((result) => normalizeUrl(result.url));
        if (results.length === 0) {
          throw new Error("returned no usable result URLs");
        }

        return {
          ...payload,
          results: results.map((result) => ({
            ...result,
            discovery_provider: provider,
          })),
          partial_failures: [
            ...failures,
            ...(payload.partial_failures || []),
          ],
        };
      } catch (error) {
        failures.push(providerFailure(provider, error, this.config));
      }
    }

    return {
      provider: "unavailable",
      query,
      partial_failures: failures,
      results: [],
    };
  }

  async searchExaMcp(query, maxResults) {
    const text = await callMcpTool({
      fetchImpl: this.fetch,
      url: this.config.exaMcpUrl || DEFAULT_EXA_MCP_URL,
      tool: "web_search_exa",
      args: {
        query,
        type: "auto",
        numResults: maxResults,
        livecrawl: "fallback",
        contextMaxCharacters: clampInteger(
          this.config.webSearchExaContextMaxChars,
          10000,
          1000,
          50000,
        ),
      },
      timeoutMs: getMcpTimeoutMs(this.config),
      headers: buildExaHeaders(this.config),
      label: "Exa MCP search",
    });
    const results = parseExaSearchText(text, this.config.webSearchSnippetMaxChars);
    return {
      provider: "exa-mcp",
      query,
      results,
    };
  }

  async searchParallelMcp(query, maxResults) {
    const text = await callMcpTool({
      fetchImpl: this.fetch,
      url: this.config.parallelMcpUrl || DEFAULT_PARALLEL_MCP_URL,
      tool: "web_search",
      args: {
        objective: query,
        search_queries: [query],
        session_id: this.parallelSessionId,
      },
      timeoutMs: getMcpTimeoutMs(this.config),
      headers: buildParallelHeaders(this.config),
      label: "Parallel MCP search",
    });
    const payload = parseMcpJsonText(text, "Parallel MCP search");
    if (payload.session_id) {
      this.parallelSessionId = String(payload.session_id).slice(0, 100);
    }
    const results = (payload.results || [])
      .slice(0, maxResults)
      .map((item) => normalizeSearchResult({
        title: item.title,
        url: item.url,
        snippet: (item.excerpts || []).join(" "),
        published_date: item.publish_date,
        source_type: classifySource(item.url),
      }, this.config.webSearchSnippetMaxChars));
    return {
      provider: "parallel-mcp",
      query,
      results,
      partial_failures: normalizeParallelWarnings(payload.warnings),
    };
  }

  async fetchWithFallback(url, maxChars) {
    const preferredProvider = this.allowedUrlProviders.get(url);
    const providers = buildFetchProviderChain(this.config, preferredProvider);
    const failures = [];

    for (const provider of providers) {
      try {
        let result;
        if (provider === "exa") {
          result = await this.fetchExaMcp(url, maxChars);
        } else if (provider === "parallel") {
          result = await this.fetchParallelMcp(url, maxChars);
        } else if (provider === "open-websearch") {
          result = await this.fetchOpenWebSearch(url, maxChars);
        } else if (provider === "direct") {
          result = await this.fetchDirect(url, maxChars);
        } else {
          continue;
        }

        if (result && !result.error && hasReadableEvidence(result)) {
          return {
            ...result,
            fetch_provider: provider,
            fallback_failures: failures,
          };
        }

        throw new Error(result?.error || "returned no usable evidence");
      } catch (error) {
        failures.push(providerFailure(provider, error, this.config));
      }
    }

    return {
      ...failedFetchEvidence(
        url,
        undefined,
        failures.map((failure) => `${failure.provider}: ${failure.message}`).join("; ") ||
          "all fetch providers failed",
      ),
      fallback_failures: failures,
    };
  }

  async fetchExaMcp(url, maxChars) {
    const text = await callMcpTool({
      fetchImpl: this.fetch,
      url: this.config.exaMcpUrl || DEFAULT_EXA_MCP_URL,
      tool: "web_fetch_exa",
      args: {
        urls: [url],
        maxCharacters: maxChars,
      },
      timeoutMs: getMcpTimeoutMs(this.config),
      headers: buildExaHeaders(this.config),
      label: "Exa MCP fetch",
    });
    return buildFetchedEvidence({
      url,
      text,
      maxChars,
      relevanceQuery: this.lastRelevanceQuery || this.lastSearchQuery,
      title: extractMarkdownTitle(text),
    });
  }

  async fetchParallelMcp(url, maxChars) {
    const text = await callMcpTool({
      fetchImpl: this.fetch,
      url: this.config.parallelMcpUrl || DEFAULT_PARALLEL_MCP_URL,
      tool: "web_fetch",
      args: {
        urls: [url],
        objective: String(this.lastRelevanceQuery || this.lastSearchQuery || "")
          .trim()
          .slice(0, 200) || null,
        search_queries: this.lastSearchQuery ? [this.lastSearchQuery] : null,
        full_content: false,
        session_id: this.parallelSessionId,
      },
      timeoutMs: getMcpTimeoutMs(this.config),
      headers: buildParallelHeaders(this.config),
      label: "Parallel MCP fetch",
    });
    const payload = parseMcpJsonText(text, "Parallel MCP fetch");
    if (payload.session_id) {
      this.parallelSessionId = String(payload.session_id).slice(0, 100);
    }
    const item = (payload.results || []).find(
      (candidate) => normalizeUrl(candidate.url) === url,
    ) || payload.results?.[0];
    const content = (item?.excerpts || []).join("\n");
    return buildFetchedEvidence({
      url: normalizeUrl(item?.url) || url,
      text: content,
      maxChars,
      relevanceQuery: this.lastRelevanceQuery || this.lastSearchQuery,
      title: item?.title || "",
      publishedDate: item?.publish_date,
    });
  }

  async fetchDirect(url, maxChars) {
    const timeoutMs = clampInteger(
      this.config.webSearchTimeoutMs,
      10000,
      1000,
      60000,
    );
    const deadline = Date.now() + timeoutMs;
    let currentUrl = url;

    for (let hop = 0; hop <= 5; hop += 1) {
      await assertPublicHttpUrl(currentUrl);
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetchWithTimeout(currentUrl, {
        timeoutMs: remainingMs,
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": this.config.webSearchLanguage || "zh-CN,zh;q=0.9,en;q=0.8",
        },
      }, this.fetch);

      if (isHttpRedirectStatus(response.status)) {
        const location = response.headers?.get?.("location");
        await response.body?.cancel?.();
        if (!location) {
          return failedFetchEvidence(
            currentUrl,
            response.status,
            `HTTP ${response.status} redirect without Location`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const html = await readResponseTextLimited(
        response,
        MAX_HTTP_RESPONSE_BYTES,
        remainingMs,
      );
      if (!response.ok) {
        return failedFetchEvidence(
          currentUrl,
          response.status,
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      const evidence = buildFetchedEvidence({
        url: currentUrl,
        text: htmlToText(html),
        maxChars,
        relevanceQuery: this.lastRelevanceQuery || this.lastSearchQuery,
        status: response.status,
      });
      return currentUrl === url
        ? evidence
        : {
            ...evidence,
            final_url: currentUrl,
          };
    }

    return failedFetchEvidence(
      currentUrl,
      undefined,
      "too many redirects",
    );
  }

  async searchOpenWebSearch(query, maxResults) {
    const runtime = await this.getOpenWebSearchRuntime();
    const configuredEngines = Array.isArray(this.config.openWebSearchEngines)
      ? this.config.openWebSearchEngines
      : [];
    const engines = configuredEngines.length > 0
      ? this.config.openWebSearchEngines
      : ["duckduckgo", "startpage", "sogou"];
    const result = await runtime.services.search.execute({
      query,
      engines,
      limit: maxResults,
      searchMode: this.config.openWebSearchMode,
    });

    return {
      provider: "open-websearch-embedded",
      query: result.query || query,
      engines: result.engines || engines,
      partial_failures: result.partialFailures || [],
      results: (result.results || []).map((item) => normalizeSearchResult({
        title: item.title,
        url: item.url,
        snippet: item.description || item.content || item.snippet,
        source_type: classifySource(item.url),
      }, this.config.webSearchSnippetMaxChars)),
    };
  }

  async fetchOpenWebSearch(url, maxChars) {
    const runtime = await this.getOpenWebSearchRuntime();
    const result = await runtime.services.fetchWeb.execute({
      url,
      maxChars,
      readability: true,
      includeLinks: false,
    });

    const status = Number(result.status);
    if (Number.isFinite(status) && status >= 400) {
      return failedFetchEvidence(
        result.finalUrl || result.url || url,
        status,
        `HTTP ${status}`,
      );
    }
    const content = result.content || result.text || "";
    if (!String(content).trim()) {
      return failedFetchEvidence(
        result.finalUrl || result.url || url,
        result.status,
        "empty response",
      );
    }
    const filtered = filterFetchedText(content, maxChars, this.lastRelevanceQuery || this.lastSearchQuery);
    if (!hasReadableEvidence(filtered)) {
      return failedFetchEvidence(
        result.finalUrl || result.url || url,
        result.status,
        "empty readable content",
      );
    }
    return {
      url: result.url || url,
      final_url: result.finalUrl || result.url || url,
      domain: getDomain(result.finalUrl || result.url || url),
      fetched_at: new Date().toISOString(),
      status: result.status,
      evidence_status: "fetched_page",
      title: result.title || "",
      facts: filtered.facts,
      text: filtered.text,
    };
  }

  async getOpenWebSearchRuntime() {
    if (!this.openWebSearchRuntimePromise) {
      this.openWebSearchRuntimePromise = importOpenWebSearchRuntime(this.config);
    }

    return this.openWebSearchRuntimePromise;
  }
}

function buildSearchProviderChain(config) {
  const configured = normalizeProviderName(config.webSearchProvider || "auto");
  const providers = configured === "auto"
    ? (
      Array.isArray(config.webSearchFallbackProviders) &&
      config.webSearchFallbackProviders.length > 0
        ? config.webSearchFallbackProviders
        : DEFAULT_PROVIDER_CHAIN
    )
    : [configured];

  return uniqueCompactList(providers.map(normalizeProviderName))
    .filter((provider) => {
      if (provider === "tavily") {
        return Boolean(config.tavilyApiKey);
      }
      if (provider === "brave") {
        return Boolean(config.braveSearchApiKey);
      }
      return ["exa", "parallel", "bing", "open-websearch"].includes(provider);
    });
}

function buildFetchProviderChain(config, preferredProvider) {
  const preferred = normalizeProviderName(preferredProvider);
  const searchProviders = buildSearchProviderChain(config);
  return uniqueCompactList([
    preferred,
    ...searchProviders.filter((provider) =>
      ["exa", "parallel", "open-websearch"].includes(provider)),
    "open-websearch",
    "direct",
  ]).filter((provider) =>
    ["exa", "parallel", "open-websearch", "direct"].includes(provider));
}

function normalizeProviderName(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (["auto", "resilient", "fallback"].includes(provider)) {
    return "auto";
  }
  if (["exa", "exa-mcp", "exa_mcp"].includes(provider)) {
    return "exa";
  }
  if (["parallel", "parallel-mcp", "parallel_mcp"].includes(provider)) {
    return "parallel";
  }
  if (["open-websearch", "open_websearch", "openwebsearch", "embedded"].includes(provider)) {
    return "open-websearch";
  }
  if (["bing", "bing-html", "bing_html"].includes(provider)) {
    return "bing";
  }
  return provider;
}

async function importOpenWebSearchRuntime(config) {
  const previousQuietStartup = process.env.OPEN_WEBSEARCH_QUIET_STARTUP;
  const previousDefaultEngine = process.env.DEFAULT_SEARCH_ENGINE;
  const previousAllowedEngines = process.env.ALLOWED_SEARCH_ENGINES;
  const previousSearchMode = process.env.SEARCH_MODE;
  const previousFakeIpCidrs = process.env.FAKE_IP_CIDRS;

  process.env.OPEN_WEBSEARCH_QUIET_STARTUP = "true";
  process.env.DEFAULT_SEARCH_ENGINE = process.env.DEFAULT_SEARCH_ENGINE || "duckduckgo";
  process.env.ALLOWED_SEARCH_ENGINES = process.env.ALLOWED_SEARCH_ENGINES ||
    (config.openWebSearchEngines || []).join(",") ||
    "duckduckgo,startpage,sogou";
  process.env.SEARCH_MODE = process.env.SEARCH_MODE || "auto";
  process.env.FAKE_IP_CIDRS = process.env.FAKE_IP_CIDRS ||
    (config.openWebSearchFakeIpCidrs || []).join(",") ||
    "198.18.0.0/15";

  try {
    const module = require(OPEN_WEBSEARCH_RUNTIME_BUNDLE);
    return module.createOpenWebSearchRuntime();
  } finally {
    restoreEnv("OPEN_WEBSEARCH_QUIET_STARTUP", previousQuietStartup);
    restoreEnv("DEFAULT_SEARCH_ENGINE", previousDefaultEngine);
    restoreEnv("ALLOWED_SEARCH_ENGINES", previousAllowedEngines);
    restoreEnv("SEARCH_MODE", previousSearchMode);
    restoreEnv("FAKE_IP_CIDRS", previousFakeIpCidrs);
  }
}

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

async function callMcpTool({
  fetchImpl,
  url,
  tool,
  args,
  timeoutMs,
  headers,
  label,
}) {
  const endpoint = normalizeMcpEndpoint(url, label);
  const response = await fetchWithTimeout(endpoint, {
    timeoutMs,
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
      },
    }),
  }, fetchImpl);
  const body = await readResponseTextLimited(
    response,
    MAX_MCP_RESPONSE_BYTES,
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(
      `${label} HTTP ${response.status}: ${compactText(body, 240) || response.statusText}`,
    );
  }

  const envelopes = parseMcpResponseEnvelopes(body);
  for (const envelope of envelopes) {
    if (envelope?.error) {
      throw new Error(
        `${label} JSON-RPC error: ${compactText(
          envelope.error.message || JSON.stringify(envelope.error),
          240,
        )}`,
      );
    }

    const result = envelope?.result;
    if (!result || !Array.isArray(result.content)) {
      continue;
    }
    const text = result.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (result.isError) {
      throw new Error(`${label} tool error: ${compactText(text, 240) || "unknown error"}`);
    }
    if (text) {
      return text;
    }
  }

  throw new Error(`${label} returned no text content`);
}

function normalizeMcpEndpoint(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} has an invalid endpoint URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} endpoint must use http(s)`);
  }
  return parsed.toString();
}

function parseMcpResponseEnvelopes(body) {
  const values = [];
  const trimmed = String(body || "").trim();
  if (trimmed.startsWith("{")) {
    values.push(trimmed);
  }
  for (const line of String(body || "").split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      values.push(line.slice(6));
    }
  }

  const envelopes = [];
  for (const value of values) {
    try {
      envelopes.push(JSON.parse(value));
    } catch {
      // Ignore non-JSON SSE keepalive/events and continue to the next payload.
    }
  }
  return envelopes;
}

function parseExaSearchText(text, snippetMaxChars) {
  return String(text || "")
    .split(/(?=^Title:\s*)/gm)
    .map((block) => {
      const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "";
      const url = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim() || "";
      const publishedDate = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim() || "";
      const highlights = block.match(/^Highlights:\s*([\s\S]*)$/m)?.[1] || "";
      if (!normalizeUrl(url)) {
        return null;
      }
      return normalizeSearchResult({
        title,
        url,
        snippet: highlights,
        published_date: publishedDate === "N/A" ? "" : publishedDate,
        source_type: classifySource(url),
      }, snippetMaxChars);
    })
    .filter(Boolean);
}

function parseMcpJsonText(text, label) {
  const normalized = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const payload = JSON.parse(normalized);
    if (!payload || typeof payload !== "object") {
      throw new Error("not an object");
    }
    return payload;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON content: ${error.message}`);
  }
}

function normalizeParallelWarnings(warnings) {
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.map((warning) => ({
    provider: "parallel",
    code: String(warning?.type || "warning"),
    message: compactText(warning?.message || "provider warning", 240),
  }));
}

function formatProviderFailureCodes(failures) {
  const codes = (Array.isArray(failures) ? failures : [])
    .map((failure) => {
      const provider = compactText(failure?.provider || "unknown", 40);
      const code = compactText(failure?.code || "provider_error", 60);
      return `${provider}:${code}`;
    })
    .filter(Boolean);
  return uniqueCompactList(codes).slice(0, 8).join(",") || "none";
}

function buildExaHeaders(config) {
  return config.exaApiKey
    ? { "x-api-key": config.exaApiKey }
    : {};
}

function buildParallelHeaders(config) {
  return config.parallelApiKey
    ? { Authorization: `Bearer ${config.parallelApiKey}` }
    : {};
}

function getMcpTimeoutMs(config) {
  return clampInteger(
    config.webSearchMcpTimeoutMs,
    clampInteger(config.webSearchTimeoutMs, 10000, 1000, 60000),
    1000,
    60000,
  );
}

function providerFailure(provider, error, config) {
  return {
    provider,
    code: inferProviderFailureCode(error),
    message: sanitizeProviderError(error, config),
  };
}

function inferProviderFailureCode(error) {
  const message = String(error?.message || error || "");
  const status = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (status === "429") {
    return "rate_limited";
  }
  if (/rate.?limit|too many requests/i.test(message)) {
    return "rate_limited";
  }
  if (status === "401" || status === "403") {
    return "authentication";
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) {
    return "timeout";
  }
  if (/no usable|no text|no result|empty/i.test(message)) {
    return "empty_results";
  }
  return status ? `http_${status}` : "provider_error";
}

function sanitizeProviderError(error, config) {
  let message = String(error?.message || error || "unknown provider error");
  for (const secret of [
    config.exaApiKey,
    config.parallelApiKey,
    config.tavilyApiKey,
    config.braveSearchApiKey,
  ]) {
    if (secret) {
      message = message.split(secret).join("<redacted>");
    }
  }
  return compactText(message, 300);
}

function buildFetchedEvidence({
  url,
  text,
  maxChars,
  relevanceQuery,
  title = "",
  publishedDate = "",
  status = 200,
}) {
  const filtered = filterFetchedText(text, maxChars, relevanceQuery);
  if (!hasReadableEvidence(filtered)) {
    return failedFetchEvidence(url, status, "empty readable content");
  }
  return {
    url,
    domain: getDomain(url),
    fetched_at: new Date().toISOString(),
    status,
    evidence_status: "fetched_page",
    title,
    published_date: publishedDate || undefined,
    facts: filtered.facts,
    text: filtered.text,
  };
}

function extractMarkdownTitle(text) {
  return String(text || "").match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || "";
}

async function readResponseTextLimited(response, maxBytes, timeoutMs = 10000) {
  let reader;
  let timeout;
  const readPromise = (async () => {
    const contentLength = Number.parseInt(
      response.headers?.get?.("content-length") || "",
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel?.();
      throw new Error(`Web response exceeds ${maxBytes} bytes`);
    }
    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) {
        throw new Error(`Web response exceeds ${maxBytes} bytes`);
      }
      return text;
    }

    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Web response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reader?.cancel().catch(() => undefined);
      reject(new Error(`Web response body timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchTavily(config, query, maxResults, fetchImpl = globalThis.fetch) {
  const response = await fetchWithTimeout("https://api.tavily.com/search", {
    timeoutMs: config.webSearchTimeoutMs,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.tavilyApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: config.tavilySearchDepth,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_favicon: false,
    }),
  }, fetchImpl);

  const payload = await readJsonResponse(response, "Tavily search");
  return {
    provider: "tavily",
    query: payload.query || query,
    results: (payload.results || []).map((item) => normalizeSearchResult({
      title: item.title,
      url: item.url,
      snippet: item.content,
      score: item.score,
      source_type: classifySource(item.url),
    }, config.webSearchSnippetMaxChars)),
  };
}

async function searchBrave(config, query, maxResults, fetchImpl = globalThis.fetch) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("country", config.braveSearchCountry);
  url.searchParams.set("search_lang", config.braveSearchLang);
  url.searchParams.set("ui_lang", config.braveSearchUiLang);
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web");

  const response = await fetchWithTimeout(url.toString(), {
    timeoutMs: config.webSearchTimeoutMs,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": config.braveSearchApiKey,
    },
  }, fetchImpl);

  const payload = await readJsonResponse(response, "Brave search");
  return {
    provider: "brave",
    query,
    results: (payload.web?.results || []).map((item) => normalizeSearchResult({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source_type: classifySource(item.url),
    }, config.webSearchSnippetMaxChars)),
  };
}

async function searchBingHtml(config, query, maxResults, fetchImpl = globalThis.fetch) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("setlang", config.webSearchLanguageCode);
  url.searchParams.set("cc", config.webSearchCountryCode);
  url.searchParams.set("mkt", config.webSearchMarket);

  const response = await fetchWithTimeout(url.toString(), {
    timeoutMs: config.webSearchTimeoutMs,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": config.webSearchLanguage || "zh-CN,zh;q=0.9,en;q=0.8",
    },
  }, fetchImpl);

  if (!response.ok) {
    throw new Error(`Bing search ${response.status}: ${response.statusText}`);
  }

  const html = await readResponseTextLimited(
    response,
    MAX_HTTP_RESPONSE_BYTES,
    config.webSearchTimeoutMs,
  );
  const results = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) {
      continue;
    }

    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push(normalizeSearchResult({
      title: decodeHtml(linkMatch[2]),
      url: unwrapBingUrl(decodeHtml(linkMatch[1])),
      snippet: decodeHtml(snippetMatch?.[1] || ""),
      source_type: classifySource(linkMatch[1]),
    }, config.webSearchSnippetMaxChars));

    if (results.length >= maxResults) {
      break;
    }
  }

  return {
    provider: "bing-html",
    provider_note:
      "HTML fallback search is suitable for local validation, but a formal search API such as Tavily or Brave is recommended for production reliability.",
    query,
    results,
  };
}

async function fetchWithTimeout(url, options = {}, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _ignoredTimeoutMs, ...requestOptions } = options;

  try {
    return await fetchImpl(url, {
      ...requestOptions,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      throw new Error(`Web request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, label) {
  const text = await readResponseTextLimited(response, MAX_MCP_RESPONSE_BYTES);
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON ${response.status}: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  return payload;
}

async function assertPublicHttpUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Blocked: only http(s) URLs are allowed.");
  }

  const host = parsed.hostname;
  if (isPrivateHost(host)) {
    throw new Error("Blocked: private or local hosts are not allowed.");
  }

  const addresses = await dns.lookup(host, { all: true });
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Blocked: URL resolves to a private or local network address.");
  }
}

function normalizeSearchResult(item, snippetMaxChars = 350) {
  const url = normalizeUrl(item.url);
  return {
    title: String(item.title || "").trim(),
    url,
    domain: getDomain(url),
    snippet: compactText(item.snippet || "", clampInteger(snippetMaxChars, 350, 80, 1000)),
    published_date: String(item.published_date || "").trim() || undefined,
    score: item.score,
    source_type: item.source_type || classifySource(url),
  };
}

function rankSearchResults(query, results, maxResults, minScore) {
  const scored = results
    .map((result, index) => {
      return {
        ...result,
        relevance_score: scoreSearchResult(query, result),
        original_rank: index + 1,
      };
    })
    .filter((result) => normalizeUrl(result.url));

  const threshold = clampInteger(minScore, 2, 0, 20);
  let filtered = scored.filter((result) => result.relevance_score >= threshold);

  if (filtered.length === 0) {
    filtered = scored.slice(0, maxResults);
  } else {
    filtered.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) {
        return b.relevance_score - a.relevance_score;
      }

      return a.original_rank - b.original_rank;
    });
  }

  return {
    results: filtered.slice(0, maxResults),
    filteredCount: Math.max(0, scored.length - filtered.length),
  };
}

function scoreSearchResult(query, result) {
  const terms = buildQueryTerms(query);
  if (terms.length === 0) {
    return 1;
  }

  const title = String(result.title || "").toLowerCase();
  const snippet = String(result.snippet || "").toLowerCase();
  const domain = String(result.domain || getDomain(result.url)).toLowerCase();
  const combined = `${title} ${snippet}`;
  let score = 0;

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    if (title.includes(lowerTerm)) {
      score += 3;
    }

    if (snippet.includes(lowerTerm)) {
      score += 1;
    }
  }

  if (isLikelyBoilerplate(combined)) {
    score -= 2;
  }

  if (/search|tag|category|login|signup|app-download|download/i.test(domain)) {
    score -= 1;
  }

  score += scoreFreshness(query, result);

  return score;
}

function buildSearchQueries(query, relevanceQuery) {
  const trimmed = String(query || "").trim();
  if (!hasFreshnessIntent(relevanceQuery)) {
    return [trimmed];
  }

  const now = new Date();
  const yyyyMmDd = formatDateOnly(now, "-");
  const chineseDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  return uniqueCompactList([
    trimmed,
    `${trimmed} ${yyyyMmDd}`,
    `${trimmed} ${chineseDate}`,
  ]).slice(0, 2);
}

function mergeSearchPayloads(query, payloads) {
  const seen = new Set();
  const results = [];
  const partialFailures = [];
  const engines = new Set();
  const providers = new Set();

  for (const payload of payloads) {
    if (!payload) {
      continue;
    }

    providers.add(payload.provider);
    for (const engine of payload.engines || []) {
      engines.add(engine);
    }

    partialFailures.push(...(payload.partial_failures || []));
    for (const result of payload.results || []) {
      const url = normalizeUrl(result.url);
      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      results.push(result);
    }
  }

  return {
    provider: [...providers].filter(Boolean).join("+") || "unknown",
    query,
    engines: [...engines],
    partial_failures: partialFailures,
    results,
  };
}

function compactText(value, maxChars) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function filterFetchedText(value, maxChars, query) {
  const text = stripNoisyText(value);
  const terms = buildQueryTerms(query);
  const facts = extractRelevantFacts(text, terms).slice(0, 8);
  const factText = facts.join(" ");

  if (factText.length >= Math.min(240, Math.floor(maxChars / 2))) {
    return {
      facts,
      text: factText.slice(0, maxChars),
    };
  }

  const relevant = compactRelevantText(text, maxChars, query);
  const combined = compactText(`${factText} ${relevant}`, maxChars);
  return {
    facts,
    text: combined || text.slice(0, maxChars),
  };
}

function compactRelevantText(value, maxChars, query) {
  const text = stripNoisyText(value);
  if (text.length <= maxChars) {
    return text;
  }

  const terms = buildQueryTerms(query);
  if (terms.length === 0) {
    return text.slice(0, maxChars);
  }

  return pickRelevantSentences(text, terms, maxChars) ||
    pickRelevantChunks(text, terms, maxChars) ||
    text.slice(0, maxChars);
}

function stripNoisyText(value) {
  const cleaned = String(value || "")
    .replace(/我仅的仅仅器会使用中期市仅仅率。?/g, "")
    .replace(/我仅款仅不会仅得此仅率。?/g, "");
  const withoutMojibake = cleaned
    .replace(/仅仅供参考。?/g, "")
    .replace(/您仅款仅不会仅得此仅率。?/g, "")
    .replace(/仅看仅款仅率。?/g, "");
  const compacted = withoutMojibake
    .replace(/\r/g, "\n")
    .split(/\n| {2,}/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isLikelyBoilerplate(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateAtNoiseMarker(compacted);
}

function isLikelyBoilerplate(value) {
  const text = String(value || "").toLowerCase();
  if (!text || text.length <= 2) {
    return true;
  }

  return /打开app|查看更多|热门推荐|今日热榜|本周热榜|相关推荐|相关链接|免责声明|风险提示|关注.+公众号|扫码|登录|注册|下载app|cookie|privacy policy|terms of use|advertisement|subscribe|newsletter|share this|read more|all rights reserved|点击展开|示例开始|规范输出|查询结果分析|我将使用.*工具查询|使用的搜索引擎|总记录数|作者.*文章列表|搜索结果显示|文章标题\s*:|"?\s*url\s*:|\bprompt\s*:|\bassistant\s*:|\buser\s*:/i.test(text);
}

function truncateAtNoiseMarker(text) {
  const markers = [
    "比较并保存",
    "提供商",
    "转账费用",
    "汇率比较图表",
    "随时随地管理",
    "热门推荐",
    "今日热榜",
    "本周热榜",
    "打开APP",
    "相关推荐",
    "关注手机",
    "外汇兑换计算器",
  ];

  let end = text.length;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index > 0) {
      end = Math.min(end, index);
    }
  }

  return text.slice(0, end).trim();
}

function pickRelevantSentences(text, terms, maxChars) {
  const scored = text
    .split(/(?<=[。！？!?；;])\s*|\s{2,}/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8 && !isLikelyBoilerplate(sentence))
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreTextAgainstTerms(sentence, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.index - b.index;
    });

  if (scored.length === 0) {
    return "";
  }

  const picked = [];
  let length = 0;
  for (const item of scored) {
    const nextLength = length + item.sentence.length + 1;
    if (nextLength > maxChars && picked.length > 0) {
      break;
    }

    picked.push(item);
    length = nextLength;
    if (length >= maxChars) {
      break;
    }
  }

  return picked
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence)
    .join(" ")
    .slice(0, maxChars);
}

function pickRelevantChunks(text, terms, maxChars) {
  const lowerText = text.toLowerCase();
  const chunks = [];
  const seenStarts = new Set();
  const chunkSize = Math.max(360, Math.floor(maxChars / 2));

  for (const term of terms) {
    const index = lowerText.indexOf(term.toLowerCase());
    if (index < 0) {
      continue;
    }

    const start = Math.max(0, index - Math.floor(chunkSize / 3));
    const normalizedStart = Math.floor(start / 120) * 120;
    if (seenStarts.has(normalizedStart)) {
      continue;
    }

    seenStarts.add(normalizedStart);
    chunks.push(text.slice(start, start + chunkSize).trim());
    if (chunks.join(" ... ").length >= maxChars) {
      break;
    }
  }

  return chunks.join(" ... ").slice(0, maxChars);
}

function scoreTextAgainstTerms(value, terms) {
  const text = String(value || "").toLowerCase();
  let score = 0;

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    if (text.includes(lowerTerm)) {
      score += Math.min(4, Math.max(1, lowerTerm.length));
    }
  }

  if (/\d/.test(text)) {
    score += 1;
  }

  if (/汇率|价格|日期|发布|更新|rate|exchange|latest|today/i.test(text)) {
    score += 1;
  }

  return score;
}

function extractRelevantFacts(text, terms) {
  const parts = text
    .split(/(?<=[。！？!?；;])\s*|\s{2,}|(?<=\d)\s+(?=[\p{L}\u4e00-\u9fff])/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && part.length <= 260)
    .filter((part) => !isLikelyBoilerplate(part));

  const scored = parts
    .map((part, index) => ({
      part,
      index,
      score: scoreFact(part, terms),
    }))
    .filter((item) => item.score >= 3)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.index - b.index;
    });

  const facts = [];
  const seen = new Set();
  for (const item of scored) {
    const normalized = item.part.replace(/\s+/g, " ");
    const key = normalized.slice(0, 80);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    facts.push(normalized);
    if (facts.length >= 8) {
      break;
    }
  }

  return facts;
}

function scoreFact(value, terms) {
  const text = String(value || "").toLowerCase();
  let score = scoreTextAgainstTerms(text, terms);

  if (/\d+(?:\.\d+)?/.test(text)) {
    score += 2;
  }

  if (/[￥¥$€£%]|(?:\d+(?:\.\d+)?\s?(?:元|美元|日元|人民币|cny|jpy|usd|eur|gbp|%|万人|亿元|公里|kg|ms|fps|gb|mb|kb))/i.test(text)) {
    score += 2;
  }

  if (/20\d{2}[-年/]\d{1,2}|(?:\d{1,2}[:：]\d{2})|utc|today|今日|今天|昨天|更新|发布|published|updated|as of/i.test(text)) {
    score += 2;
  }

  if (/最新|当前|实时|价格|汇率|比分|排名|政策|公告|日期|时间|rate|price|score|ranking|policy|notice|date|time/i.test(text)) {
    score += 1;
  }

  return score;
}

function scoreFreshness(query, result) {
  if (!hasFreshnessIntent(query)) {
    return 0;
  }

  const text = `${result.title || ""} ${result.snippet || ""} ${result.published_date || ""} ${result.url || ""}`;
  const dates = extractDates(text);
  if (dates.length === 0) {
    return 1;
  }

  const today = startOfLocalDay(new Date());
  let best = -4;
  for (const date of dates) {
    const diffDays = Math.round((today.getTime() - startOfLocalDay(date).getTime()) / 86400000);
    if (diffDays === 0) {
      best = Math.max(best, 10);
    } else if (diffDays === 1) {
      best = Math.max(best, 3);
    } else if (diffDays > 1 && diffDays <= 7) {
      best = Math.max(best, -Math.min(6, diffDays));
    } else if (diffDays < 0) {
      best = Math.max(best, -2);
    } else {
      best = Math.max(best, -4);
    }
  }

  return best;
}

function hasFreshnessIntent(query) {
  return /最新|实时|当前|今天|今日|刚刚|现在|recent|latest|current|today|now|live/i.test(String(query || ""));
}

function extractDates(value) {
  const text = String(value || "");
  const dates = [];
  const numericDatePattern = /(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/g;
  let match;

  while ((match = numericDatePattern.exec(text))) {
    const date = buildDate(match[1], match[2], match[3]);
    if (date) {
      dates.push(date);
    }
  }

  const monthNamePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/gi;
  while ((match = monthNamePattern.exec(text))) {
    const month = monthNameToNumber(match[1]);
    const date = buildDate(match[3], month, match[2]);
    if (date) {
      dates.push(date);
    }
  }

  return dates;
}

function buildDate(year, month, day) {
  const parsedYear = Number.parseInt(year, 10);
  const parsedMonth = Number.parseInt(month, 10);
  const parsedDay = Number.parseInt(day, 10);
  if (!parsedYear || !parsedMonth || !parsedDay) {
    return null;
  }

  const date = new Date(parsedYear, parsedMonth - 1, parsedDay);
  if (
    date.getFullYear() !== parsedYear ||
    date.getMonth() !== parsedMonth - 1 ||
    date.getDate() !== parsedDay
  ) {
    return null;
  }

  return date;
}

function monthNameToNumber(value) {
  const names = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return names[String(value || "").slice(0, 3).toLowerCase()] || 0;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateOnly(date, separator) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join(separator);
}

function buildQueryTerms(query) {
  const cleaned = String(query || "")
    .replace(/联网搜索|联网查询|联网搜搜|搜索|查询/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const terms = cleaned.split(/\s+/).filter((term) => term.length >= 2);

  if (/[\u4e00-\u9fff]/.test(cleaned)) {
    const cjk = cleaned.replace(/[^\u4e00-\u9fff]/g, "");
    for (let index = 0; index < cjk.length - 1; index += 2) {
      terms.push(cjk.slice(index, index + 2));
    }
  }

  return [...new Set(terms)].slice(0, 8);
}

function combineQueries(...queries) {
  return queries
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .join(" ");
}

function uniqueCompactList(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function classifySource(url) {
  const domain = getDomain(url);
  if (!domain) {
    return "unknown";
  }

  if (/\.(gov|edu)$/i.test(domain) || domain.includes(".gov.") || domain.includes(".edu.")) {
    return "primary_or_institutional";
  }

  if (/reuters|apnews|bloomberg|wsj|ft\.com|cnbc|investing|yahoo|xe\.com|wise\.com|imf\.org|worldbank|boj\.or\.jp/i.test(domain)) {
    return "established_data_or_news";
  }

  return "general_web";
}

function unwrapBingUrl(url) {
  try {
    const parsed = new URL(url);
    const encoded = parsed.searchParams.get("u");
    if (!encoded) {
      return url;
    }

    if (encoded.startsWith("a1")) {
      return Buffer.from(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }

    return encoded;
  } catch {
    return url;
  }
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isSearchEngineResultsUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    const hasQuery = parsed.searchParams.has("q") || parsed.searchParams.has("query");

    return (
      (/(^|\.)google\.[a-z.]+$/i.test(host) && pathname === "/search") ||
      (/(^|\.)bing\.com$/i.test(host) && pathname === "/search") ||
      (host === "duckduckgo.com" &&
        (hasQuery || pathname === "/html" || pathname === "/lite")) ||
      (/(^|\.)startpage\.com$/i.test(host) &&
        (pathname === "/sp/search" || pathname === "/do/search")) ||
      (host === "sogou.com" && pathname === "/web") ||
      (host === "baidu.com" && pathname === "/s") ||
      (host === "search.yahoo.com" && pathname === "/search") ||
      (host === "search.brave.com" && pathname === "/search") ||
      (/(^|\.)yandex\.[a-z.]+$/i.test(host) && pathname === "/search") ||
      (host === "search.naver.com" && pathname === "/search.naver")
    );
  } catch {
    return false;
  }
}

function isHttpRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function failedFetchEvidence(url, status, reason) {
  return {
    url,
    status,
    error: `web_fetch returned no usable evidence: ${reason}.`,
    reliability_guidance:
      "Do not cite this page. Change source or query; retry once only for a transient failure.",
  };
}

function hasReadableEvidence(filtered) {
  return Boolean(
    String(filtered?.text || "").trim() ||
      (Array.isArray(filtered?.facts) && filtered.facts.length > 0),
  );
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(number, max));
}

function htmlToText(html) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " "));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }

  return true;
}

module.exports = { WebToolRunner };
