// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const { EXTERNAL_WEB_CONTENT_NOTICE } = require('./trust');
const WEB_SEARCH_MAX_RESULTS = 8;
const WEB_SEARCH_MAX_QUERIES = 4;
function parseSearchArgs(args, maxQueries) {
    const queries = args?.queries;
    if (!Array.isArray(queries) || queries.some((query)=>typeof query !== 'string')) throw new Error('queries must be an array of strings');
    if (queries.length === 0) throw new Error('queries must contain at least one query');
    if (queries.length > maxQueries) {
        const noun = maxQueries === 1 ? 'query' : 'queries';
        throw new Error(`queries must contain at most ${maxQueries} ${noun}`);
    }
    if (queries.some((query)=>query.trim().length === 0)) throw new Error('each query must be a non-empty string');
    return [
        ...new Set(queries)
    ];
}
function sourceLabel(url, title) {
    if (title !== undefined && title.length > 0) return title;
    try {
        return new URL(url).hostname;
    } catch  {
        return url;
    }
}
function formatSearchOutput(result) {
    const parts = [
        EXTERNAL_WEB_CONTENT_NOTICE
    ];
    if (result.content !== undefined && result.content.length > 0) parts.push(result.content);
    if (result.sources.length > 0) {
        const lines = result.sources.map((source)=>{
            const label = sourceLabel(source.url, source.title);
            const meta = [];
            if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet);
            if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`);
            const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : '';
            return `- [${label}](${source.url})${suffix}`;
        });
        parts.push(`Sources:\n${lines.join('\n')}`);
    } else if (result.content === undefined || result.content.length === 0) {
        parts.push('No results found.');
    }
    if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`);
    parts.push('Cite the relevant URLs above as markdown links in your answer.');
    return parts.join('\n\n');
}
async function runSearchQueries(ctx, queries, maxResults, signal) {
    if (queries.length === 1) {
        return ctx.web.search({
            query: queries[0],
            maxResults
        }, signal);
    }
    const controller = new AbortController();
    const batchSignal = AbortSignal.any([
        signal,
        controller.signal
    ]);
    let firstFailure;
    const results = [];
    const searches = queries.map(async (query, index)=>{
        try {
            results[index] = await ctx.web.search({
                query,
                maxResults
            }, batchSignal);
        } catch (error) {
            if (firstFailure === undefined) firstFailure = {
                error
            };
            controller.abort(error);
            throw error;
        }
    });
    await Promise.allSettled(searches);
    if (firstFailure !== undefined) throw firstFailure.error;
    return mergeSearchResults(queries, results, maxResults);
}
function mergeSearchResults(queries, results, maxResults) {
    const seen = new Set();
    const sources = [];
    let sourceRanks = 0;
    for (const result of results){
        sourceRanks = Math.max(sourceRanks, result.sources.length);
    }
    let droppedSource = false;
    merge: for(let rank = 0; rank < sourceRanks; rank++){
        for (const result of results){
            const source = result.sources[rank];
            if (source !== undefined && !seen.has(source.url)) {
                seen.add(source.url);
                if (sources.length === maxResults) {
                    droppedSource = true;
                    break merge;
                }
                sources.push(source);
            }
        }
    }
    const contents = results.flatMap((result, index)=>{
        if (result.content === undefined || result.content.length === 0) return [];
        return [
            `### ${queries[index]}\n\n${result.content}`
        ];
    });
    return {
        ...contents.length > 0 ? {
            content: contents.join('\n\n')
        } : {},
        sources,
        truncated: results.some((result)=>result.truncated) || droppedSource
    };
}

module.exports = { WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_MAX_QUERIES, parseSearchArgs, formatSearchOutput, runSearchQueries, mergeSearchResults };
