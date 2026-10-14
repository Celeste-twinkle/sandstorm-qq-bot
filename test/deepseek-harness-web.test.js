const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const { WebToolRunner } = require("../src/webtools");
const { DeepSeekHarnessWebToolRunner, hasReadableHarnessPage } = require("../src/deepseek-harness-web");
const { DeepSeekSearchProvider, mapAnthropicResponse } = require("../src/vendor/deepseek-harness/search-provider");
const { HttpFetchProvider } = require("../src/vendor/deepseek-harness/fetch-provider");
const { resolvePublicAddresses, createPinnedLookup, isPublicIpAddress } = require("../src/vendor/deepseek-harness/fetch-network");
const { renderFetchOutput } = require("../src/vendor/deepseek-harness/fetch-tool");
const { DeepSeekChatService } = require("../src/deepseek");
const { LocalQwenChatService } = require("../src/qwen");

const logger = { log() {}, error() {}, warn() {} };
const officialConfig = {
  deepseekApiKey: "test-search-key", webSearchProvider: "deepseek-official",
  deepseekModel: "deepseek-flash", deepseekBaseUrl: "https://chat.example.invalid/v1",
  deepseekThinkingEnabled: false, deepseekTimeoutMs: 1000, deepseekTemperature: 0.9,
  deepseekMaxOutputTokens: 1600, webSearchAutoEnabled: true,
  webSearchMaxToolRounds: 2, webSearchMaxToolCallsPerRound: 2,
  webSearchDiagnosticsEnabled: false,
};

