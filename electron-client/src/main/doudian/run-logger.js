const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { redactValue } = require("../utils/redaction");

const LOG_FILE = "doudian-store-events.jsonl";

function logFilePath() {
  return path.join(app.getPath("userData"), "logs", LOG_FILE);
}

function logStoreEvent(event, detail = {}) {
  try {
    const filePath = logFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...redactValue(detail)
      })}\n`,
      "utf8"
    );
  } catch {
    // Logging must never break the store import flow.
  }
}

module.exports = { LOG_FILE, logFilePath, logStoreEvent };
