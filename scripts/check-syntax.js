const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const directory = path.resolve(__dirname, "../src");
for (const file of fs.readdirSync(directory).filter(file => file.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(directory, file)], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