function tool(name, args) {
  return { id: `${name}-1`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function apiPayload(sources = [{ url: "https://example.com/release", title: "Release", snippet: "Version 4.2 adds export." }]) {
  return { model: "deepseek-v4-flash", content: [
    { type: "thinking", thinking: "Hidden reasoning must never be forwarded." },
    { type: "web_search_tool_result", content: sources.map((source) => ({
      type: "web_search_result", url: source.url, title: source.title, page_age: source.publishedAt,
      encrypted_content: "Opaque data must never be forwarded.",
    })) },
    { type: "text", text: "Unverified provider prose must never be forwarded.",
      citations: sources.filter((source) => source.snippet).map((source) => ({
        type: "web_search_result_location", url: source.url, cited_text: source.snippet,
      })) },
  ] };
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function fetchResult(content, overrides = {}) {
  return { url: "https://example.com/release", statusCode: 200,
    body: { kind: "html", content }, truncated: false, ...overrides };
}
function httpFixture(replies, limits = {}) {
  const requests = [];
  let closed = 0;
  const provider = new HttpFetchProvider({ maxResponseBytes: 5000000, maxBodyChars: 100000,
    timeoutMs: 1000, maxRedirects: 5, userAgent: "unit-test", ...limits },
  async () => [{ address: "93.184.216.34", family: 4 }],
  async (url, addresses, headers, signal) => {
    const next = replies[requests.length];
    requests.push({ url: String(url), addresses, headers, signal });
    const response = typeof next === "function" ? next(signal) : next;
    return { response, async close() { closed += 1; } };
  });
  return { provider, requests, closed: () => closed };
}

test("native search uses Harness wire protocol and keeps chat endpoint/key out of tool output", async () => {
  const calls = [];
  const records = [];
  const runner = new WebToolRunner(officialConfig, { logger, recordSearchRequest: (request) => records.push(request),
    fetch: async (url, options) => { calls.push({ url, options }); return jsonResponse(apiPayload()); } });
  assert.ok(runner instanceof DeepSeekHarnessWebToolRunner);
  runner.setUserQuery("Private group history must not become a search query");
  const call = tool("web_search", { queries: ["public release"] });
  const result = await runner.runToolCall(call);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-api-key"], officialConfig.deepseekApiKey);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${officialConfig.deepseekApiKey}`);
  assert.equal(calls[0].options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "deepseek-v4-flash", max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: public release" }] }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  });
  assert.doesNotMatch(JSON.stringify(records), /test-search-key|headers|Private group/);
  assert.deepEqual(result, { sources: [{ url: "https://example.com/release", title: "Release", snippet: "Version 4.2 adds export." }], truncated: false });
  const rendered = runner.formatToolResult(call, result);
  assert.match(rendered, /External web content.*untrusted data/);
  assert.match(rendered, /\[Release\]\(https:\/\/example.com\/release\)/);
  assert.doesNotMatch(rendered, /Hidden reasoning|Unverified provider prose|Opaque data/);
  assert.equal(runner.hasUsableEvidence(call, result), true);
});

test("native mapping joins first citation by URL, deduplicates result blocks and drops prose", () => {
  const payload = apiPayload([
    { url: "https://example.com/a", title: "A", snippet: "First", publishedAt: "2026-10-09" },
    { url: "https://example.com/a", snippet: "Second" },
    { url: "https://example.com/b" },
  ]);
  payload.content.push({ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://example.com/a" }] });
  assert.deepEqual(mapAnthropicResponse(payload), { sources: [
    { url: "https://example.com/a", title: "A", snippet: "First", publishedAt: "2026-10-09" },
    { url: "https://example.com/b" },
  ], truncated: false });
  assert.throws(() => mapAnthropicResponse({ content: [{ type: "text", text: "Pretend search succeeded" }] }),
    (error) => error.code === "WEB_PROVIDER_ERROR");
  assert.deepEqual(mapAnthropicResponse({ content: [{ type: "web_search_tool_result", content: [] }] }),
    { sources: [], truncated: false });
});

test("multi-query search deduplicates exact strings and merges in rank order with one result cap", async () => {
  const calls = [];
  const runner = new WebToolRunner({ ...officialConfig, webSearchMaxResults: 3 }, { logger,
    searchProvider: { async search({ query }) {
      calls.push(query);
      return { sources: [1, 2, 3, 4].map((rank) => ({ url: `https://example.com/${query}/${rank}` })), truncated: false };
    } },
  });
  const result = await runner.search({ queries: ["a", "b", "a"] });
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(result.sources.map((source) => source.url),
    ["https://example.com/a/1", "https://example.com/b/1", "https://example.com/a/2"]);
  assert.equal(result.truncated, true);
});

test("invalid/over-budget tool arguments never dispatch search or fetch", async () => {
  let calls = 0;
  const runner = new WebToolRunner(officialConfig, { logger,
    searchProvider: { async search() { calls += 1; } },
    fetchProvider: { async fetch() { calls += 1; } },
  });
  for (const args of [{ queries: [] }, { queries: [" "] }, { queries: "query" }, { queries: [4] },
    { queries: ["same", "same", "same", "same", "same"] }, { query: "legacy argument" },
    { queries: ["a"], max_results: 50 }]) {
    assert.ok((await runner.runToolCall(tool("web_search", args))).error);
  }
  for (const args of [{ url: "" }, { url: 5 }, { url: "https://example.com", max_chars: 500 }]) {
    assert.ok((await runner.runToolCall(tool("web_fetch", args))).error);
  }
  assert.ok((await runner.runToolCall(tool("web_search", []))).error);
  assert.equal(calls, 0);
});

test("one query failure aborts siblings, waits for settlement, and discards successful results", async () => {
  const events = [];
  const runner = new WebToolRunner(officialConfig, { logger,
    searchProvider: { async search({ query }, signal) {
      if (query === "ok") return { sources: [{ url: "https://example.com/ok" }], truncated: false };
      if (query === "fail") throw Object.assign(new Error("Native search failed"), { code: "WEB_PROVIDER_ERROR" });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("aborted");
          setTimeout(() => { events.push("settled"); reject(signal.reason); }, 2);
        }, { once: true });
      });
    } },
  });
  const result = await runner.runToolCall(tool("web_search", { queries: ["ok", "slow", "fail"] }));
  assert.equal(result.code, "WEB_PROVIDER_ERROR");
  assert.equal(result.sources, undefined);
  assert.deepEqual(events, ["aborted", "settled"]);
});

test("missing keys, malformed native blocks, HTTP errors and API key echoes fail closed", async () => {
  let dispatched = 0;
  const missing = new WebToolRunner({ ...officialConfig, deepseekApiKey: "" }, {
    fetch: async () => { dispatched += 1; }, logger,
  });
  assert.equal((await missing.runToolCall(tool("web_search", { queries: ["a"] }))).code, "WEB_PROVIDER_CREDENTIAL_MISSING");
  assert.equal(dispatched, 0);
  for (const response of [
    () => jsonResponse({ content: [{ type: "text", text: "No tool result" }] }),
    () => jsonResponse({ content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" } }] }),
    () => jsonResponse({ error: { message: `Rejected ${officialConfig.deepseekApiKey}` } }, 429),
    () => new Response("Gateway error", { status: 502 }),
  ]) {
    const runner = new WebToolRunner(officialConfig, { fetch: async () => response(), logger });
    const result = await runner.runToolCall(tool("web_search", { queries: ["a"] }));
    assert.equal(result.code, "WEB_PROVIDER_ERROR");
    assert.match(result.error, /anthropic\/v1\/messages/);
    assert.doesNotMatch(JSON.stringify(result), /test-search-key/);
    assert.equal(result.sources, undefined);
  }
});

test("search timeout and mid-body cancellation retain stable errors", async () => {
  const runner = new WebToolRunner({ ...officialConfig, webSearchTimeoutMs: 10 }, { logger,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal((await runner.runToolCall(tool("web_search", { queries: ["a"] }))).code, "WEB_SEARCH_TIMEOUT");
  const controller = new AbortController();
  const provider = new DeepSeekSearchProvider(() => ({ apiKey: "dummy", baseURL: "https://example.com",
    model: "search", apiVersion: "2023-06-01", maxTokens: 4096, maxUses: 5 }),
  async () => ({ ok: false, status: 500, async json() { controller.abort(); throw new DOMException("Aborted", "AbortError"); } }));
  await assert.rejects(provider.search({ query: "a" }, controller.signal), (error) => error.code === "WEB_ABORTED");
});

test("native Messages redirects cannot forward credentials", async (t) => {
  const targets = [];
  const server = http.createServer((request, response) => {
    targets.push(request.url);
    response.writeHead(302, { location: "/unexpected-target" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runner = new WebToolRunner({ ...officialConfig,
    deepseekSearchBaseUrl: `http://127.0.0.1:${server.address().port}`, webSearchTimeoutMs: 1000 }, { logger });
  const result = await runner.runToolCall(tool("web_search", { queries: ["a"] }));
  assert.equal(result.code, "WEB_PROVIDER_ERROR");
  assert.deepEqual(targets, ["/messages"]);
});

test("public fetch rejects credentialed, non-HTTP, private, mixed DNS and translated private destinations", async () => {
  const signal = new AbortController().signal;
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "198.18.0.1"]) {
    assert.equal(isPublicIpAddress(address), false, address);
    await assert.rejects(resolvePublicAddresses(address, signal, async () => []), (error) => error.code === "WEB_BLOCKED_URL");
  }
  await assert.rejects(resolvePublicAddresses("rebind.example", signal, async () => [
    { address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 },
  ]), (error) => error.code === "WEB_BLOCKED_URL");
  const fixture = httpFixture([]);
  for (const url of ["file:///etc/passwd", "https://user:password@example.com/", `https://example.com/${"x".repeat(2100)}`]) {
    await assert.rejects(fixture.provider.fetch({ url }), (error) => ["WEB_INVALID_URL", "WEB_BLOCKED_URL"].includes(error.code));
  }
  assert.equal(fixture.requests.length, 0);
});

test("pinned lookup only serves the validated DNS snapshot", async () => {
  const addresses = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  const lookup = createPinnedLookup(addresses);
  await new Promise((resolve, reject) => lookup("rebind.example", { all: true }, (error, result) => {
    if (error) return reject(error);
    assert.deepEqual(result, addresses); resolve();
  }));
  await new Promise((resolve, reject) => lookup("rebind.example", { family: 4 }, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, "93.184.216.34"); assert.equal(family, 4); resolve();
  }));
});

test("DNS64 custom prefixes cannot translate a public-looking IPv6 address to a private IPv4 destination", async () => {
  const resolver = async (hostname) => [{ family: 6, address: hostname === "ipv4only.arpa"
    ? "2001:4860:1111::c000:aa" : hostname === "public.example"
      ? "2001:4860:1111::808:808" : "2001:4860:1111::7f00:1" }];
  const signal = new AbortController().signal;
  await assert.rejects(resolvePublicAddresses("private.example", signal, resolver),
    (error) => error.code === "WEB_BLOCKED_URL" && error.message.includes("NAT64"));
  assert.deepEqual(await resolvePublicAddresses("public.example", signal, resolver),
    [{ address: "2001:4860:1111::808:808", family: 6 }]);
});

test("fetch follows same-origin redirects and refuses a new origin before requesting it", async () => {
  const same = httpFixture([
    new Response("", { status: 302, headers: { location: "/article" } }),
    new Response("Article", { headers: { "content-type": "text/plain" } }),
  ]);
  const result = await same.provider.fetch({ url: "https://example.com/start" });
  assert.equal(result.url, "https://example.com/article");
  assert.equal(result.body.content, "Article");
  assert.equal(same.closed(), 2);
  const cross = httpFixture([new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } })]);
  await assert.rejects(cross.provider.fetch({ url: "https://example.com/start" }), (error) => error.code === "WEB_REDIRECT_BLOCKED");
  assert.equal(cross.requests.length, 1);
  assert.equal(cross.closed(), 1);
  assert.deepEqual(Object.keys(same.requests[0].headers).sort(), ["accept", "user-agent"]);
});

test("fetch preserves non-2xx status, decodes declared charset and rejects binary or oversized responses", async () => {
  const charset = httpFixture([new Response(new Uint8Array([0xe9]), {
    status: 404, headers: { "content-type": "text/plain; charset=windows-1252" },
  })]);
  const result = await charset.provider.fetch({ url: "https://example.com/missing" });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.content, "é");
  assert.equal(hasReadableHarnessPage(result), false);
  for (const [headers, code] of [
    [{ "content-type": "image/png" }, "WEB_UNSUPPORTED_CONTENT_TYPE"],
    [{ "content-type": "text/plain; charset=invalid-encoding" }, "WEB_UNSUPPORTED_CONTENT_TYPE"],
    [{ "content-type": "text/plain", "content-length": "100" }, "WEB_FETCH_TOO_LARGE"],
  ]) {
    const fixture = httpFixture([new Response("body", { headers })], { maxResponseBytes: 8 });
    await assert.rejects(fixture.provider.fetch({ url: "https://example.com/article" }), (error) => error.code === code);
    assert.equal(fixture.closed(), 1);
  }
});

test("fetch caps streamed bytes and decoded characters, keeping exact-cap bodies untruncated", async () => {
  for (const [body, truncated] of [["12345678", false], ["123456789", true]]) {
    const fixture = httpFixture([new Response(body, { headers: { "content-type": "text/plain" } })], { maxResponseBytes: 8 });
    const result = await fixture.provider.fetch({ url: "https://example.com/article" });
    assert.equal(result.body.content, "12345678");
    assert.equal(result.truncated, truncated);
  }
  const fixture = httpFixture([new Response("abcdefgh", { headers: { "content-type": "text/plain" } })], { maxBodyChars: 4 });
  assert.deepEqual((await fixture.provider.fetch({ url: "https://example.com/article" })).body, { kind: "text", content: "abcd" });
});

test("fetch timeout covers the body stream and releases the request", async () => {
  const fixture = httpFixture([(signal) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
  }), { headers: { "content-type": "text/plain" } })], { timeoutMs: 10 });
  await assert.rejects(fixture.provider.fetch({ url: "https://example.com/article" }), (error) => error.code === "WEB_FETCH_TIMEOUT");
  assert.equal(fixture.closed(), 1);
});

