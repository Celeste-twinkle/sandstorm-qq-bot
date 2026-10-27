const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { StickerLibrary, assertStickerUrl, stickerSegments } = require("../src/sticker-library");

const quiet = { error() {}, warn() {}, info() {} };
const png = marker => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(marker)]);
const analysis = overrides => ({ transcription: "好耶", uncertain_text: [], description: "猫猫开心举手庆祝", emotions: ["开心"],
  usage: ["成功时庆祝"], avoid: ["难过或失败时嘲讽"], confidence: 0.96, model: "vision-test", ...overrides });
const message = (id, overrides = {}) => ({ message_id: id, user_id: "11", self_id: "99", time: 100,
  message: [{ type: "image", data: { sub_type: 1, url: `https://multimedia.nt.qq.com/${id}` } }], ...overrides });
const context = [{ messageId: "h1", userId: "11", role: "user", text: "终于打过了，赢了！", timestamp: 1 }];

function fixture(t, config = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-sticker-test-"));
  const resolved = fs.realpathSync(directory), resources = [];
  const settings = { memoryStateDir: directory, stickerEnabled: true, ...config };
  const deps = { logger: quiet, download: async source => png(new URL(source).pathname), analyze: async () => analysis(), ...options };
  const open = (overrides = {}) => { const library = new StickerLibrary({ ...settings, ...overrides }, deps); resources.push(library); return library; };
  const library = open();
  t.after(async () => {
    for (const resource of resources) await resource.close();
    assert.equal(fs.realpathSync(directory), resolved);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("sandstorm-sticker-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { library, directory, open };
}
const collect = async (library, group, id) => { library.observe(group, message(id), context); await library.flush(); };

test("collection persists an image/OCR/context pair by SHA256 and reuses it after restart", async t => {
  let reads = 0;
  const { library, open, directory } = fixture(t, {}, { analyze: async () => { reads++; return analysis(); } });
  await collect(library, "1", "a");
  const item = Object.values(library.state("1").value.items)[0];
  const bytes = fs.readFileSync(path.join(directory, "stickers", "assets", item.image.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(item.id, digest); assert.equal(item.ocr.imageSha256, digest);
  assert.equal(item.ocr.transcription, "好耶");
  assert.equal(item.ocr.model, "vision-test");
  assert.equal(item.observations[0].context[0].text, "终于打过了，赢了！");
  assert.deepEqual(item.semantics.avoid, ["难过或失败时嘲讽"]);
  const restored = open();
  assert.equal(restored.status("1").recognized, 1);
  await collect(restored, "1", "a");
  assert.equal(reads, 1);
  assert.equal(restored.status("1").total, 1);
});

test("ordinary images, forwarded pictures and bot echoes are not harvested automatically", async t => {
  const { library } = fixture(t);
  const ordinary = message("normal", { message: [{ type: "image", data: { url: "https://qpic.cn/a" } }] });
  assert.equal(library.observe("1", ordinary, context), 0);
  assert.equal(library.observe("1", message("self", { user_id: "99" }), context), 0);
  assert.equal(library.observe("1", message("sent", { post_type: "message_sent" }), context), 0);
  assert.equal(library.observe("1", ordinary, context, true), 1);
  await library.flush();
  assert.equal(library.status("1").total, 1);
  assert.equal(stickerSegments({ raw_message: "[CQ:image,sub_type=1,url=https://qpic.cn/a?x=1&amp;y=2]" })[0].data.url, "https://qpic.cn/a?x=1&y=2");
});

test("per-group capacity replaces a stale low value pair and deletes its unused image atomically", async t => {
  let now = 1000000;
  const { library, directory } = fixture(t, { stickerMaxPerGroup: 2 }, { now: () => now });
  await collect(library, "1", "a");
  const first = Object.values(library.state("1").value.items)[0];
  now += 86400000; await collect(library, "1", "b");
  now += 86400000; await collect(library, "1", "c");
  const items = Object.values(library.state("1").value.items);
  assert.equal(items.length, 2);
  assert.equal(items.some(item => item.id === first.id), false);
  assert.equal(fs.existsSync(path.join(directory, "stickers", "assets", first.image.file)), false);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "stickers", "1.json")));
  assert.equal(Object.hasOwn(stored.items, first.id), false);
});

test("global capacity keeps frequent valid pairs and shared assets until their last reference is gone", async t => {
  let now = 1000000;
  const { library, directory } = fixture(t, { stickerMaxTotal: 2 }, { now: () => now });
  await collect(library, "1", "same");
  await collect(library, "2", "same");
  const shared = Object.values(library.state("1").value.items)[0];
  assert.equal(library.storageUsage().pairs, 2); assert.equal(library.storageUsage().assets, 1);
  library.markSent("2", shared.id);
  now += 86400000;
  await collect(library, "3", "new");
  assert.equal(library.storageUsage().pairs, 2);
  assert.equal(library.state("2").value.items[shared.id].ocr.status, "ready");
  assert.equal(fs.existsSync(path.join(directory, "stickers", "assets", shared.image.file)), true);
  library.reset("2");
  assert.equal(fs.existsSync(path.join(directory, "stickers", "assets", shared.image.file)), false);
});

test("restarting with collection disabled still protects other groups' shared images during explicit reset", async t => {
  const { library, open, directory } = fixture(t);
  await collect(library, "1", "same"); await collect(library, "2", "same");
  const item = Object.values(library.state("1").value.items)[0];
  const disabled = open({ stickerEnabled: false });
  disabled.reset("1");
  assert.equal(fs.existsSync(path.join(directory, "stickers", "assets", item.image.file)), true);
  assert.equal(disabled.status("2").total, 1);
});

test("restart with lower count and byte limits enforces them across all saved groups", async t => {
  let now = 1000000;
  const { library, open } = fixture(t, {}, { now: () => now });
  await collect(library, "1", "a"); now += 86400000;
  await collect(library, "1", "b"); now += 86400000;
  await collect(library, "2", "c");
  const reduced = open({ stickerMaxPerGroup: 1, stickerMaxTotal: 1 });
  assert.equal(reduced.storageUsage().pairs, 1);
  assert.ok(reduced.status("1").total <= 1);
  const bytesReduced = open({ stickerMaxStorageBytes: 1024 });
  assert.ok(bytesReduced.storageUsage().bytes <= 1024);
});

test("a failed metadata commit restores the previous pair and leaves no unreferenced image", async t => {
  const { library, directory } = fixture(t);
  await collect(library, "1", "a");
  const first = structuredClone(library.state("1").value.items);
  const save = library.state("1").save;
  library.state("1").save = () => false;
  await collect(library, "1", "b");
  assert.deepEqual(library.state("1").value.items, first);
  assert.equal(fs.readdirSync(path.join(directory, "stickers", "assets")).length, 1);
  library.state("1").save = save;
});

test("the storage budget includes image bytes and OCR metadata; oversized new pairs are rejected", async t => {
  const { library } = fixture(t, { stickerMaxStorageBytes: 1024 }, { download: async () => png("x".repeat(2000)) });
  await collect(library, "1", "large");
  assert.equal(library.status("1").total, 0);
  assert.ok(library.storageUsage().bytes <= 1024);
});

test("low confidence or failed OCR cannot displace useful images and never triggers selection", async t => {
  let fail = false, choices = 0;
  const { library } = fixture(t, { stickerMaxPerGroup: 1 }, {
    analyze: async () => { if (fail) throw new Error("unavailable"); return analysis(); },
    choose: async () => { choices++; return { sticker_id: null, context_match: false, confidence: 1 }; },
  });
  await collect(library, "1", "good"); fail = true;
  await collect(library, "1", "bad");
  assert.equal(library.status("1").recognized, 1); assert.equal(library.status("1").failed, 0);
  await collect(library, "2", "bad");
  assert.equal(library.status("2").failed, 1);
  assert.equal(await library.select("2", context, "好耶"), null);
  assert.equal(choices, 0);
});

test("metadata refresh is versioned, retains successful OCR on failure and updates sightings", async t => {
  let now = 1000000, fail = false, reads = 0;
  const { library } = fixture(t, { stickerOcrRefreshDays: 1 }, { now: () => now,
    download: async () => png("same"), analyze: async () => { reads++; if (fail) throw new Error("down"); return analysis({ transcription: `好耶${reads}` }); } });
  await collect(library, "1", "a");
  now += 2 * 86400000;
  await collect(library, "1", "b");
  let item = Object.values(library.state("1").value.items)[0];
  assert.equal(item.metadataRevision, 2); assert.equal(item.ocr.transcription, "好耶2");
  assert.equal(item.observationCount, 2);
  fail = true; now += 2 * 86400000;
  await collect(library, "1", "c");
  item = Object.values(library.state("1").value.items)[0];
  assert.equal(item.metadataRevision, 2); assert.equal(item.ocr.status, "ready");
  assert.equal(item.ocr.transcription, "好耶2"); assert.equal(item.observationCount, 3);
});

test("idle and failed pairs expire, startup enforces reduced limits and cleans orphan assets", async t => {
  let now = 1000000;
  const { library, directory, open } = fixture(t, { stickerRetentionDays: 7 }, { now: () => now });
  await collect(library, "1", "old");
  const orphan = "a".repeat(64) + ".png";
  fs.writeFileSync(path.join(directory, "stickers", "assets", orphan), png("orphan"));
  now += 8 * 86400000;
  const restored = open();
  assert.equal(restored.status("1").total, 0);
  assert.deepEqual(fs.readdirSync(path.join(directory, "stickers", "assets")), []);
});

test("semantic selection receives OCR, visual meaning, avoid rules and original usage contexts", async t => {
  let captured;
  const { library } = fixture(t, {}, { choose: async (candidates, history, draft) => {
    captured = { candidates, history, draft };
    return { sticker_id: candidates[0].id, context_match: true, confidence: 0.95 };
  } });
  await collect(library, "1", "a");
  const selected = await library.select("1", context, "好耶终于赢了", { getContext: () => context });
  assert.ok(selected);
  assert.equal(selected.segment.type, "image");
  assert.match(selected.segment.data.file, /^file:/);
  assert.equal(captured.candidates[0].ocr, "好耶");
  assert.equal(captured.candidates[0].description, "猫猫开心举手庆祝");
  assert.deepEqual(captured.candidates[0].originalContexts, [["终于打过了，赢了！"]]);
  library.markSent("1", selected.id); selected.release();
  assert.equal(await library.select("1", context, "再发一张"), null);
});

test("topic changes during selection, stale ids and pixel/metadata mismatches prevent sending", async t => {
  let update = () => {}, decision;
  const { library, directory } = fixture(t, {}, { choose: async candidates => {
    update(); return decision || { sticker_id: candidates[0].id, context_match: true, confidence: 1 };
  } });
  await collect(library, "1", "a");
  let current = context;
  update = () => { current = [...context, { messageId: "new", role: "user", text: "认真问个事", timestamp: 2 }]; };
  assert.equal(await library.select("1", context, "好耶", { getContext: () => current }), null);
  update = () => {}; decision = { sticker_id: "fabricated", context_match: true, confidence: 1 };
  assert.equal(await library.select("1", context, "好耶"), null);
  decision = null;
  const item = Object.values(library.state("1").value.items)[0];
  fs.writeFileSync(path.join(directory, "stickers", "assets", item.image.file), png("changed"));
  assert.equal(await library.select("1", context, "好耶"), null);
});

test("in-flight OCR is discarded after reset and corrupted metadata never causes image deletion", async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { library, directory, open } = fixture(t, {}, { analyze: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  library.observe("1", message("a"), context);
  await ready; library.reset("1"); release(analysis()); await library.flush();
  assert.equal(library.status("1").total, 0);
  const assets = path.join(directory, "stickers", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const name = "b".repeat(64) + ".png";
  fs.writeFileSync(path.join(assets, name), png("retain"));
  fs.writeFileSync(path.join(directory, "stickers", "1.json"), "broken");
  const restored = open();
  assert.equal(restored.status("1").readOnly, true);
  assert.equal(restored.observe("2", message("b"), context), 0);
  assert.equal(fs.existsSync(path.join(assets, name)), true);
  assert.equal(fs.readFileSync(path.join(directory, "stickers", "1.json"), "utf8"), "broken");
});

test("downloads accept only public QQ CDN HTTPS URLs and native market stickers preserve their data", async t => {
  for (const url of ["file:///C:/secrets", "http://qpic.cn/a", "https://127.0.0.1/a", "https://qpic.cn.evil.example/a", "https://qpic.cn:8443/a", "https://user:pass@qq.com/a"]) {
    assert.throws(() => assertStickerUrl(url));
  }
  assert.equal(assertStickerUrl("https://multimedia.nt.qq.com/a").hostname, "multimedia.nt.qq.com");
  const { library } = fixture(t, {}, { choose: async candidates => ({ sticker_id: candidates[0].id, context_match: true, confidence: 1 }) });
  library.observe("1", message("mface", { message: [{ type: "mface", data: {
    emoji_id: "a".repeat(32), emoji_package_id: "pack1", key: "native-key", summary: "[好耶]" } }] }), context);
  await library.flush();
  const selected = await library.select("1", context, "好耶");
  assert.equal(selected.segment.type, "mface");
  assert.equal(selected.segment.data.key, "native-key"); selected.release();
});
