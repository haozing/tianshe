const assert = require("node:assert/strict");
const test = require("node:test");

const { safeJson } = require("../src/main/utils/redaction");

test("safeJson produces valid redacted JSON", () => {
  const serialized = safeJson({
    category: "diagnostics",
    event: "request-finished",
    token: "secret-token",
    nested: { authorization: "Bearer secret" }
  });
  const payload = JSON.parse(serialized);

  assert.equal(payload.category, "diagnostics");
  assert.equal(payload.event, "request-finished");
  assert.equal(payload.token, "[REDACTED]");
  assert.equal(payload.nested.authorization, "[REDACTED]");
});

test("safeJson keeps oversized log lines parseable and searchable", () => {
  const serialized = safeJson({
    category: "opportunity-pipeline",
    event: "submit-history-sync-complete",
    runId: "run-1",
    status: "complete",
    sourceHealth: Array.from({ length: 200 }, (_, index) => ({
      page: index + 1,
      message: "x".repeat(120)
    }))
  });
  const payload = JSON.parse(serialized);

  assert.ok(serialized.length <= 6000);
  assert.equal(payload.category, "opportunity-pipeline");
  assert.equal(payload.event, "submit-history-sync-complete");
  assert.equal(payload.runId, "run-1");
  assert.equal(payload.status, "complete");
  assert.ok(payload._logTruncation.originalLength > 6000);
  assert.equal(typeof payload._logTruncation.preview, "string");
});

test("safeJson handles circular payloads without corrupting the log line", () => {
  const payload = { category: "diagnostics", event: "circular" };
  payload.self = payload;

  const parsed = JSON.parse(safeJson(payload));
  assert.equal(parsed.self, "[Circular]");
});
