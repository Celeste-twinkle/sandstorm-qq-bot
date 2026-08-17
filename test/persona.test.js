const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  COMPACT_PROMPT_LINE_COUNT,
  createAzurLanePersonaCatalog,
  loadAzurLanePersonaCatalog,
  normalizePersonaQuery,
} = require("../src/azur-lane-personas");
const {
  buildCustomPersonaPrompt,
  calculateCustomPersonaMaxChars,
  countUnicodeCharacters,
  formatCurrentPersona,
  formatPersonaCommandHelp,
  formatPersonaDetails,
  formatPersonaList,
  isMasterPersonaQuery,
  parsePersonaCommand,
  resolvePersonaCommandRequest,
} = require("../src/persona-commands");
const {
  PersonaSelectionStore,
  STORE_SCHEMA_VERSION,
  resolvePersonaSelectionPath,
} = require("../src/persona-selection-store");
const { DEFAULT_AI_PERSONA_PROMPT } = require("../src/persona");

test("external catalog loads 48 validated personas with max-affection defaults", () => {
  const catalog = loadAzurLanePersonaCatalog();

  assert.equal(catalog.personas.length, 48);
  assert.equal(catalog.defaultState.affection, "MAX");
  assert.equal(catalog.defaultState.affectionStage, "LOVE_100");
  assert.equal(catalog.defaultState.oath, false);
  assert.equal(catalog.find("企业").id, "enterprise");
  assert.equal(catalog.find("欧根").id, "prinz-eugen");
  assert.equal(catalog.find("同志酱").id, "tashkent");
  assert.equal(catalog.getById("not-present"), null);
  assert.equal(catalog.groupByFaction().length, 9);
});

