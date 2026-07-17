const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeDataService } = require("../src/main/database");

test("a timed out request restarts the worker and drains queued requests", async (t) => {
  const service = new NativeDataService({
    app: { getPath: () => path.join(os.tmpdir(), `chihu-database-timeout-${process.pid}`) },
    workerPath: path.join(__dirname, "fixtures", "hanging-database-worker.js")
  });
  t.after(() => service.stop());

  await service.start();
  const timedOut = service.request("hang", {}, { timeoutMs: 1000 });
  const queued = service.request("echo", { value: "recovered" }, { timeoutMs: 5000 });

  await assert.rejects(timedOut, (error) => error?.code === "NATIVE_DATA_TIMEOUT");
  assert.equal(await queued, "recovered");
});
