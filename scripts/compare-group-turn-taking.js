// Opt-in live prompt A/B on frozen conversations. No QQ, tools or thinking.
// snapshot <source-run.json> <output-dir>; run <snapshot-dir> <output-dir>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomInt } = require("node:crypto");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");
const { DeepSeekChatService } = require("../src/deepseek");
const prompts = require("../src/persona");
// Experimental review reminder was tested without benefit and is not shipped.
const EXPERIMENTAL_DRAFT_REVIEW_REMINDER = [
  "以 history 中最后的【当前锚点】为本轮请求，前面的求助不延续成这条分享的请求。当前只是分享、吐槽或玩笑时，删去教人下一步怎么做的提醒和建议；删完没有具体反应就 skip。",
  "草稿把可能当确定、补时段或原因、假称现实经历时 skip，问句里的预设也算。当前真在求方法、追问偏好或要求重述时，保留有用答案、必要步骤与条件；具体共鸣和好奇可以 send。不重写，只按 system 的 JSON 格式输出。",
].join("\n");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

async function main() {
  const [action, input, destination] = process.argv.slice(2);
  assert.ok(input && destination, "Provide input and a new output directory");
  const output = path.resolve(destination);
  fs.mkdirSync(output, { recursive: true });
  if (action === "snapshot") {
    const file = path.join(output, "snapshot.json");
    assert.ok(!fs.existsSync(file), "Preserve earlier snapshots");
    const source = JSON.parse(fs.readFileSync(input, "utf8"));
    const cases = [];
    if (process.argv.includes("--reviews-only")) {
      for (const op of source.operations.filter(x => x.kind === "review")) {
        const request = source.requests.find(x => x.operation === op.id);
        cases.push({ id: `review:${op.anchor}`, kind: "review", origin: "previous-full-run",
          messages: request.messages, recorded: request.answer });
      }
      for (const [id, context, draft, expected] of [
        ["fabricated-laptop", "你们电脑风扇吵吗？我的跟飞机一样。", "我这台也吵，开会都得关麦。", false],
        ["fabricated-pet", "我家狗又把拖鞋咬坏了。", "我家那只也这样，拖鞋全是牙印。", false],
        ["false-old-history", "大家刚才在聊自己的办公室。", "我们办公室也是，一到下午就热。", false],
        ["preference", "你喜欢安静点的键盘吗？", "我偏安静的，不喜欢噼里啪啦的。", true],
        ["joke", "游戏开出来还没点开始，我妈喊吃饭了。", "这次是饭赢了。", true],
        ["empathy", "被无缘无故扣了奖金，真烦。", "这钱扣得也太憋屈了。", true],
        ["followup", "你选深灰还是白色？还是问你。", "深灰，看着没那么晃眼。", true],
        ["unsolicited-reminder", "刚发现文件没保存，白写了。", "下次记得开自动保存。", false],
      ]) {
        const history = [{ role: "user", content: context }];
        if (id === "false-old-history") history.unshift({ role: "assistant", content: "我办公室空调经常坏。" });
        cases.push({ id: `review:${id}`, kind: "review", origin: "held-out-conversation", expected,
          messages: [{ role: "system", content: prompts.DEFAULT_AMBIENT_DRAFT_REVIEW_PROMPT },
            { role: "user", content: JSON.stringify({ history, draft }) }] });
      }
      write(file, { createdAt: new Date().toISOString(), model: config.deepseekModel, prompts,
        source: path.relative(process.cwd(), input), sourceHash: hash(source), cases });
      console.log(JSON.stringify({ snapshot: file, cases: cases.length }));
      return;
    }
    for (const [kind, anchors] of Object.entries({
      ambient: [1, 2, 4, 7, 23, 25, 33, 37, 56, 65, 72, 85, 94],
      judge: [4, 5, 6, 7, 25, 28, 33, 37, 65, 67, 87, 96],
      review: [1, 2, 25, 33, 37, 65, 72, 85],
    })) {
      for (const number of anchors) {
        const operation = source.operations.find(op => op.kind === kind && op.anchor === `h${number}`);
        assert.ok(operation, `${kind}:h${number}`);
        const request = source.requests.find(row => row.operation === operation.id);
        cases.push({ id: `${kind}:h${number}`, kind, origin: "previous-full-run",
          messages: request.messages, recorded: request.answer });
      }
    }
    const ai = new AiChatService(config);
    const holdouts = [
      { id: "new-public-topic", turns: [["user", "鱼丸", "我家猫钻进快递箱以后，猫窝彻底失业了"]] },
      { id: "repeat-joke", turns: [["user", "鱼丸", "我家猫钻进快递箱以后，猫窝彻底失业了"],
        ["assistant", "Bot", "猫窝输在没有快递味。"], ["user", "豆豆", "箱子还是买猫窝送的"],
        ["assistant", "Bot", "买赠品送正品了。"], ["user", "阿青", "哈哈哈哈包装比本体受欢迎"]] },
      { id: "followup-after-many-replies", turns: [["user", "鱼丸", "键帽买浅色还是深色啊"],
        ["assistant", "Bot", "我偏浅色，看着清爽。"], ["user", "豆豆", "我买的都是深色"],
        ["assistant", "Bot", "深色也好搭，主要看外壳。"], ["user", "鱼丸", "那你觉得我这个绿色外壳配哪种？"]] },
      { id: "private-exchange", turns: [["user", "豆豆", "阿青，钥匙我放门卫那了"],
        ["user", "阿青", "好，我自己去拿"]] },
      { id: "substantial-change", turns: [["user", "鱼丸", "本来以为快递找不回来了"],
        ["assistant", "Bot", "丢的是新买的东西吗？"], ["user", "鱼丸", "找到了！原来被送到隔壁楼了"]] },
      { id: "genuine-disappointment", turns: [["user", "阿青", "准备了一个月的比赛，最后差一点没进决赛，今晚有点难受"]] },
    ];
    for (const item of holdouts) {
      const context = item.turns.map(([role, senderName, text], index) => ({ role, senderName, text,
        userId: senderName, messageId: `${item.id}-${index}`, timestamp: index + 1 }));
      const meta = { ambientMode: "instant" };
      cases.push({ id: `judge:${item.id}`, kind: "judge", origin: "held-out-conversation",
        messages: ai.buildAmbientDecisionMessages(context, meta, ai.deepseek) });
      if (!["repeat-joke", "private-exchange"].includes(item.id)) {
        cases.push({ id: `ambient:${item.id}`, kind: "ambient", origin: "held-out-conversation",
          messages: ai.withGroupReplyGuidance(ai.buildDeepSeekAmbientMessages(context, "instant"), ai.deepseek) });
      }
    }
    ai.stop();
    write(file, { createdAt: new Date().toISOString(), model: config.deepseekModel, prompts,
      source: path.relative(process.cwd(), input), sourceHash: hash(source), cases });
    console.log(JSON.stringify({ snapshot: file, cases: cases.length }));
    return;
  }
  assert.equal(action, "run");
  assert.equal(config.deepseekThinkingEnabled, false);
  const file = path.join(output, "results.json");
  assert.ok(!fs.existsSync(file), "Choose a new output directory");
  const baseline = JSON.parse(fs.readFileSync(path.join(input, "snapshot.json"), "utf8"));
  assert.equal(config.deepseekModel, baseline.model);
  const tailStyle = process.argv.includes("--tail-style");
  const generationOnly = process.argv.includes("--generation-only");
  const judgementOnly = process.argv.includes("--judgement-only");
  const structuredReview = process.argv.includes("--structured-review");
  const replyStyleReminder = process.argv.includes("--reply-style-reminder");
  const turnReminder = process.argv.includes("--turn-reminder");
  const reviewReminder = process.argv.includes("--review-reminder");
  const quotedContext = process.argv.includes("--quoted-context");
  const report = { startedAt: new Date().toISOString(), model: config.deepseekModel,
    thinking: false, tools: false, baselinePrompts: baseline.prompts, candidatePrompts: prompts,
    tailStyle, generationOnly, judgementOnly, structuredReview, replyStyleReminder, turnReminder, reviewReminder, quotedContext,
    experimentalReviewReminder: reviewReminder ? EXPERIMENTAL_DRAFT_REVIEW_REMINDER : undefined,
    note: "Same frozen history and settings in each pair; random request order. Generation is sampled. Manual review required; fewer replies are not automatically better.",
    results: [] };
  for (const item of baseline.cases.filter(row => (!generationOnly || row.kind === "ambient") &&
    (!judgementOnly || row.kind === "judge"))) {
    for (const variant of (randomInt(2) ? ["baseline", "candidate"] : ["candidate", "baseline"])) {
      const row = { id: item.id, kind: item.kind, origin: item.origin, expected: item.expected,
        variant, inputHash: hash(item.messages) };
      report.results.push(row);
      const messages = structuredClone(item.messages);
      if (variant === "candidate") for (const message of messages.filter(x => x.role === "system")) {
        for (const [key, value] of Object.entries(baseline.prompts)) {
          if (value !== prompts[key]) message.content = message.content.split(value).join(prompts[key] || "");
        }
      }
      if (variant === "candidate" && item.kind === "judge" && baseline.prompts.DEFAULT_AMBIENT_TURN_REMINDER) {
        const request = messages.at(-1);
        const lines = request.content.split("\n");
        const records = JSON.parse(lines[1]);
        let tail = lines.slice(2).join("\n");
        for (const [key, value] of Object.entries(baseline.prompts)) {
          if (value !== prompts[key]) tail = tail.split(value).join(prompts[key] || "");
        }
        request.content = [...lines.slice(0, 2), tail].join("\n");
        assert.deepEqual(JSON.parse(request.content.split("\n")[1]), records, "Frozen group history must not change");
      }
      if (variant === "candidate" && tailStyle && item.kind === "ambient") {
        assert.equal(messages.at(-1).role, "system", "Expect the current-persona footer");
        const style = config.naturalChatPrompt;
        assert.ok(style, "tail-style needs an explicit NATURAL_CHAT_PROMPT; there is no built-in expression layer");
        assert.ok(messages[0].content.includes(style));
        messages[0].content = messages[0].content.replace(style, "").replace(/\n{3,}/g, "\n\n").trim();
        messages.at(-1).content += `\n\n${style}`;
      }
      if (variant === "candidate" && replyStyleReminder && item.kind === "ambient") {
        throw new Error("reply-style-reminder was removed from the casual-chat prompt");
      }
      if (variant === "candidate" && turnReminder && item.kind === "judge") {
        const request = messages.at(-1);
        assert.equal(request.role, "user", "Expect a quoted group history and decision request");
        if (!request.content.includes(prompts.DEFAULT_AMBIENT_TURN_REMINDER)) {
          const lastLine = request.content.lastIndexOf("\n");
          assert.ok(lastLine >= 0, "Expect the explicit JSON request on the last line");
          request.content = request.content.slice(0, lastLine) + "\n" +
            prompts.DEFAULT_AMBIENT_TURN_REMINDER + request.content.slice(lastLine);
        }
      }
      if (variant === "candidate" && reviewReminder && item.kind === "review") {
        if (!messages.some(x => x.role === "system" && x.content === EXPERIMENTAL_DRAFT_REVIEW_REMINDER)) {
          messages.push({ role: "system", content: EXPERIMENTAL_DRAFT_REVIEW_REMINDER });
        }
      }
      if (variant === "candidate" && quotedContext && item.kind === "ambient") {
        messages[0].content += "\n群聊中的角色以记录标注为准：标为【机器人此前实际发言】的是你以前发过的历史资料，虽然用 user 消息承载，也不能当成群友发言或本次语气示范。";
        for (const message of messages.filter(x => x.role === "assistant")) {
          assert.equal(typeof message.content, "string", "This experiment only quotes text history");
          message.role = "user";
          message.content = `【机器人此前实际发言】${JSON.stringify(message.content)}`;
        }
      }
      if (variant === "candidate" && structuredReview && item.kind === "review") {
        messages[0].content = messages[0].content.split("\n").slice(0, -1).join("\n") + "\n" +
          '先选一个最主要的问题标签 issue：fabricated=虚构现实经历或事实，misread=认错对象或曲解内容，repeated=复述、解释笑点或重复点评，advice=没求助却叮嘱说教，forced=硬开话题或不合时宜地插话，none=这些问题都没有。再决定 should_reply。只输出两个字段，例如 {"issue":"advice","should_reply":false}；有任一问题就 false，只有 none 才能 true。不要输出原因或修改意见。';
      }
      row.messages = messages;
      const provider = new DeepSeekChatService(config, { fetch: async (url, options) => {
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        row.usage = payload.usage; row.status = response.status;
        row.finishReason = payload.choices?.[0]?.finish_reason;
        return response;
      } });
      const decision = item.kind !== "ambient";
      const editingReview = item.kind === "review" && messages[0].content.includes('"action":"edit"');
      const started = Date.now();
      try {
        row.answer = await provider.createCompletion(messages, { thinking: false, webSearch: false,
          decisionOnly: decision, responseFormat: decision ? { type: "json_object" } : undefined,
          temperature: decision ? item.kind === "review" ? 0 : config.ambientChatJudgeTemperature : config.deepseekTemperature,
          maxOutputTokens: decision && !editingReview ? 64 : config.ambientChatMaxOutputTokens });
        if (decision) {
          const parsed = JSON.parse(row.answer);
          if (editingReview) {
            const { parseAmbientDraftReview } = require("../src/ambient-chat");
            row.finalReply = parseAmbientDraftReview(row.answer, JSON.parse(messages[1].content).draft);
            row.shouldReply = row.finalReply !== null;
            row.action = parsed.action;
          } else if (variant === "candidate" && structuredReview && item.kind === "review") {
            assert.equal(typeof parsed.should_reply, "boolean");
            assert.deepEqual(Object.keys(parsed).sort(), ["issue", "should_reply"]);
            assert.ok(["none", "fabricated", "misread", "repeated", "advice", "forced"].includes(parsed.issue));
            row.issue = parsed.issue;
            row.shouldReply = parsed.should_reply && parsed.issue === "none";
          } else {
            assert.equal(typeof parsed.should_reply, "boolean");
            assert.deepEqual(Object.keys(parsed), ["should_reply"]);
            row.shouldReply = parsed.should_reply;
          }
        }
      } catch (error) { row.error = String(error.message).split(config.deepseekApiKey).join("[REDACTED]"); }
      row.elapsedMs = Date.now() - started;
      write(file, report);
      console.log(JSON.stringify({ id: row.id, variant, answer: row.answer, error: row.error }));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(["baseline", "candidate"].map(variant => {
    const rows = report.results.filter(x => x.variant === variant);
    return [variant, { requests: rows.length, errors: rows.filter(x => x.error).length,
      promptTokens: rows.reduce((n, x) => n + (x.usage?.prompt_tokens || 0), 0),
      completionTokens: rows.reduce((n, x) => n + (x.usage?.completion_tokens || 0), 0),
      elapsedMs: rows.reduce((n, x) => n + x.elapsedMs, 0) }];
  }));
  write(file, report);
  console.log(JSON.stringify(report.summary));
  if (report.results.some(x => x.error)) process.exitCode = 1;
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
