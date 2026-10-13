// Build the reviewed CommonJS port from a local copy of the pinned upstream files.
// Requires Node >= 22.13 for stripTypeScriptTypes; the generated bot needs no TS runtime.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { stripTypeScriptTypes } = require("node:module");

const revision = "d743267388641bc76f17c45ce8b4c231aed1d32c";
const root = path.resolve(process.argv[2] || ".");
const output = path.resolve(__dirname, "../src/vendor/deepseek-harness");
const manifest = [];
const expectedFile = path.join(output, "upstream.json");
const expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, "utf8")) : null;
if (expected && expected.revision !== revision) throw new Error("Review the new upstream revision before regenerating");

function read(relative) {
  const bytes = fs.readFileSync(path.join(root, relative));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected && expected.files.find((entry) => entry.path === relative)?.sha256 !== sha256) {
    throw new Error(`Source does not match the reviewed revision: ${relative}`);
  }
  manifest.push({ path: relative, sha256 });
  return bytes.toString("utf8").replace(/\r\n/g, "\n");
}

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Upstream code changed: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

function write(name, source, exports) {
  let js = stripTypeScriptTypes(source, { mode: "transform" });
  js = js.replace(/^export /gm, "");
  const header = `// Adapted from deepseek-ai/deepseek-harness @ ${revision}.\n`
    + "// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.\n";
  fs.writeFileSync(path.join(output, name), `${header}${js}\nmodule.exports = { ${exports.join(", ")} };\n`);
}

fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "LICENSE"), read("LICENSE"));

let provider = read("packages/web/web-search-deepseek/src/provider.ts");
provider = replace(provider, "import { WebError } from '@deepseek-ai/dsh-web'", "const { WebError } = require('./runtime')");
provider = replace(provider, "constructor(private readonly resolveOptions: () => DeepSeekSearchProviderOptions) {}",
  "constructor(private readonly resolveOptions: () => DeepSeekSearchProviderOptions, private readonly fetchImpl = globalThis.fetch) {}");
provider = replace(provider, "response = await fetch(endpoint, {", "response = await this.fetchImpl(endpoint, {");
provider = replace(provider, "const payload = await response.json() as AnthropicResponse\n      return mapAnthropicResponse(payload)",
  "const payload = await response.json() as AnthropicResponse\n      options.recordResponse?.(payload)\n      return mapAnthropicResponse(payload)");
provider = replace(provider, "'deepseek-harness/0.0.1'", "'sandstorm-qq-bot/1.0 deepseek-harness-web'");
const missingStart = provider.indexOf('      `DeepSeek search has no API key');
const missingEnd = provider.indexOf("      'WEB_PROVIDER_CREDENTIAL_MISSING',", missingStart);
if (missingStart < 0 || missingEnd < 0) throw new Error("Missing credential diagnostic moved");
provider = provider.slice(0, missingStart)
  + '      `DeepSeek search has no API key for "${ref}"; set DEEPSEEK_API_KEY in the bot environment.`,\n'
  + provider.slice(missingEnd);
const guidanceStart = provider.indexOf("    + 'guide the user to Settings >");
const guidanceEnd = provider.indexOf("    'WEB_PROVIDER_ERROR',", guidanceStart);
if (guidanceStart < 0 || guidanceEnd < 0) throw new Error("Endpoint diagnostic moved");
provider = provider.slice(0, guidanceStart)
  + "    + 'set DEEPSEEK_SEARCH_BASE_URL in the bot environment to a trusted Anthropic-compatible Messages API base. '\n"
  + "    + 'Only the operator should choose or change that endpoint.',\n"
  + provider.slice(guidanceEnd);
write("search-provider.js", provider, ["DeepSeekSearchProvider", "mapAnthropicResponse", "citationSnippets",
  "DEEPSEEK_PROVIDER_ID", "DEEPSEEK_DEFAULT_BASE_URL", "DEEPSEEK_DEFAULT_MODEL", "DEEPSEEK_DEFAULT_API_VERSION",
  "DEEPSEEK_DEFAULT_MAX_TOKENS", "DEEPSEEK_DEFAULT_MAX_USES"]);

const search = read("packages/web/tool-web/src/search.ts");
let searchCore = search.slice(search.indexOf("export const WEB_SEARCH_MAX_RESULTS"), search.indexOf("/**\n * Pending-call presentation"))
  + search.slice(search.indexOf("async function runSearchQueries("), search.indexOf("/**\n * Register the `web_search` tool"));
