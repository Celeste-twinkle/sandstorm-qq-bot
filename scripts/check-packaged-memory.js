// Offline smoke test: no real QQ client, model key, or embedding connection.
// Retains a small temporary diagnostic directory; never deletes user data.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

async function main() {
  const executable = path.resolve(__dirname, "../dist/sandstorm-qq-bot.exe");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-memory-exe-smoke-"));
  const child = spawn(executable, [], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEEPSEEK_API_KEY: "", LOCAL_QWEN_API_KEY: "", LOCAL_QWEN_ENABLED: "false",
      CHAT_ENABLED: "false", AMBIENT_CHAT_ENABLED: "false", GROUP_CHAT_LEARNING_ENABLED: "false",
      WEB_SEARCH_AUTO_ENABLED: "false", MEMORY_EMBEDDING_URL: "", MEMORY_ENABLED: "true", STICKER_ENABLED: "true",
      MEMORY_STATE_DIR: path.join(directory, "memory"), GROUP_CHAT_LEARNING_DIR: path.join(directory, "learning"),
      ACCESS_TOKEN: randomUUID(), PORT: "0" },
  });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Packaged bot startup timed out")), 15000);
      const done = operation => value => { clearTimeout(timeout); operation(value); };
      child.once("error", done(reject));
      child.once("exit", done(() => reject(new Error("Packaged bot exited before startup"))));
      child.stdout.on("data", chunk => {
        stdout = (stdout + chunk).slice(-12000);
        if (stdout.includes("reverse websocket listening")) done(resolve)();
      });
    });
    if (stderr.includes("archive unavailable")) throw new Error("Packaged SQLite archive unavailable");
    const database = new DatabaseSync(path.join(directory, "memory", "messages.db"), { readOnly: true });
    let tables;
    try {
      tables = database.prepare("SELECT name FROM sqlite_master WHERE name IN (?,?,?,?)")
        .all("messages", "msg_fts", "msg_vec", "memory_events").map(row => row.name);
      if (tables.length !== 4) throw new Error("Packaged SQLite schema incomplete");
    } finally { database.close(); }
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, tables, stdout, stderr }, null, 2));
    console.log("Windows EXE startup and all 4 SQLite archive/index tables verified; no QQ or model service connected.");
    console.log(`Diagnostics: ${directory}`);
  } finally {
    // Terminate only the child process this script created, using its handle.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 3000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