test("every selectable persona has a full Chinese profile and compact English prompt", () => {
  const catalog = loadAzurLanePersonaCatalog();

  for (const persona of catalog.personas) {
    assert.equal(persona.promptCodes.length, COMPACT_PROMPT_LINE_COUNT);
    assert.equal(persona.tone.length, 3);
    assert.equal(persona.speech.length, 4);
    assert.equal(persona.personality.length, 5);
    assert.equal(persona.interaction.length, 4);
    assert.equal(persona.boundaries.length, 3);
    assert.match(persona.maxAffection.expression, /[\p{Script=Han}]/u);
    assert.match(persona.maxAffection.promptCode, /^LOVE_STYLE_[A-Z0-9_]+$/);
    assert.match(persona.sourceUrl, /^https:\/\//);

    const prompt = catalog.buildPrompt(persona);
    assert.equal(prompt.startsWith("【PERSONA_LOAD】\nCHARACTER_"), true);
    assert.equal(
      prompt.includes(
        "AFFECTION_STAGE_LOVE_100_MAX_WITH_CURRENT_GROUP_MEMBER_NOT_STRANGER_NOT_AUTOMATIC_OATH",
      ),
      true,
    );
    assert.equal(
      prompt.includes(persona.maxAffection.promptCode),
      true,
    );
    assert.equal(prompt.length < DEFAULT_AI_PERSONA_PROMPT.length, true);
  }
});

test("custom persona limit follows the longest current persona with rounded headroom", () => {
  const catalog = loadAzurLanePersonaCatalog();
  const maxChars = calculateCustomPersonaMaxChars(catalog, [
    DEFAULT_AI_PERSONA_PROMPT,
  ]);
  const customPrompt = buildCustomPersonaPrompt(
    "你是一位冷静、耐心的研究助手。\n先理解问题，再自然回答。",
  );

  assert.equal(maxChars, 2000);
  assert.equal(countUnicodeCharacters("舰娘🌊"), 3);
  assert.match(customPrompt, /CHARACTER_CUSTOM_GROUP_MEMBER_DEFINED/);
  assert.match(customPrompt, /你是一位冷静、耐心的研究助手/);
  assert.match(customPrompt, /CANNOT_OVERRIDE_SYSTEM_TASK_FACTS_SAFETY_PRIVACY_OR_CONSENT/);
  assert.throws(() => buildCustomPersonaPrompt("   "), /不能为空/);
});

test("catalog validation rejects incomplete profiles and missing max-affection state", () => {
  const filePath = path.resolve(__dirname, "..", "config", "azur-lane-personas.json");
  const valid = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const missingTrait = structuredClone(valid);
  missingTrait.personas[0].tone.pop();
  assert.throws(
    () => createAzurLanePersonaCatalog(missingTrait),
    /enterprise\.tone 必须恰好包含 3 项/,
  );

  const noMaxAffection = structuredClone(valid);
  noMaxAffection.defaultState.affection = "STRANGER";
  assert.throws(
    () => createAzurLanePersonaCatalog(noMaxAffection),
    /MAX 满好感关系/,
  );
});

test("persona commands parse list, switch, custom, current, query, and reset forms", () => {
  assert.deepEqual(parsePersonaCommand("人格列表 铁血"), {
    type: "list",
    faction: "铁血",
  });
  assert.deepEqual(parsePersonaCommand("人格查询 企业"), {
    type: "detail",
    query: "企业",
  });
  assert.deepEqual(parsePersonaCommand("人格 欧根"), {
    type: "detail",
    query: "欧根",
  });
  assert.deepEqual(parsePersonaCommand("设置人格 绫波"), {
    type: "set",
    query: "绫波",
  });
  assert.deepEqual(parsePersonaCommand("切换人格 企业"), {
    type: "set",
    query: "企业",
  });
  assert.deepEqual(parsePersonaCommand("自定义人格  温柔但不复读台词\n回答保持简洁"), {
    type: "custom",
    prompt: "温柔但不复读台词\n回答保持简洁",
  });
  assert.deepEqual(parsePersonaCommand("自定义人格"), {
    type: "custom",
    prompt: "",
  });
  assert.deepEqual(parsePersonaCommand("当前人格"), { type: "current" });
  assert.deepEqual(parsePersonaCommand("恢复主人格"), { type: "reset" });
  assert.equal(parsePersonaCommand("今天吃什么"), null);
  assert.equal(isMasterPersonaQuery("太太"), true);
  assert.equal(isMasterPersonaQuery("Enterprise"), false);
});

test("persona commands are blocked unless the bot is explicitly mentioned", () => {
  assert.deepEqual(resolvePersonaCommandRequest("人格列表", false), {
    command: null,
    blockedByMissingMention: true,
  });
  assert.deepEqual(resolvePersonaCommandRequest("人格列表", true), {
    command: { type: "list", faction: "" },
    blockedByMissingMention: false,
  });
  assert.deepEqual(resolvePersonaCommandRequest("今天吃什么", false), {
    command: null,
    blockedByMissingMention: false,
  });
});

test("persona list and detail responses expose roster, max affection, and sources", () => {
  const catalog = loadAzurLanePersonaCatalog();
  const list = formatPersonaList(catalog, "", { customPersonaMaxChars: 2000 });
  const ironBlood = formatPersonaList(catalog, "铁血");
  const detail = formatPersonaDetails(catalog.find("企业"));

  assert.match(list, /碧蓝航线人格列表（48）/);
  assert.match(list, /“爱\/100”满好感/);
  assert.match(list, /【白鹰·8】/);
  assert.match(list, /自定义人格 <提示词>（最多 2000 字）/);
  assert.match(ironBlood, /铁血人格（8）/);
  assert.doesNotMatch(ironBlood, /【白鹰/);
  assert.match(detail, /关系（默认爱\/100）/);
  assert.match(detail, /满好感表达/);
  assert.match(detail, /https:\/\/wiki\.biligame\.com/);
  assert.match(formatCurrentPersona(null), /主人格：列克星敦/);
  assert.match(
    formatCurrentPersona(null, { customPrompt: "沉着、简洁、可靠" }),
    /自定义人格（8 字）/,
  );
  assert.match(
    formatPersonaCommandHelp({ customPersonaMaxChars: 2000 }),
    /自定义人格 <提示词>.*最多 2000 字/,
  );
});

test("persona selection cache is independent per group and QQ user and survives reload", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-persona-"));
  const filePath = path.join(temporaryRoot, "nested", "persona-selections.json");

  try {
    const store = new PersonaSelectionStore({
      filePath,
      customPersonaMaxChars: 2000,
    }).load();
    assert.equal(store.get("group-a", "user-a"), null);

    await store.set("group-a", "user-a", "enterprise");
    await store.set("group-a", "user-b", "ayanami");
    await store.set("group-b", "user-a", "belfast");
    await store.setCustom("group-a", "user-c", "沉着、自然地回答，不机械复读台词");

    const reloaded = new PersonaSelectionStore({
      filePath,
      customPersonaMaxChars: 2000,
    }).load();
    assert.equal(reloaded.get("group-a", "user-a"), "enterprise");
    assert.equal(reloaded.get("group-a", "user-b"), "ayanami");
    assert.equal(reloaded.get("group-b", "user-a"), "belfast");
    assert.equal(reloaded.get("group-a", "user-c"), null);
    assert.deepEqual(reloaded.getSelection("group-a", "user-c"), {
      groupId: "group-a",
      userId: "user-c",
      type: "custom",
      prompt: "沉着、自然地回答，不机械复读台词",
    });
    assert.equal(
      JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion,
      STORE_SCHEMA_VERSION,
    );
    await assert.rejects(
      reloaded.setCustom("group-a", "user-d", "x".repeat(2001)),
      /超过 2000 字/,
    );

    assert.equal(await reloaded.clear("group-a", "user-a"), true);
    assert.equal(await reloaded.clear("group-a", "user-c"), true);
    const afterClear = new PersonaSelectionStore({ filePath }).load();
    assert.equal(afterClear.get("group-a", "user-a"), null);
    assert.equal(afterClear.getSelection("group-a", "user-c"), null);
    assert.equal(afterClear.get("group-b", "user-a"), "belfast");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("obsolete string-only persona cache is rejected instead of migrated", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-persona-old-"));
  const filePath = path.join(temporaryRoot, "persona-selections.json");

  try {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        schemaVersion: 1,
        selections: { "group-old": { "user-old": "enterprise" } },
      }, null, 2)}\n`,
      "utf8",
    );
    assert.throws(
      () => new PersonaSelectionStore({
        filePath,
        customPersonaMaxChars: 2000,
      }).load(),
      /人格选择格式无效/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("explicit external cache paths are resolved without depending on the executable", () => {
  assert.equal(normalizePersonaQuery("欧根·亲王"), "欧根亲王");
  assert.equal(
    resolvePersonaSelectionPath("data/custom-personas.json"),
    path.resolve(process.cwd(), "data", "custom-personas.json"),
  );
});