test("HTML is converted to bounded Markdown with tables, links and no hidden/active content", () => {
  const html = '<h1>Release</h1><script>evil-script</script><style>evil-style</style>'
    + '<p hidden>evil-hidden</p><p aria-hidden="TRUE">evil-aria</p><p style="display:none!important">evil-display</p>'
    + '<p style="visibility:hidden">evil-visibility</p><iframe>evil-iframe</iframe><template>evil-template</template>'
    + '<p><del>Old</del> <a href="https://example.com/docs">Docs</a></p>'
    + '<table><tr><th>Version</th><th>Change</th></tr><tr><td>4.2</td><td>Export</td></tr></table>';
  const result = fetchResult(html);
  const rendered = renderFetchOutput(result, 200000);
  assert.match(rendered.text, /# Release/);
  assert.match(rendered.text, /~+Old~+/);
  assert.match(rendered.text, /\[Docs\]\(https:\/\/example.com\/docs\)/);
  assert.match(rendered.text, /\| Version \| Change \|/);
  assert.doesNotMatch(rendered.text, /evil-|<script|<table/);
  assert.equal(hasReadableHarnessPage(result), true);
  const bounded = renderFetchOutput(fetchResult(`<p>${"body ".repeat(300)}</p>`), 500);
  assert.ok(bounded.text.length <= 500);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.text, /Content truncated/);
});

