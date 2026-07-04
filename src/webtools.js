const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const USER_AGENT = "sandstorm-qq-bot/1.0 web-search";
const OPEN_WEBSEARCH_RUNTIME_BUNDLE = path.join(__dirname, "vendor", "open-websearch-runtime.cjs");

class WebToolRunner {
  constructor(config) {
    this.config = config;
    this.allowedUrls = new Set();
    this.openWebSearchRuntimePromise = null;
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
          description: "Search the public web. Returns compact titles, URLs, domains, and snippets.",
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
          description: "Fetch compact readable text from a URL returned by web_search.",
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
    this.lastRelevanceQuery = combineQueries(this.userQuery, query);
    const configuredMaxResults = clampInteger(this.config.webSearchMaxResults, 3, 1, 5);
    const maxResults = clampInteger(args.max_results, configuredMaxResults, 1, configuredMaxResults);
    const candidateResults = clampInteger(this.config.webSearchCandidateResults, 8, maxResults, 12);
    const provider = pickProvider(this.config);
    const searchQueries = buildSearchQueries(query, this.lastRelevanceQuery);
    const payloads = [];

    for (const searchQuery of searchQueries) {
      if (provider === "tavily") {
        payloads.push(await searchTavily(this.config, searchQuery, candidateResults));
      } else if (provider === "brave") {
        payloads.push(await searchBrave(this.config, searchQuery, candidateResults));
      } else if (provider === "open-websearch") {
        payloads.push(await this.searchOpenWebSearch(searchQuery, candidateResults));
      } else {
        payloads.push(await searchBingHtml(this.config, searchQuery, candidateResults));
      }
    }
    const payload = mergeSearchPayloads(query, payloads);

    const rankedResults = rankSearchResults(
      this.lastRelevanceQuery,
      payload.results || [],
      maxResults,
      this.config.webSearchMinRelevanceScore,
    );

    for (const result of rankedResults.results) {
      this.allowedUrls.add(normalizeUrl(result.url));
    }

    return {
      ...payload,
      results: rankedResults.results,
      filtered_count: rankedResults.filteredCount,
      searched_at: new Date().toISOString(),
      guidance: "Prefer recent primary/official sources; say uncertain if evidence is weak.",
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

    await assertPublicHttpUrl(url);

    const configuredMaxChars = clampInteger(this.config.webFetchMaxChars, 3000, 500, 12000);
    const requestedMaxChars = clampInteger(args.max_chars, configuredMaxChars, 500, configuredMaxChars);
    const maxChars = Math.min(requestedMaxChars, configuredMaxChars);
    const provider = pickProvider(this.config);

    if (provider === "open-websearch") {
      return this.fetchOpenWebSearch(url, maxChars);
    }

    const response = await fetchWithTimeout(url, {
      timeoutMs: this.config.webSearchTimeoutMs,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": this.config.webSearchLanguage || "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    const html = await response.text();
    const filtered = filterFetchedText(htmlToText(html), maxChars, this.lastRelevanceQuery || this.lastSearchQuery);
    return {
      url,
      domain: getDomain(url),
      fetched_at: new Date().toISOString(),
      status: response.status,
      facts: filtered.facts,
      text: filtered.text,
    };
  }

  async searchOpenWebSearch(query, maxResults) {
    const runtime = await this.getOpenWebSearchRuntime();
    const engines = this.config.openWebSearchEngines.length > 0
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

    const filtered = filterFetchedText(result.content || result.text || "", maxChars, this.lastRelevanceQuery || this.lastSearchQuery);
    return {
      url: result.url || url,
      final_url: result.finalUrl || result.url || url,
      domain: getDomain(result.finalUrl || result.url || url),
      fetched_at: new Date().toISOString(),
      status: result.status,
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

function pickProvider(config) {
  const provider = String(config.webSearchProvider || "auto").toLowerCase();
  if (provider === "auto") {
    if (config.tavilyApiKey) {
      return "tavily";
    }

    if (config.braveSearchApiKey) {
      return "brave";
    }

    return "open-websearch";
  }

  if (["open-websearch", "open_websearch", "openwebsearch", "embedded"].includes(provider)) {
    return "open-websearch";
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
  process.env.ALLOWED_SEARCH_ENGINES = process.env.ALLOWED_SEARCH_ENGINES || "duckduckgo,startpage,sogou";
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

async function searchTavily(config, query, maxResults) {
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
  });

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

async function searchBrave(config, query, maxResults) {
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
  });

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

async function searchBingHtml(config, query, maxResults) {
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
  });

  if (!response.ok) {
    throw new Error(`Bing search ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Web request timed out after ${options.timeoutMs || 10000}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
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

  const text = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`;
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
