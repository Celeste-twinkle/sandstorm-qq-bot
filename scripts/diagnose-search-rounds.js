// Opt-in live diagnosis. Uses synthetic group messages and never connects to QQ.
// Replay the identical first tool rounds when comparing a larger round budget.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const { WebToolRunner } = require("../src/webtools");
const { mapAnthropicResponse } = require("../src/vendor/deepseek-harness/search-provider");

const prompt = process.env.DIAGNOSE_SEARCH_PROMPT || "deepseek是什么时候火遍全球的，deepseek做了什么？";
const output = path.resolve(process.argv[2] || "reports/deepseek-search-diagnosis-20261014/rounds.json");
const baselineRounds = Number(process.env.DIAGNOSE_SEARCH_ROUNDS || 2);
const extendedRounds = Number(process.env.DIAGNOSE_SEARCH_EXTENDED_ROUNDS || 4);
// Optional saved URL-only failure: replay one model search turn, or also replay
// its premature answer to exercise recovery. Remaining requests use the live API.
const seedReport = process.argv[3] ? JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), "utf8")) : null;
const seedChatCount = Number(process.argv[4] || 1);
let seed;
if (seedReport) {
  assert.equal(seedReport.prompt, prompt, "Recorded prompt must match this diagnosis");
  assert.ok([1, 2].includes(seedChatCount));
  const original = seedReport.results[0];
  assert.equal(original.tools.length, 1, "Only a single search followed by a premature answer is supported");
  assert.equal(original.tools[0].name, "web_search");
  assert.ok(original.tools[0].sources?.length && !original.tools[0].usableEvidence);
  assert.equal(original.chatRequests.length, 2);
  assert.equal(original.chatRequests[0].toolCalls.length, 1);
  assert.ok(!original.chatRequests[1].toolCalls?.length);
  seed = {
    chats: original.chatRequests.slice(0, seedChatCount).map((request) => ({ status: request.status,
      payload: { model: request.model, usage: request.usage, choices: [{ finish_reason: request.finishReason,
        message: { role: "assistant", content: request.answer, tool_calls: request.toolCalls } }] } })),
    tools: [{ call: original.chatRequests[0].toolCalls[0],
      result: { sources: original.tools[0].sources,
        truncated: original.tools[0].truncated ?? original.tools[0].renderedExcerpt.includes("(Showing the first") } }],
  };
}
const replay = { messages: null, chats: [], tools: [] };
const report = { startedAt: new Date().toISOString(), prompt,
  method: "Live baseline; extended budget replays the same prefix of model replies and tool results, then makes real requests. Synthetic one-message group; no QQ connection. Cached prefix tokens shown separately from new billed requests.",
  ...(seed ? { seededFrom: path.relative(path.dirname(output), path.resolve(process.argv[3])), seedChatCount,
    seedMethod: "Replay recorded initial search request and URL-only results through the current formatter. If seedChatCount=2, also replay the premature answer to force recovery. All later model/fetch requests are live; no search API request is repeated." } : {}),
  configuration: { chatModel: config.deepseekModel, thinking: config.deepseekThinkingEnabled,
    searchModel: config.deepseekSearchModel, searchMaxUses: config.deepseekSearchMaxUses,
    maxCallsPerRound: config.webSearchMaxToolCallsPerRound }, results: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");

async function run(id, rounds, replayPrefix) {
  const row = { id, maxToolRounds: rounds, chatRequests: [], nativeSearchResponses: [], tools: [] };
  report.results.push(row);
  const testConfig = { ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false,
    webSearchMaxToolRounds: rounds };
  let chatIndex = 0;
  let toolIndex = 0;
  let prefixActive = replayPrefix;
  const provider = new DeepSeekChatService(testConfig, {
    webToolRunnerFactory(runnerConfig) {
      const runner = new WebToolRunner(runnerConfig, {
        recordSearchResponse(payload) {
          let mapped;
          try { mapped = mapAnthropicResponse(payload); }
          catch (error) { mapped = { mappingError: error.message }; }
          row.nativeSearchResponses.push({ model: payload.model, usage: payload.usage,
            stopReason: payload.stop_reason,
            blocks: payload.content?.map((block) => ({ type: block.type,
              ...(block.type === "text" ? { citations: block.citations, textChars: block.text?.length } : {}),
              ...(block.type === "web_search_tool_result" ? { resultCount: Array.isArray(block.content) ? block.content.length : 0 } : {}) })),
            ...mapped });
        },
      });
      const execute = runner.runToolCall.bind(runner);
      runner.runToolCall = async (call) => {
        const started = Date.now();
        const cached = replayPrefix ? (prefixActive ? replay.tools[toolIndex] : undefined) : seed?.tools[toolIndex];
        if (cached) assert.deepEqual(call, cached.call, "Tool replay must match the identical prefix");
        const result = cached ? structuredClone(cached.result) : await execute(call);
        if (!replayPrefix) replay.tools.push({ call: structuredClone(call), result: structuredClone(result) });
        toolIndex += 1;
        const rendered = runner.formatToolResult(call, result);
        row.tools.push({ replayed: Boolean(cached), chatRequest: chatIndex,
          name: call.function.name, arguments: call.function.arguments,
          elapsedMs: Date.now() - started, code: result.code, error: result.error,
          url: result.url, statusCode: result.statusCode, sources: result.sources, truncated: result.truncated,
          rawBodyChars: result.body?.content.length, renderedChars: rendered.length,
          renderedExcerpt: rendered.slice(0, 20000), usableEvidence: runner.hasUsableEvidence(call, result) });
        save();
        console.log(JSON.stringify({ id, tool: call.function.name, arguments: call.function.arguments,
          code: result.code, http: result.statusCode, usable: row.tools.at(-1).usableEvidence, replayed: Boolean(cached) }));
        return result;
      };
      return runner;
    },
    async fetch(url, options) {
      const body = JSON.parse(options.body);
      const started = Date.now();
      let cached = replayPrefix ? (prefixActive && body.tools ? replay.chats[chatIndex] : undefined) : seed?.chats[chatIndex];
      if (replayPrefix && prefixActive && (!cached || !isDeepStrictEqual(body, cached.body))) {
        // A repair message may include the remaining budget. Beyond this point
        // the prompts differ, so fresh model/tool requests are required.
        prefixActive = false;
        cached = undefined;
        row.liveContinuationAt = chatIndex + 1;
      }
      let response;
      if (cached) {
        if (cached.body) assert.deepEqual(body, cached.body, "Model replay must match the identical prefix");
        response = new Response(JSON.stringify(cached.payload), { status: cached.status,
          headers: { "content-type": "application/json" } });
      } else {
        response = await fetch(url, options);
      }
      const payload = await response.clone().json();
      // Thinking stays disabled; do not retain hidden reasoning even if a provider emits it.
      for (const choice of payload.choices || []) delete choice.message?.reasoning_content;
      if (!replayPrefix && body.tools) replay.chats.push({ body: structuredClone(body), payload, status: response.status });
      chatIndex += 1;
      const message = payload.choices?.[0]?.message;
      row.chatRequests.push({ replayed: Boolean(cached), model: body.model, thinking: body.thinking,
        status: response.status, elapsedMs: Date.now() - started, maxTokens: body.max_tokens,
        toolChoice: body.tool_choice, finishReason: payload.choices?.[0]?.finish_reason,
        usage: payload.usage, answer: message?.content, toolCalls: message?.tool_calls });
      save();
      console.log(JSON.stringify({ id, request: chatIndex, replayed: Boolean(cached),
        finish: payload.choices?.[0]?.finish_reason, tools: message?.tool_calls?.map((call) => call.function.name) }));
      return response;
    },
  });
  const buildMessages = provider.buildWebSearchMessages.bind(provider);
  provider.buildWebSearchMessages = (messages, options) => {
    if (!replayPrefix) replay.messages = buildMessages(messages, options);
    return structuredClone(replay.messages);
  };
  const ai = new AiChatService(testConfig, { deepseekService: provider });
  const started = Date.now();
  try {
    row.reply = await ai.chat(`search-diagnosis:${id}`, prompt, { webSearch: "auto",
      groupContextMessages: [{ role: "user", senderName: "测试成员", userId: "synthetic-member",
        text: prompt, timestamp: Date.now(), messageId: "search-diagnosis" }] });
  } catch (error) {
    row.error = String(error.message || error).split(config.deepseekApiKey).join("[REDACTED]");
  }
  row.elapsedMs = Date.now() - started;
  row.fixedFallback = row.reply === "这个我没查到可靠的消息，暂时不确定。";
  row.newTokens = {
    chatInput: row.chatRequests.filter((request) => !request.replayed).reduce((sum, request) => sum + (request.usage?.prompt_tokens || 0), 0),
    chatOutput: row.chatRequests.filter((request) => !request.replayed).reduce((sum, request) => sum + (request.usage?.completion_tokens || 0), 0),
    searchInput: row.nativeSearchResponses.reduce((sum, response) => sum + (response.usage?.input_tokens || 0)
      + (response.usage?.cache_read_input_tokens || 0) + (response.usage?.cache_creation_input_tokens || 0), 0),
    searchOutput: row.nativeSearchResponses.reduce((sum, response) => sum + (response.usage?.output_tokens || 0), 0),
  };
  save();
  console.log(JSON.stringify({ id, reply: row.reply, error: row.error, newTokens: row.newTokens }));
}

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false, "Do not enable thinking during round diagnosis");
  assert.equal(config.webSearchProvider, "deepseek-official");
  assert.ok(!fs.existsSync(output), "Do not overwrite an existing report");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(`rounds-${baselineRounds}`, baselineRounds, false);
  if (extendedRounds > baselineRounds) await run(`rounds-${extendedRounds}-same-prefix`, extendedRounds, true);
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ output }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
