# DeepSeek Harness web port

Upstream: <https://github.com/deepseek-ai/deepseek-harness>

Pinned revision: `d743267388641bc76f17c45ce8b4c231aed1d32c` (2026-10-09).
License: MIT, Copyright (c) 2026 DeepSeek; the complete license is in `LICENSE`.
`upstream.json` records SHA-256 digests of the copied source files.

The reviewed portions of `web-search-deepseek`, `tool-web`, and `web-fetch-http`
are converted from TypeScript into CommonJS. `scripts/vendor-deepseek-harness.js`
reproduces this conversion from a local copy of the pinned files:

```powershell
node scripts/vendor-deepseek-harness.js C:\path\to\pinned-harness
```

The generated files require no TypeScript compiler or Harness plugin runtime.
The regeneration script requires Node 22.13 or later.

Preserved upstream behavior:

- Native Anthropic Messages request with `web_search_20250305`, separate search
  endpoint, dual API-key headers and no HTTP redirects. Provider-generated prose
  and encrypted search content are discarded. Results are joined to citation
  excerpts by URL and deduplicated.
- Up to four exact-deduplicated queries run concurrently. Sources are merged in
  round-robin order and capped. A failing query aborts its siblings, waits for
  settlement and discards the entire batch.
- Public-address validation, DNS pinning (including mapped IPv4/NAT64 checks),
  same-origin redirects, cancellable transport/body reads, byte/character caps,
  charset decoding and text-only content types.
- Turndown with GFM tables/strikethrough, hidden/active content removal, bounded
  HTML nesting, bounded conversion/output, external-content notices and URL citations.

Bot-specific adaptations:

- Plugin registration, UI cards and credential-store integration are omitted.
  `src/deepseek-harness-web.js` supplies configuration, raw JSON validation,
  per-query result caps (normally owned by `ctx.web`), and the existing bot tool loop.
- A local `WebError`/deadline shim replaces the Harness runtime dependencies.
  Transport injection and a response observer support tests and token accounting.
  User-Agent and error guidance refer to this bot and its environment file.
- Web page requests always use the upstream direct, DNS-pinned transport.
  Harness's process-wide proxy service/account sign-in service is not installed.
  A proxy/TUN returning private or fake DNS addresses is therefore refused;
  `OPEN_WEBSEARCH_FAKE_IP_CIDRS` is a legacy-provider setting only.
- The official defaults are kept for search (8 sources, 4 queries, 30 s), native
  Messages (4096 output tokens, 5 server search uses) and fetch (5,000,000 bytes,
  100,000 decoded characters, 200,000 output characters, 30 s, 5 redirects).
  The bot keeps its existing model tool-round limits and optional-search behavior.
- Casual/DeepSeek replies may use actual cited excerpts when sufficient and
  fetch more detail as needed. The existing Qwen explicit research mode still
  requires fetched pages and source IDs. Empty/failed/omitted fetches cannot unlock
  a factual answer; raw HTML is never sent into the chat model.
- Ordinary chat still uses `deepseek-flash` with its existing thinking setting.
  Auxiliary search uses upstream's `deepseek-v4-flash` Messages request, whose
  server-side reasoning and token usage are independent of chat configuration.