test("unsafe HTML nesting is omitted and cannot unlock an evidence-based answer", () => {
  const result = fetchResult("<div>".repeat(600) + "hidden active source");
  const rendered = renderFetchOutput(result, 200000);
  assert.match(rendered.text, /HTML content omitted/);
  assert.doesNotMatch(rendered.text, /<div>|hidden active source/);
  assert.equal(hasReadableHarnessPage(result), false);
  assert.equal(hasReadableHarnessPage(fetchResult("<script>not evidence</script>")), false);
  const span = renderFetchOutput(fetchResult('<table><tr><th>A</th></tr><tr><td colspan="999999999">B</td></tr></table>'), 1000);
  assert.ok(span.text.length < 1000);
});

function chatFixture(replies, nativePayload = apiPayload(), page = fetchResult("<p>Version 4.2 adds export.</p>")) {
  const modelBodies = [];
  const searchBodies = [];
  const toolCalls = [];
  const config = { ...officialConfig };
  const factory = (runnerConfig) => {
    const runner = new WebToolRunner(runnerConfig, { logger,
      fetch: async (_url, options) => { searchBodies.push(JSON.parse(options.body)); return jsonResponse(nativePayload); },
      fetchProvider: { async fetch({ url }) { return { ...page, url }; } },
    });
    const run = runner.runToolCall.bind(runner);
    runner.runToolCall = async (call) => { toolCalls.push(call); return run(call); };
    return runner;
  };
  const service = new DeepSeekChatService(config, { logger, webToolRunnerFactory: factory,
    fetch: async (_url, options) => {
      const reply = replies[modelBodies.length];
      assert.ok(reply, "Unexpected model request");
      modelBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: reply }] });
    },
  });
  return { service, config, factory, modelBodies, searchBodies, toolCalls };
}
const chatMessages = [{ role: "system", content: "Selected member persona" }, { role: "user", content: "Current request" }];
const nativeSearch = tool("web_search", { queries: ["public release"] });
const nativeFetch = tool("web_fetch", { url: "https://example.com/release" });

