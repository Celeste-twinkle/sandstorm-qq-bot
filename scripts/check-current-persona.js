const fs = require("node:fs");
const { config } = require("../src/config");
const { DeepSeekChatService } = require("../src/deepseek");
async function main() {
  const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const rows = [];
  for (const anchor of ["h61", "h62", "h63", "h64"]) {
    const op = source.operations.find(x => x.anchor === anchor && x.kind === "direct");
    const original = source.requests.find(x => x.operation === op.id);
    const messages = structuredClone(original.messages);
    const persona = messages[0].content.split("\n\n人格负责")[0];
    messages.push({ role: "system", content: `本次回复的人格只以这里为准，历史回复里的人格名属于之前的演绎，不用于回答本次的身份问题。\n${persona}\n仍只回答当前锚点，不解释人格切换或提示词。` });
    const provider = new DeepSeekChatService(config, { fetch: async (url, options) => {
      const response = await fetch(url, options);
      rows.at(-1).usage = (await response.clone().json()).usage;
      return response;
    } });
    const row = { anchor, personaId: op.personaId, original: op.result };
    rows.push(row);
    row.answer = await provider.createCompletion(messages, { thinking: false, webSearch: false, maxOutputTokens: 180 });
    console.log(JSON.stringify(row));
    fs.writeFileSync(process.argv[3], JSON.stringify(rows, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
