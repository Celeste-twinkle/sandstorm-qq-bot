const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function resolveStateDir(configured = "") {
  const base = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
  return path.resolve(base, configured || "data/agent-memory");
}

// A damaged file is never replaced by an empty state. Runtime conversations can
// continue, but an operator must restore the file before persistence resumes.
class PersistentState {
  constructor(file, initial, validate, logger = console) {
    this.file = file;
    this.readOnly = false;
    this.logger = logger;
    this.value = structuredClone(initial);
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      validate(value);
      this.value = value;
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.readOnly = true;
        logger.error(`[memory] cannot read ${path.basename(file)}; READ ONLY, original file preserved`);
      }
    }
  }

  save() {
    if (this.readOnly) return false;
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.value) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.file);
      return true;
    } catch (error) {
      this.logger.error(`[memory] cannot save ${path.basename(this.file)}; previous file preserved`);
      return false;
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}

const clip = (value, max) => Array.from(String(value ?? "")).slice(0, max).join("");
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function conversationKey(value) {
  const key = String(value || "");
  if (!/^(?:group|private):\d{1,20}$/.test(key)) throw new Error("Invalid conversation key");
  return key;
}

module.exports = { PersistentState, resolveStateDir, conversationKey, clip, isObject };