test("native tool loop can answer cited excerpts without forcing a page fetch or chat thinking", async () => {
  const answer = "新增导出功能。[发布说明](https://example.com/release)";
  const f = chatFixture([{ tool_calls: [nativeSearch] }, { content: answer }]);
  assert.equal(await f.service.createCompletion(chatMessages, { maxOutputTokens: 180 }), answer);
  assert.equal(f.searchBodies.length, 1);
  assert.equal(f.toolCalls.length, 1);
  assert.equal(f.modelBodies.length, 2);
  assert.equal(f.modelBodies[1].max_tokens, 512);
  assert.ok(f.modelBodies.every((body) => body.thinking.type === "disabled" && body.model === "deepseek-flash"));
  const result = f.modelBodies[1].messages.at(-1).content;
  assert.match(result, /Sources:/);
  assert.doesNotMatch(result, /Unverified provider prose|Hidden reasoning/);
});

test("tool loop reads full Markdown when search has no cited excerpt, while titles alone fail closed", async () => {
  const discovery = apiPayload([{ url: "https://example.com/release", title: "Release" }]);
  const f = chatFixture([{ tool_calls: [nativeSearch] }, { tool_calls: [nativeFetch] }, { content: "Verified [source](https://example.com/release)" }], discovery);
  const reply = await f.service.createCompletion(chatMessages);
  assert.match(reply, /Verified/);
  assert.deepEqual(f.toolCalls.map((call) => call.function.name), ["web_search", "web_fetch"]);
  const fetched = f.modelBodies[2].messages.filter((message) => message.role === "tool").at(-1).content;
  assert.match(fetched, /Fetched https:\/\/example.com\/release \(HTTP 200\)/);
  assert.doesNotMatch(fetched, /<p>|"kind":"html"/);
  assert.match(f.modelBodies[1].messages.at(-1).content, /discovery_only[\s\S]*web_fetch/);
  const failed = chatFixture([{ tool_calls: [nativeSearch] }, { content: "Invented answer" }, { content: "Still unverified" }], discovery);
  assert.equal(await failed.service.createCompletion(chatMessages), "这个我没查到可靠的消息，暂时不确定。");
  assert.equal(failed.modelBodies.length, 3, "Only one correction is allowed when the model declines to fetch");
  assert.equal(failed.toolCalls.length, 1);
});

