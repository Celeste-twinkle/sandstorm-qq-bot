// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const { WebError } = require('./runtime');
const DEEPSEEK_PROVIDER_ID = 'deepseek-official';
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01';
const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
const DEEPSEEK_DEFAULT_MAX_USES = 5;
const USER_AGENT = 'sandstorm-qq-bot/1.0 deepseek-harness-web';
function citationSnippets(blocks) {
    const map = new Map();
    for (const block of blocks){
        if (block.type !== 'text') continue;
        for (const cite of block.citations ?? []){
            if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
                map.set(cite.url, cite.cited_text);
            }
        }
    }
    return map;
}
function mapAnthropicResponse(response) {
    const blocks = response.content ?? [];
    const resultBlocks = blocks.filter((block)=>block.type === 'web_search_tool_result');
    if (resultBlocks.length === 0) {
        throw new WebError('DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search', 'WEB_PROVIDER_ERROR');
    }
    const snippets = citationSnippets(blocks);
    const seen = new Set();
    const sources = [];
    for (const block of resultBlocks){
        for (const item of block.content ?? []){
            if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue;
            seen.add(item.url);
            const snippet = snippets.get(item.url);
            sources.push({
                url: item.url,
                ...item.title != null && item.title.length > 0 ? {
                    title: item.title
                } : {},
                ...snippet != null && snippet.length > 0 ? {
                    snippet
                } : {},
                ...item.page_age != null && item.page_age.length > 0 ? {
                    publishedAt: item.page_age
                } : {}
            });
        }
    }
    return {
        sources,
        truncated: false
    };
}
class DeepSeekSearchProvider {
    resolveOptions;
    fetchImpl;
    id = DEEPSEEK_PROVIDER_ID;
    constructor(resolveOptions, fetchImpl = globalThis.fetch){
        this.resolveOptions = resolveOptions;
        this.fetchImpl = fetchImpl;
    }
    available() {
        const options = this.resolveOptions();
        return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined || options.resolveAccountToken !== undefined) && URL.canParse(options.baseURL) && isPositiveInteger(options.maxTokens) && isPositiveInteger(options.maxUses);
    }
    async search(request, signal) {
        const options = this.resolveOptions();
        const endpoint = `${options.baseURL}/messages`;
        const auth = await this.authHeaders(options, endpoint, signal);
        throwIfSearchAborted(signal);
        const body = {
            model: options.model,
            max_tokens: options.maxTokens,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Perform a web search for the query: ${request.query}`
                        }
                    ]
                }
            ],
            tools: [
                {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    max_uses: options.maxUses
                }
            ]
        };
        options.recordRequest?.({
            endpoint,
            apiVersion: options.apiVersion,
            body
        });
        throwIfSearchAborted(signal);
        let response;
        try {
            response = await this.fetchImpl(endpoint, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    ...auth.headers,
                    'anthropic-version': options.apiVersion,
                    'content-type': 'application/json',
                    'accept': 'application/json',
                    'user-agent': USER_AGENT
                },
                body: JSON.stringify(body),
                ...signal !== undefined ? {
                    signal
                } : {}
            });
        } catch (error) {
            if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
            throw searchEndpointError(endpoint, `DeepSeek search request failed: ${String(error)}`, error);
        }
        if (!response.ok) {
            const status = response.status;
            let message = `DeepSeek API error (HTTP ${status})`;
            try {
                const parsed = await response.json();
                const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
                if (detail !== undefined && detail.length > 0) message += `: ${detail}`;
            } catch (error) {
                if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
            }
            if (status === 401 && auth.kind === 'account') throw accountRejectedError(message);
            throw searchEndpointError(endpoint, message);
        }
        try {
            const payload = await response.json();
            options.recordResponse?.(payload);
            return mapAnthropicResponse(payload);
        } catch (error) {
            if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
            const message = error instanceof WebError ? error.message : `DeepSeek returned an unprocessable response body: ${String(error)}`;
            throw searchEndpointError(endpoint, message, error);
        }
    }
    async authHeaders(options, endpoint, signal) {
        const { resolveAccountToken } = options;
        const token = resolveAccountToken === undefined ? undefined : await resolveCredential(()=>resolveAccountToken(endpoint), signal);
        if (token !== undefined && token.length > 0) return {
            kind: 'account',
            headers: {
                'x-dsh-auth-token': token
            }
        };
        const apiKey = await this.apiKey(options, signal);
        return {
            kind: 'api-key',
            headers: {
                'x-api-key': apiKey,
                'authorization': `Bearer ${apiKey}`
            }
        };
    }
    async apiKey(options, signal) {
        throwIfSearchAborted(signal);
        if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
        const { resolveApiKey } = options;
        const resolved = resolveApiKey === undefined ? undefined : await resolveCredential(resolveApiKey, signal);
        if (resolved !== undefined && resolved.length > 0) return resolved;
        const ref = options.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
        throw new WebError(`DeepSeek search has no API key for "${ref}"; set DEEPSEEK_API_KEY in the bot environment.`, 'WEB_PROVIDER_CREDENTIAL_MISSING');
    }
}
async function resolveCredential(resolve, signal) {
    throwIfSearchAborted(signal);
    try {
        return await abortable(resolve(), signal);
    } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
        throw new WebError(`DeepSeek search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
            cause: error
        });
    }
}
function accountRejectedError(message) {
    return new WebError(`${message}\n\nDeepSeek rejected the account sign-in used for this web search. ` + 'Guide the user to sign in to DeepSeek again; the search endpoint does not need changing.', 'WEB_PROVIDER_ERROR');
}
function searchEndpointError(endpoint, message, cause) {
    return new WebError(`${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. ` + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, ' + 'set DEEPSEEK_SEARCH_BASE_URL in the bot environment to a trusted Anthropic-compatible Messages API base. ' + 'Only the operator should choose or change that endpoint.', 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : {
        cause
    });
}
function abortable(operation, signal) {
    if (signal === undefined) return operation;
    if (signal.aborted) return Promise.reject(searchAborted(signal));
    return new Promise((resolve, reject)=>{
        const onAbort = ()=>{
            reject(searchAborted(signal));
        };
        signal.addEventListener('abort', onAbort, {
            once: true
        });
        void operation.then((value)=>{
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error)=>{
            signal.removeEventListener('abort', onAbort);
            reject(new Error(String(error).replace(/^Error: /u, ''), {
                cause: error
            }));
        });
    });
}
function throwIfSearchAborted(signal) {
    if (signal?.aborted === true) throw searchAborted(signal);
}
function searchAborted(signal, fallback) {
    return new WebError('DeepSeek search aborted', 'WEB_ABORTED', {
        cause: signal?.aborted === true ? signal.reason : fallback
    });
}
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

module.exports = { DeepSeekSearchProvider, mapAnthropicResponse, citationSnippets, DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_DEFAULT_API_VERSION, DEEPSEEK_DEFAULT_MAX_TOKENS, DEEPSEEK_DEFAULT_MAX_USES };
