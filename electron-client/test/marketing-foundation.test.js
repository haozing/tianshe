const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeDataService } = require("../src/main/database");
const { normalizeNativeTimeoutMs } = require("../src/main/ipc/http");

test("marketing foundation persists shards and provides stable updated-desc prefix pagination", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-marketing-foundation-"));
  let service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const records = ["a", "b", "c"].map((suffix) => ({
    id: `marketing:run:${suffix}`,
    operationId: suffix,
    status: "succeeded",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  }));
  await service.request("records.putMany", { storeName: "remote_feature_records_v1", records });
  await service.request("records.put", { storeName: "remote_feature_records_v1", record: { id: "marketing:runner:not-a-run", status: "succeeded" } });

  const first = await service.request("records.queryByPrefix", {
    storeName: "remote_feature_records_v1",
    recordIdPrefix: "marketing:run:",
    order: "updated_desc",
    limit: 2
  });
  assert.deepEqual(first.items.map((item) => item.id), ["marketing:run:c", "marketing:run:b"]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(Object.keys(first.nextCursor).sort(), ["recordId", "updatedAt"]);

  const second = await service.request("records.queryByPrefix", {
    storeName: "remote_feature_records_v1",
    recordIdPrefix: "marketing:run:",
    order: "updated_desc",
    cursor: first.nextCursor,
    limit: 2
  });
  assert.deepEqual(second.items.map((item) => item.id), ["marketing:run:a"]);
  assert.equal(second.hasMore, false);

  const payload = "x".repeat(600 * 1024);
  const shards = Array.from({ length: 8 }, (_, index) => ({
    id: `marketing:failure-shard:large:${String(index).padStart(5, "0")}`,
    operationId: "large",
    items: [{ message: payload }],
    updatedAt: new Date().toISOString()
  }));
  await service.request("records.putMany", { storeName: "remote_feature_records_v1", records: shards, omitRecords: true });

  await service.request("records.put", { storeName: "operations", record: {
    id: "marketing-reconcile",
    operationId: "marketing-reconcile",
    taskType: "marketingTask",
    status: "reconciling",
    progress: 75,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } });
  const active = await service.request("records.queryOperations", { statuses: ["reconciling"], limit: 20 });
  assert.equal(active.length, 1);
  await service.request("records.cleanupOperations", { retentionDays: 1, maxTerminalRecords: 10 });
  assert.equal((await service.request("records.get", { storeName: "operations", id: "marketing-reconcile" })).status, "reconciling");

  await service.stop();
  service = new NativeDataService({ app: { getPath: () => userDataDir } });
  await service.start();
  const restored = await service.request("records.queryByPrefix", {
    storeName: "remote_feature_records_v1",
    recordIdPrefix: "marketing:failure-shard:large:",
    order: "updated_desc",
    limit: 20
  });
  assert.equal(restored.items.length, 8);
  assert.ok(restored.items.reduce((sum, shard) => sum + shard.items[0].message.length, 0) > 4 * 1024 * 1024);
});

test("native HTTP timeout uses the shared bounded contract", () => {
  assert.equal(normalizeNativeTimeoutMs(undefined), 30000);
  assert.equal(normalizeNativeTimeoutMs(100), 5000);
  assert.equal(normalizeNativeTimeoutMs(45000), 45000);
  assert.equal(normalizeNativeTimeoutMs(500000), 120000);
});

test("marketing smoke requires an explicitly selected profile and never selects production userData implicitly", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-smoke.js"), "utf8");
  assert.match(source, /CHIHU_SMOKE_USER_DATA_DIR is required for \$\{scenario\}/);
  assert.match(source, /configuredUserDataDir \|\| fs\.mkdtempSync/);
  assert.doesNotMatch(source, /process\.env\.APPDATA/);
  assert.match(source, /\["marketing-read", "marketing-write"\]\.includes\(scenario\).*CHIHU_LICENSE_BYPASS/);
});

test("development update checks skip both entry points when no explicit config exists", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "ipc", "updates.js"), "utf8");
  assert.equal((source.match(/const configured = configureUpdater\(updater, args\);/g) || []).length, 2);
  assert.equal((source.match(/if \(!configured\.ok\)/g) || []).length, 2);
});
