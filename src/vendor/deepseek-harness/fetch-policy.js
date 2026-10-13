// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const { WebError } = require('./runtime');
const WEB_FETCH_MAX_URL_LENGTH = 2048;
function parseFetchUrl(input) {
    let url;
    try {
        url = new URL(input);
    } catch (error) {
        throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', {
            cause: error
        });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL');
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL');
    }
    return url;
}
function validateFetchUrl(input) {
    if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
        throw new WebError(`URL exceeds the maximum length of ${WEB_FETCH_MAX_URL_LENGTH}`, 'WEB_INVALID_URL');
    }
    return parseFetchUrl(input);
}
function isSameOrigin(a, b) {
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}
function classifyContentType(contentType) {
    const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
    if (mime.startsWith('text/')) return 'text';
    if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
    return undefined;
}
function parseCharset(contentType) {
    const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
    return match?.[1]?.trim().toLowerCase();
}
function decoderForCharset(charset) {
    if (charset === undefined) return new TextDecoder('utf-8');
    try {
        return new TextDecoder(charset);
    } catch (error) {
        throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', {
            cause: error
        });
    }
}

module.exports = { WEB_FETCH_MAX_URL_LENGTH, parseFetchUrl, validateFetchUrl, isSameOrigin, classifyContentType, parseCharset, decoderForCharset };
