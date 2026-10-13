const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { loadAzurLanePersonaCatalog } = require("../src/azur-lane-personas");
const { scenarios, holdoutScenarios, interactionScenarios, naturalnessScenarios, contextFor } = require("./chat-ab-fixtures");

const action = process.argv[2] || "run";
const rounds = Number(process.argv[3] || 2);
const outputDir = path.resolve(process.argv[4] || path.join(__dirname, "..", "reports", "deepseek-prompt-ab"));
const baselinePath = path.join(outputDir, "baseline.json");
const resultsPath = path.join(outputDir, "results.json");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function buildMessages(service, catalog, scenario) {
  const personaPrompt = scenario.persona ? catalog.buildPrompt(catalog.getById(scenario.persona)) : "";
  return scenario.mode === "direct"
    ? service.buildDeepSeekMessages({ messages: [] }, { role: "user", content: scenario.sourceMessages.at(-1)[2] }, scenario.context, personaPrompt)
    : service.buildDeepSeekAmbientMessages(scenario.context, scenario.mode, personaPrompt);
}

function summarize(rows) {
  const successful = rows.filter((row) => !row.error);
  const sum = (key) => successful.reduce((total, row) => total + (row.metrics[key] || 0), 0);
  return {
    requests: rows.length, successes: successful.length,
    promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), totalTokens: sum("totalTokens"),
    cacheHitTokens: sum("cacheHitTokens"),
    meanLatencyMs: successful.length ? Math.round(sum("latencyMs") / successful.length) : null,
    meanReplyChars: successful.length ? Math.round(sum("replyChars") / successful.length) : null,
    truncated: successful.filter((row) => row.finishReason === "length").length,
  };
}