test("a premature answer after URL-only search gets one correction within the original tool budget", async () => {
  const discovery = apiPayload([{ url: "https://example.com/release", title: "Release" }]);
  const answer = "Verified [source](https://example.com/release)";
  const f = chatFixture([{ tool_calls: [nativeSearch] }, { content: "Unverified draft from memory" },
    { tool_calls: [nativeFetch] }, { content: answer }], discovery);
  const logs = [];
  f.config.webSearchDiagnosticsEnabled = true;
  f.service.logger = { log: (line) => logs.push(line) };
  assert.equal(await f.service.createCompletion(chatMessages, { maxOutputTokens: 180 }), answer);
  assert.equal(f.config.webSearchMaxToolRounds, 2);
  assert.equal(f.modelBodies.length, 4);
  assert.deepEqual(f.toolCalls.map((call) => call.function.name), ["web_search", "web_fetch"]);
  assert.match(f.modelBodies[2].messages.at(-1).content, /还可使用 1 轮工具/);
  assert.doesNotMatch(JSON.stringify(f.modelBodies[2].messages), /Unverified draft from memory/);
  assert.ok(f.modelBodies.every((body) => body.thinking.type === "disabled"));
  assert.equal(f.modelBodies[2].tool_choice, "auto", "Recovery still lets the model decline");
  assert.equal(f.modelBodies[3].max_tokens, 512);
  assert.match(logs.join("\n"), /tool=web_search.*usable_evidence=false/);
  assert.match(logs.join("\n"), /tool=web_fetch.*usable_evidence=true/);
  assert.match(logs.at(-1), /outcome=evidence_answer_budget tool_rounds=2\/2 tool_calls=2 evidence_results=1 recovery_attempted=true/);
  assert.doesNotMatch(logs.join("\n"), /test-search-key|public release|https:/);
});

