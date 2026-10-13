// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');
const { EXTERNAL_WEB_CONTENT_NOTICE } = require('./trust');
const assertNever = ()=>{
    throw new Error('unhandled web fetch body kind');
};
const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
});
turndown.use(gfm);
turndown.addRule('removeNonVisibleContent', {
    filter (node) {
        if ([
            'SCRIPT',
            'STYLE',
            'NOSCRIPT',
            'TEMPLATE',
            'IFRAME',
            'OBJECT',
            'EMBED'
        ].includes(node.nodeName)) return true;
        if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
        if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true;
        const declarations = node.getAttribute('style')?.split(';') ?? [];
        return declarations.some((declaration)=>{
            const separator = declaration.indexOf(':');
            if (separator === -1) return false;
            const property = declaration.slice(0, separator).trim().toLowerCase();
            const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '');
            return property === 'display' && value === 'none' || property === 'visibility' && (value === 'hidden' || value === 'collapse');
        });
    },
    replacement () {
        return '';
    }
});
function renderTableCell(content, index) {
    const prefix = index === 0 ? '| ' : ' ';
    const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ');
    return `${prefix}${escaped} |`;
}
function isTableHeadingRow(row) {
    const cells = Array.from(row.cells);
    const section = row.parentElement;
    const table = section.parentElement;
    return (section.nodeName === 'THEAD' || table.rows[0] === row) && cells.every((cell)=>cell.nodeName === 'TH');
}
function tableBorder(cell) {
    const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase();
    if (alignment === 'left') return ':---';
    if (alignment === 'right') return '---:';
    if (alignment === 'center') return ':---:';
    return '---';
}
turndown.addRule('tableCellWithoutSpanExpansion', {
    filter: [
        'th',
        'td'
    ],
    replacement (content, node) {
        const cell = node;
        const row = cell.parentNode;
        return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell));
    }
});
turndown.addRule('tableRowWithoutSpanExpansion', {
    filter: 'tr',
    replacement (content, node) {
        const row = node;
        const border = isTableHeadingRow(row) ? Array.from(row.cells, (cell, index)=>renderTableCell(tableBorder(cell), index)).join('') : '';
        return `\n${content}${border.length > 0 ? `\n${border}` : ''}`;
    }
});
function parseFetchArgs(args) {
    if (args.url.trim().length === 0) throw new Error('url must be a non-empty string');
    return {
        url: args.url
    };
}
const MAX_CONVERSION_DEPTH = 512;
const VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);
const RAW_TEXT_ELEMENTS = new Set([
    'script',
    'style',
    'noscript'
]);
function isTagBoundary(char) {
    return char === undefined || char === '>' || char === '/' || /\s/.test(char);
}
function findRawTextEnd(lowerHtml, name, from) {
    const prefix = `</${name}`;
    let candidate = lowerHtml.indexOf(prefix, from);
    while(candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])){
        candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
    }
    return candidate;
}
function exceedsConversionDepth(html) {
    const lowerHtml = html.toLowerCase();
    const openElements = [];
    let offset = 0;
    let inComment = false;
    while(offset < html.length){
        const start = html.indexOf('<', offset);
        if (inComment) {
            const end = html.indexOf('-->', offset);
            if (end !== -1 && (start === -1 || end < start)) {
                inComment = false;
                offset = end + 3;
                continue;
            }
        }
        if (start === -1) break;
        if (!inComment && html.startsWith('<!--', start)) {
            inComment = true;
            offset = start + 4;
            continue;
        }
        let cursor = start + 1;
        const closing = html[cursor] === '/';
        if (closing) cursor += 1;
        const nameStart = cursor;
        while(/[a-zA-Z0-9-]/.test(html[cursor] ?? ''))cursor += 1;
        if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
            offset = start + 1;
            continue;
        }
        const name = lowerHtml.slice(nameStart, cursor);
        let quote;
        while(cursor < html.length){
            const char = html[cursor];
            cursor += 1;
            if (quote !== undefined) {
                if (char === quote) quote = undefined;
            } else if (char === '"' || char === "'") {
                quote = char;
            } else if (char === '>') {
                break;
            }
        }
        if (html[cursor - 1] !== '>') break;
        if (closing) {
            if (!inComment && openElements.at(-1) === name) openElements.pop();
        } else {
            let last = cursor - 2;
            while(/\s/.test(html.charAt(last)))last -= 1;
            if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
                openElements.push(name);
                if (openElements.length > MAX_CONVERSION_DEPTH) return true;
                if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
                    const end = findRawTextEnd(lowerHtml, name, cursor);
                    if (end === -1) break;
                    offset = end;
                    continue;
                }
            }
        }
        offset = cursor;
    }
    return false;
}
function renderBody(body, maxInputChars) {
    const content = body.content.slice(0, maxInputChars);
    const sourceTruncated = content.length !== body.content.length;
    switch(body.kind){
        case 'html':
            if (exceedsConversionDepth(content)) return {
                text: '[HTML content omitted: unable to convert safely.]',
                sourceTruncated
            };
            try {
                return {
                    text: turndown.turndown(content),
                    sourceTruncated
                };
            } catch  {
                return {
                    text: '[HTML content omitted: unable to convert safely.]',
                    sourceTruncated
                };
            }
        case 'text':
            return {
                text: content,
                sourceTruncated
            };
        default:
            return assertNever(body, 'unhandled web fetch body kind');
    }
}
const TRUNCATION_FOOTER = '\n\n(Content truncated. Fetch a more specific URL or section for the full text.)';
function renderFetchOutput(result, maxOutputChars) {
    const byCap = renderCache.get(result) ?? new Map();
    const cached = byCap.get(maxOutputChars);
    if (cached !== undefined) return cached;
    const computed = computeFetchOutput(result, maxOutputChars);
    byCap.set(maxOutputChars, computed);
    renderCache.set(result, byCap);
    return computed;
}
const renderCache = new WeakMap();
function computeFetchOutput(result, maxOutputChars) {
    const header = `Fetched ${result.url} (HTTP ${result.statusCode})\n\n${EXTERNAL_WEB_CONTENT_NOTICE}\n\n`;
    const rendered = renderBody(result.body, maxOutputChars);
    const prefix = `${header}${rendered.text}`;
    const truncated = result.truncated || rendered.sourceTruncated || prefix.length > maxOutputChars;
    const full = `${prefix}${truncated ? TRUNCATION_FOOTER : ''}`;
    if (full.length <= maxOutputChars) return {
        text: full,
        truncated
    };
    if (maxOutputChars < TRUNCATION_FOOTER.length) return {
        text: full.slice(0, maxOutputChars),
        truncated
    };
    return {
        text: `${prefix.slice(0, maxOutputChars - TRUNCATION_FOOTER.length)}${TRUNCATION_FOOTER}`,
        truncated
    };
}
function formatFetchOutput(result, maxOutputChars) {
    return renderFetchOutput(result, maxOutputChars).text;
}

module.exports = { formatFetchOutput, renderFetchOutput, TRUNCATION_FOOTER };