async function main() {
  assert.equal(config.deepseekThinkingEnabled, false, "Leave production thinking disabled during prompt comparison");
  assert.equal(config.deepseekModel, "deepseek-flash");
  const service = new AiChatService(config);
  const catalog = loadAzurLanePersonaCatalog({ filePath: config.personaCatalogFile });
  if (action === "snapshot") {
    assert.ok(!fs.existsSync(baselinePath), "Do not overwrite an existing baseline");
    const cases = [...scenarios, ...holdoutScenarios, ...interactionScenarios, ...naturalnessScenarios].map((scenario) => {
      const item = { ...scenario, sourceMessages: scenario.messages, context: contextFor(scenario) };
      delete item.messages;
      item.baselineMessages = buildMessages(service, catalog, item);
      assert.ok(item.context.length > 0 && item.context.length <= 50);
      assert.equal(item.baselineMessages.length, item.context.length + 1);
      item.contextHash = hash(item.context);
      item.baselineMessagesHash = hash(item.baselineMessages);
      return item;
    });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({
      createdAt: new Date().toISOString(), model: config.deepseekModel, temperature: config.deepseekTemperature,
      defaultPrompts: { persona: config.deepseekSystemPrompt, localPersona: config.localQwenSystemPrompt,
        flexibility: config.personaFlexibilityPrompt, naturalChat: config.naturalChatPrompt, ambient: config.ambientChatSystemPrompt },
      cases,
    }, null, 2), "utf8");
    console.log(JSON.stringify({ baselinePath, capturedCases: cases.length, apiRequests: 0 }));
    return;
  }
  assert.equal(action, "run", "Use snapshot or run");
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3);
  assert.ok(config.deepseekApiKey);
  assert.ok(!fs.existsSync(resultsPath), "Do not overwrite existing results");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.equal(config.deepseekTemperature, baseline.temperature);
  const cases = baseline.cases.map((scenario) => ({ ...scenario, candidateMessages: buildMessages(service, catalog, scenario) }));
  for (const scenario of cases) {
    assert.equal(scenario.candidateMessages.length, scenario.context.length + 1);
    assert.equal(hash(scenario.context), scenario.contextHash);
  }
  const experiment = {
    startedAt: new Date().toISOString(), model: config.deepseekModel, temperature: config.deepseekTemperature,
    variants: { A: "previous prompts", B: "candidate prompts" }, thinking: "disabled",
    rounds, scenarioCount: cases.length, equalMaxOutputTokens: 1600, contextLimit: 50,
    contextMessageCounts: [...new Set(cases.map((scenario) => scenario.context.length))].sort((a, b) => a - b),
    notes: ["两组使用相同模型、非思考模式、温度和生成上限。只改变人格/表达/上下文提示文本。",
      "每对请求使用逐字相同的原始群聊记录，轮次交替请求顺序。",
      "保留既有 50 条长上下文场景，并加入不重复填充的短上下文；提示词示意不使用评测中的原话。",
      "这里只对照决定接话后的生成语气，强制生成不表示生产环境应参与所有这些场景。",
      "NPC 感为隐藏 A/B 标签后的主观评估，不代表真人评分或统计显著性。",
      "缓存命中另记，token 合计比例不等于精确账单比例。"],
    cases, results: [], blindMapping: [],
  };
  const save = () => fs.writeFileSync(resultsPath, JSON.stringify(experiment, null, 2), "utf8");
  save();
  let completed = 0;
  for (let round = 1; round <= rounds; round += 1) {
    for (const [index, scenario] of cases.entries()) {
      const variants = (round + index) % 2 ? ["A", "B"] : ["B", "A"];
      for (const variant of variants) {
        const messages = variant === "A" ? scenario.baselineMessages : scenario.candidateMessages;
        const body = service.deepseek.buildCompletionBody(messages, false, {
          maxOutputTokens: experiment.equalMaxOutputTokens, temperature: baseline.temperature,
        });
        const row = { caseId: scenario.id, round, variant, messagesHash: hash(messages), contextHash: scenario.contextHash };
        const started = Date.now();
        try {
          const payload = await service.deepseek.requestCompletion(body, { timeoutMs: 60000 });
          const usage = payload.usage || {};
          row.reply = String(payload.choices?.[0]?.message?.content || "").trim();
          row.finishReason = payload.choices?.[0]?.finish_reason || null;
          row.usage = usage;
          row.metrics = { latencyMs: Date.now() - started, replyChars: Array.from(row.reply).length,
            promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens, cacheHitTokens: usage.prompt_cache_hit_tokens };
          if (!row.reply) row.error = "No visible reply";
        } catch (error) {
          row.error = String(error.message || error).replaceAll(config.deepseekApiKey, "[redacted]");
          row.metrics = { latencyMs: Date.now() - started };
        }
        experiment.results.push(row);
        experiment.summary = { A: summarize(experiment.results.filter((item) => item.variant === "A")),
          B: summarize(experiment.results.filter((item) => item.variant === "B")) };
        save();
        console.log(JSON.stringify({ completed: ++completed, planned: rounds * cases.length * 2,
          caseId: row.caseId, round, variant, metrics: row.metrics, error: row.error }));
      }
    }
  }
  const reviews = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const scenario of cases) {
      const pair = experiment.results.filter((row) => row.caseId === scenario.id && row.round === round);
      if (pair.some((row) => row.error)) continue;
      const order = randomInt(2) ? ["A", "B"] : ["B", "A"];
      const reviewId = `pair-${reviews.length + 1}`;
      reviews.push({ reviewId, scenario: scenario.label, goal: scenario.goal,
        latestContext: scenario.context.slice(-8).map(({ role, senderName, text }) => [role, senderName, text]),
        replies: Object.fromEntries(["X", "Y"].map((slot, index) => [slot, pair.find((row) => row.variant === order[index]).reply])) });
      experiment.blindMapping.push({ reviewId, caseId: scenario.id, round, X: order[0], Y: order[1] });
    }
  }
  fs.writeFileSync(path.join(outputDir, "blind-review.json"), JSON.stringify({
    rubric: "NPC 感 0=自然具体；1=轻微套话/多余建议/硬凑比喻/不合场合的冷淡；2=明显说教/客服/角色表演；3=严重模板；4=完全机械。切题程度 0=不切题；1=部分切题/无依据的细节；2=准确承接。短、俏皮或没句号不自动得高分；明确求助需完整，分享或失落需有合适温度。",
    reviews,
  }, null, 2), "utf8");
  experiment.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ summary: experiment.summary, resultsPath }));
  if (experiment.results.some((row) => row.error)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