// Harness's schema layer rejects non-arrays/non-strings before these value checks.
// This bot receives raw JSON, so perform those same type checks here.
searchCore = replace(searchCore, "  const queries = args.queries", "  const queries = args?.queries\n  if (!Array.isArray(queries) || queries.some(query => typeof query !== 'string')) throw new Error('queries must be an array of strings')");
write("search-tool.js", "const { EXTERNAL_WEB_CONTENT_NOTICE } = require('./trust')\n" + searchCore,
  ["WEB_SEARCH_MAX_RESULTS", "WEB_SEARCH_MAX_QUERIES", "parseSearchArgs", "formatSearchOutput", "runSearchQueries", "mergeSearchResults"]);

let fetchTool = read("packages/web/tool-web/src/fetch.ts");
fetchTool = fetchTool.slice(fetchTool.indexOf("const turndown ="), fetchTool.indexOf("/**\n * Pending-call presentation"));
fetchTool = "const TurndownService = require('turndown')\n"
  + "const { gfm } = require('@joplin/turndown-plugin-gfm')\n"
  + "const { EXTERNAL_WEB_CONTENT_NOTICE } = require('./trust')\n"
  + "const assertNever = () => { throw new Error('unhandled web fetch body kind') }\n" + fetchTool;
write("fetch-tool.js", fetchTool, ["formatFetchOutput", "renderFetchOutput", "TRUNCATION_FOOTER"]);
write("trust.js", read("packages/web/tool-web/src/trust.ts"), ["EXTERNAL_WEB_CONTENT_NOTICE"]);

let policy = read("packages/web/web-fetch-http/src/policy.ts");
policy = replace(policy, "import { WebError } from '@deepseek-ai/dsh-web'", "const { WebError } = require('./runtime')");
write("fetch-policy.js", policy, ["WEB_FETCH_MAX_URL_LENGTH", "parseFetchUrl", "validateFetchUrl", "isSameOrigin", "classifyContentType", "parseCharset", "decoderForCharset"]);

let network = read("packages/web/web-fetch-http/src/network.ts");
network = replace(network, "import { lookup as systemLookup } from 'node:dns/promises'", "const { lookup: systemLookup } = require('node:dns/promises')");
network = replace(network, "import { isIP } from 'node:net'", "const { isIP } = require('node:net')");
network = replace(network, "import ipaddr from 'ipaddr.js'", "const ipaddr = require('ipaddr.js')");
network = replace(network, "import { WebError } from '@deepseek-ai/dsh-web'", "const { WebError } = require('./runtime')");
network = network.replaceAll("await import('undici')", "require('undici')");
write("fetch-network.js", network, ["publicHttpNetwork", "isPublicIpAddress", "resolvePublicAddresses", "createPinnedLookup", "isNonPublicIpLiteral"]);

let fetchProvider = read("packages/web/web-fetch-http/src/provider.ts");
fetchProvider = replace(fetchProvider, "import { WebError } from '@deepseek-ai/dsh-web'", "const { WebError } = require('./runtime')");
fetchProvider = replace(fetchProvider, "import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'", "const { deadline, timeoutOf } = require('./runtime')");
fetchProvider = replace(fetchProvider, "import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'", "");
fetchProvider = replace(fetchProvider, "import { isNonPublicIpLiteral, publicHttpNetwork } from './network.ts'", "const { publicHttpNetwork } = require('./fetch-network')");
fetchProvider = replace(fetchProvider,
  "import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'",
  "const { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } = require('./fetch-policy')");
fetchProvider = replace(fetchProvider, "private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,",
  "private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,\n    private readonly requestNetwork = publicHttpNetwork.request,");
fetchProvider = replace(fetchProvider, "using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')\n    return await this.followAndRead(request.url, d.signal)",
  "const d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')\n    try { return await this.followAndRead(request.url, d.signal) } finally { d.dispose() }");
const proxyStart = fetchProvider.indexOf("      // A proxied hop");
const proxyEnd = fetchProvider.indexOf("      const addresses =", proxyStart);
if (proxyStart < 0 || proxyEnd < 0) throw new Error("Proxy routing moved");
fetchProvider = fetchProvider.slice(0, proxyStart) + "      // The bot uses the upstream resolved-and-pinned transport for every page.\n" + fetchProvider.slice(proxyEnd);
fetchProvider = replace(fetchProvider, "return await publicHttpNetwork.request(url, addresses, headers, signal)", "return await this.requestNetwork(url, addresses, headers, signal)");
write("fetch-provider.js", fetchProvider, ["HttpFetchProvider", "LOCAL_FETCH_PROVIDER_ID"]);

fs.writeFileSync(path.join(output, "upstream.json"), JSON.stringify({
  repository: "https://github.com/deepseek-ai/deepseek-harness", revision, files: manifest,
}, null, 2) + "\n");
console.log(`Vendored ${manifest.length} reviewed files from ${revision}`);
