// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const { WebError } = require('./runtime');
const { deadline, timeoutOf } = require('./runtime');
const { publicHttpNetwork } = require('./fetch-network');
const { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } = require('./fetch-policy');
const LOCAL_FETCH_PROVIDER_ID = 'http';
class HttpFetchProvider {
    limits;
    resolveAddresses;
    requestNetwork;
    id = LOCAL_FETCH_PROVIDER_ID;
    constructor(limits, resolveAddresses = publicHttpNetwork.resolve, requestNetwork = publicHttpNetwork.request){
        this.limits = limits;
        this.resolveAddresses = resolveAddresses;
        this.requestNetwork = requestNetwork;
    }
    available() {
        return true;
    }
    async fetch(request, signal) {
        if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED');
        const d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT');
        try {
            return await this.followAndRead(request.url, d.signal);
        } finally{
            d.dispose();
        }
    }
    async followAndRead(initialUrl, signal) {
        let currentUrl = validateFetchUrl(initialUrl);
        let redirectsFollowed = 0;
        for(;;){
            const request = await this.requestOnce(currentUrl, signal);
            const { response } = request;
            try {
                if (isRedirectStatus(response.status)) {
                    if (redirectsFollowed >= this.limits.maxRedirects) {
                        await response.body?.cancel();
                        throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED');
                    }
                    const location = response.headers.get('location');
                    if (location === null) {
                        await response.body?.cancel();
                        throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR');
                    }
                    const target = resolveRedirect(location, currentUrl);
                    let validatedTarget;
                    try {
                        validatedTarget = validateFetchUrl(target.toString());
                        if (!isSameOrigin(validatedTarget, currentUrl)) {
                            throw new WebError(`cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`, 'WEB_REDIRECT_BLOCKED');
                        }
                    } catch (error) {
                        await response.body?.cancel();
                        throw error;
                    }
                    await response.body?.cancel();
                    currentUrl = validatedTarget;
                    redirectsFollowed++;
                    continue;
                }
                return await this.readBody(response, currentUrl, signal);
            } finally{
                await request.close();
            }
        }
    }
    async requestOnce(url, signal) {
        const headers = {
            'user-agent': this.limits.userAgent,
            'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8'
        };
        try {
            const addresses = await this.resolveAddresses(url.hostname, signal);
            return await this.requestNetwork(url, addresses, headers, signal);
        } catch (error) {
            if (error instanceof WebError) throw error;
            throw translateAbortOrNetwork(error, signal);
        }
    }
    async readBody(response, finalUrl, signal) {
        const contentType = response.headers.get('content-type');
        const kind = classifyContentType(contentType);
        if (kind === undefined) {
            await response.body?.cancel();
            throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE');
        }
        let decoder;
        try {
            decoder = decoderForCharset(parseCharset(contentType));
        } catch (error) {
            await response.body?.cancel();
            throw error;
        }
        const { bytes, truncatedByBytes } = await this.readCapped(response, signal);
        const decoded = decoder.decode(bytes);
        const truncatedByChars = decoded.length > this.limits.maxBodyChars;
        const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded;
        const body = kind === 'html' ? {
            kind: 'html',
            content
        } : {
            kind: 'text',
            content
        };
        return {
            url: finalUrl.toString(),
            statusCode: response.status,
            body,
            truncated: truncatedByBytes || truncatedByChars
        };
    }
    async readCapped(response, signal) {
        const declared = response.headers.get('content-length');
        if (declared !== null) {
            const length = Number(declared);
            if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
                await response.body?.cancel();
                throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE');
            }
        }
        if (response.body === null) return {
            bytes: new Uint8Array(0),
            truncatedByBytes: false
        };
        const chunks = [];
        let total = 0;
        let truncatedByBytes = false;
        const reader = response.body.getReader();
        try {
            for(;;){
                const { done, value } = await reader.read();
                if (done) break;
                const remaining = this.limits.maxResponseBytes - total;
                if (value.byteLength > remaining) {
                    chunks.push(value.subarray(0, remaining));
                    total += remaining;
                    truncatedByBytes = true;
                    break;
                }
                chunks.push(value);
                total += value.byteLength;
            }
        } catch (error) {
            throw translateAbortOrNetwork(error, signal);
        } finally{
            await reader.cancel().catch(()=>{});
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks){
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return {
            bytes,
            truncatedByBytes
        };
    }
}
function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function resolveRedirect(location, base) {
    try {
        return new URL(location, base);
    } catch (error) {
        throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', {
            cause: error
        });
    }
}
function translateAbortOrNetwork(error, signal) {
    const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT');
    if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', {
        cause: timeout
    });
    if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', {
        cause: error
    });
    return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error
    });
}

module.exports = { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID };
