// Live decision-only check: does recent conversational interest affect choice?
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../src/config");
const { AiChatService } = require("../src/ai");

const cases = [
  { id: "interested", previous: "键盘这个我爱听，说说你新换的配色？", latest: "蓝色外壳配白色键帽，桌面看着清爽多了。" },
  { id: "listening", previous: "我先听你们聊，暂时没什么想说的。", latest: "蓝色外壳配白色键帽，桌面看着清爽多了。" },
  { id: "already-chatted", previous: "键盘的话题我刚说了好几句了，接下来听你们聊。", latest: "蓝色外壳配白色键帽，桌面看着清爽多了。" },
  { id: "ordinary-update", previous: null, latest: "刚到家，把外套挂起来了。" },
];
async function main() {
  const output = path.resolve(process.argv[2] || "reports/ambient-mood-final-20261014/mood-context.json");
  assert.ok(!fs.existsSync(output));
  const report = { startedAt: new Date().toISOString(), method: "Synthetic conversations; real JSON participation decisions only. No fixed expected reply proportion and no QQ connection.",
    temperature: config.ambientChatJudgeTemperature, thinking: false, results: [] };
  for (const item of cases) {
    const captures = [];
    const service = new AiChatService({ ...config, aiPrimaryProvider: "deepseek", localQwenEnabled: false }, {
      fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.thinking.type, "disabled");
        assert.equal(body.tools, undefined);
        const response = await fetch(url, options);
        const payload = await response.clone().json();
        captures.push({ status: response.status, usage: payload.usage, answer: payload.choices?.[0]?.message?.content });
        return response;
      },
    });
    const context = [
      ...(item.previous ? [{ role: "assistant", senderName: "Bot", text: item.previous, timestamp: Date.now() - 5000, messageId: "bot" }] : []),
      { role: "user", senderName: "群友", userId: "synthetic-member", text: item.latest, timestamp: Date.now(), messageId: "member" },
    ];
    const decision = await service.shouldAmbientReply(context, { ambientMode: "instant" });
    report.results.push({ ...item, decision, captures });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ id: item.id, decision }));
  }
}
main().catch(error => { console.error(String(error.message).split(config.deepseekApiKey).join("[REDACTED]")); process.exitCode = 1; });