test("evidence recovery neither exceeds tool limits nor treats failed pages as verified", async () => {
  const discovery = apiPayload([{ url: "https://example.com/release", title: "Release" }]);
  const oneRound = chatFixture([{ tool_calls: [nativeSearch] }], discovery);
  oneRound.config.webSearchMaxToolRounds = 1;
  assert.equal(await oneRound.service.createCompletion(chatMessages), "这个我没查到可靠的消息，暂时不确定。");
  assert.equal(oneRound.modelBodies.length, 1);
  const failed = chatFixture([{ tool_calls: [nativeSearch] }, { content: "Unverified draft" },
    { tool_calls: [nativeFetch, { ...nativeFetch, id: "fetch-2" }, { ...nativeFetch, id: "fetch-3" }] }],
  discovery, fetchResult("Access denied", { statusCode: 403 }));
  assert.equal(await failed.service.createCompletion(chatMessages), "这个我没查到可靠的消息，暂时不确定。");
  assert.equal(failed.modelBodies.length, 3);
  assert.equal(failed.toolCalls.length, 3, "One search plus at most two fetches, despite three requested fetches");
});

test("empty native search has no candidate page to repair and stops normally", async () => {
  const f = chatFixture([{ tool_calls: [nativeSearch] }, { content: "Unknown" }], apiPayload([]));
  assert.equal(await f.service.createCompletion(chatMessages), "这个我没查到可靠的消息，暂时不确定。");
  assert.equal(f.modelBodies.length, 2);
  assert.doesNotMatch(f.modelBodies[1].messages.at(-1).content, /discovery_only/);
});

test("direct URLs need no preliminary search, but 404 content is not factual evidence", async () => {
  const f = chatFixture([{ tool_calls: [nativeFetch] }, { content: "Read [source](https://example.com/release)" }]);
  assert.match(await f.service.createCompletion(chatMessages), /Read/);
  assert.equal(f.searchBodies.length, 0);
  const failed = chatFixture([{ tool_calls: [nativeFetch] }, { content: "Invented" }], apiPayload(), fetchResult("Missing", { statusCode: 404 }));
  assert.equal(await failed.service.createCompletion(chatMessages), "这个我没查到可靠的消息，暂时不确定。");
});

test("optional native tools still permit ordinary direct replies without an auxiliary API call", async () => {
  const f = chatFixture([{ content: "我也不清楚。" }]);
  assert.equal(await f.service.createCompletion(chatMessages), "我也不清楚。");
  assert.equal(f.modelBodies.length, 1);
  assert.equal(f.modelBodies[0].tool_choice, "auto");
  assert.equal(f.searchBodies.length, 0);
  assert.equal(f.toolCalls.length, 0);
});

test("Qwen explicit research receives native Markdown, keeps fetched source IDs, and rejects 404 evidence", async () => {
  for (const status of [200, 404]) {
    const f = chatFixture([], apiPayload(), fetchResult("<h1>Release</h1><p>Export added.</p>", { statusCode: status }));
    const config = { ...f.config, localQwenModel: "test-qwen", localQwenWebResearchEnabled: true,
      localQwenWebSearchMaxToolRounds: 2, localQwenWebSearchMaxToolCallsPerRound: 2,
      localQwenWebSearchMaxTotalToolCalls: 4, localQwenModelMaxOutputTokens: 4096 };
    const service = new LocalQwenChatService(config, { logger, webToolRunnerFactory: f.factory });
    const bodies = [];
    const replies = [{ tool_calls: [nativeSearch] }, { tool_calls: [nativeFetch] },
      { content: "新增导出。【S1】\n【S1】Release — https://example.com/release" }];
    service.requestCompletion = async (body) => { bodies.push(body); return { choices: [{ message: replies[bodies.length - 1] }] }; };
    const reply = await service.createCompletionWithWebTools(chatMessages, false, { webSearch: true });
    if (status === 200) {
      assert.match(reply, /【S1】/);
      assert.match(bodies[2].messages.filter((message) => message.role === "tool").at(-1).content, /# Release[\s\S]*Source ID: 【S1】/);
    } else {
      assert.match(reply, /没有取得可验证的网页正文/);
      assert.equal(bodies.length, 2);
    }
  }
});
