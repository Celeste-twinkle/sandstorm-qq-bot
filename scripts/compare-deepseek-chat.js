const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");

// Offline synthetic group conversations. This script calls DeepSeek only;
// it neither connects to OneBot nor changes .env or the bot's defaults.
const { scenarios, contextFor } = require('./chat-ab-fixtures');

function summarize(rows) {
  const successful = rows.filter((row) => !row.error);
  const sum = (key) => successful.reduce((total, row) => total + (row.metrics[key] || 0), 0);
  const latencies = successful.map((row) => row.metrics.latencyMs).sort((a, b) => a - b);
  return {
    requests: rows.length, successes: successful.length,
    promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"),
    totalTokens: sum("totalTokens"), cacheHitTokens: sum("cacheHitTokens"),
    reasoningTokens: successful.every((row) => row.metrics.reasoningTokens !== null)
      ? sum("reasoningTokens") : null,
    meanLatencyMs: successful.length ? Math.round(sum("latencyMs") / successful.length) : null,
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    meanReplyChars: successful.length ? Math.round(sum("replyChars") / successful.length) : null,
    truncated: successful.filter((row) => row.finishReason === "length").length,
  };
}

async function main() {
  const rounds = Number(process.argv[2] || 2);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, "rounds must be between 1 and 3");
  assert.ok(config.deepseekApiKey, "DeepSeek API key is required");
  assert.equal(config.deepseekModel, "deepseek-flash", "compare using the official Flash model");
  const outputDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, "..", "reports", "deepseek-chat-ab");
  fs.mkdirSync(outputDir, { recursive: true });
  const resultsPath = path.join(outputDir, "results.json");
  const blindPath = path.join(outputDir, "blind-review.json");
  assert.ok(!fs.existsSync(resultsPath), "results.json already exists; archive it before a new run");
  const service = new AiChatService(config);
  const experiment = {
    startedAt: new Date().toISOString(), model: config.deepseekModel,
    rounds, scenarioCount: scenarios.length, contextMessageCount: 50,
    equalMaxOutputTokens: 8192, timeoutMs: 90000,
    variants: {
      A: { thinking: "disabled", temperature: config.deepseekTemperature },
      B: { thinking: "enabled", reasoningEffort: "max" },
    },
    notes: [
      "相同模型、提示词和逐字相同的上下文；轮次交替 A/B 请求顺序。",
      "每个场景包含按时间排列的 50 条合成群消息，包含 bot 发言。",
      "两组统一使用 8192 token 上限，避免推理模式被原有 180 token 闲聊预算截断。",
      "思考模式不支持 temperature；B 未发送该字段。这是实际切换模式的对比。",
      "只保存回复正文和 API usage，不保存或展示隐藏推理正文。",
      "reasoningTokens 为 null 表示 API 未提供该细分，不能用字符数代替 token 数。",
      "缓存命中另记；总 token 比例不能直接当作账单费用比例。",
    ],
    cases: [], results: [], blindMapping: [],
  };
  const save = () => fs.writeFileSync(resultsPath, JSON.stringify(experiment, null, 2), "utf8");
  for (const scenario of scenarios) {
    const context = contextFor(scenario);

    const messages = scenario.mode === "direct"
      ? service.buildDeepSeekMessages({ messages: [] }, { role: "user", content: scenario.messages.at(-1)[2] }, context)
      : service.buildDeepSeekAmbientMessages(context, scenario.mode);
    assert.equal(messages.length, 51);
    const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    experiment.cases.push({ ...scenario, context, messages, messagesHash: hash });
  }
  save();
  let completed = 0;
  for (let round = 1; round <= rounds; round += 1) {
    for (const scenario of experiment.cases) {
      const variants = (round + scenarios.findIndex((item) => item.id === scenario.id)) % 2
        ? ["A", "B"] : ["B", "A"];
      for (const variant of variants) {
        const body = service.deepseek.buildCompletionBody(scenario.messages, variant === "B", {
          maxOutputTokens: experiment.equalMaxOutputTokens,
          temperature: config.deepseekTemperature, reasoningEffort: "max",
        });
        const row = { caseId: scenario.id, round, variant, requestParameters: {
          model: body.model, thinking: body.thinking, reasoningEffort: body.reasoning_effort,
          temperature: body.temperature, maxTokens: body.max_tokens, messagesHash: scenario.messagesHash,
        } };
        const started = Date.now();
        try {
          const payload = await service.deepseek.requestCompletion(body, { timeoutMs: experiment.timeoutMs });
          const message = payload.choices?.[0]?.message;
          const reply = String(message?.content || "").trim();
          const usage = payload.usage || {};
          row.reply = reply;
          row.responseModel = payload.model || null;
          row.finishReason = payload.choices?.[0]?.finish_reason || null;
          row.usage = usage;
          row.metrics = {
            latencyMs: Date.now() - started, replyChars: Array.from(reply).length,
            promptTokens: usage.prompt_tokens ?? null,
            completionTokens: usage.completion_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
            cacheHitTokens: usage.prompt_cache_hit_tokens ?? null,
            cacheMissTokens: usage.prompt_cache_miss_tokens ?? null,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? null,
          };
          if (!reply) row.error = "API returned no visible reply";
        } catch (error) {
          row.error = String(error.message || error).replaceAll(config.deepseekApiKey, "[redacted]");
          row.metrics = { latencyMs: Date.now() - started };
        }
        experiment.results.push(row);
        experiment.summary = {
          A: summarize(experiment.results.filter((item) => item.variant === "A")),
          B: summarize(experiment.results.filter((item) => item.variant === "B")),
        };
        save();
        console.log(JSON.stringify({ completed: ++completed, planned: rounds * scenarios.length * 2,
          caseId: row.caseId, round, variant, metrics: row.metrics, error: row.error }));
      }
    }
  }
  const reviews = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const scenario of experiment.cases) {
      const pair = experiment.results.filter((row) => row.caseId === scenario.id && row.round === round);
      if (pair.some((row) => row.error)) continue;
      const order = randomInt(2) ? ["A", "B"] : ["B", "A"];
      const reviewId = `pair-${reviews.length + 1}`;
      reviews.push({ reviewId, scenario: scenario.label, goal: scenario.goal,
        latestContext: scenario.messages.slice(-3),
        replies: Object.fromEntries(["X", "Y"].map((slot, index) => [slot, pair.find((row) => row.variant === order[index]).reply])),
      });
      experiment.blindMapping.push({ reviewId, caseId: scenario.id, round, X: order[0], Y: order[1] });
    }
  }
  fs.writeFileSync(blindPath, JSON.stringify({
    rubric: "主观 NPC 感 0=自然具体；1=轻微套话/硬凑笑点/多余建议；2=明显客服/说教/表演；3=严重角色模板；4=完全机械。另记切题程度 0=不切题；1=部分切题；2=准确承接。先盲评，再揭示 A/B。",
    reviews,
  }, null, 2), "utf8");
  experiment.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ summary: experiment.summary, resultsPath, blindPath }));
  if (experiment.results.some((row) => row.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
