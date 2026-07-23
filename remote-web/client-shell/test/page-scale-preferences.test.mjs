import assert from "node:assert/strict";
import test from "node:test";
import { applyAndPersistPageScale } from "../src/bridge/pageScale.ts";
import { defaultPreferences, getPreferences, normalizePreferences, savePreferences } from "../src/bridge/storage.ts";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

test("page scale preference defaults to standard and accepts only supported factors", () => {
  assert.equal(defaultPreferences.pageScale, 1);
  assert.equal(normalizePreferences({}).pageScale, 1);
  assert.equal(normalizePreferences({ pageScale: 1 }).pageScale, 1);
  assert.equal(normalizePreferences({ pageScale: 1.1 }).pageScale, 1.1);
  assert.equal(normalizePreferences({ pageScale: 1.25 }).pageScale, 1.25);

  for (const value of ["1.1", 0, 1.2, 2, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizePreferences({ pageScale: value }).pageScale, 1, String(value));
  }
});

test("page scale is persisted in the existing preferences record", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: new MemoryStorage(),
    dispatchEvent() {}
  };
  try {
    assert.equal(savePreferences({ pageScale: 1.25 }).pageScale, 1.25);
    assert.equal(getPreferences().pageScale, 1.25);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("page scale saves only after native apply and restores native state when saving fails", async () => {
  const calls = [];
  const saved = await applyAndPersistPageScale({
    scale: 1.25,
    previousScale: 1.1,
    applyZoom: async (factor) => {
      calls.push(factor);
      return { ok: true, factor };
    },
    savePreferences: () => {
      throw new Error("storage full");
    }
  });

  assert.deepEqual(calls, [1.25, 1.1]);
  assert.equal(saved.result.ok, false);
  assert.equal(saved.result.factor, 1.1);
  assert.match(saved.result.message || "", /已恢复原设置/);
});

test("page scale does not persist when native apply fails", async () => {
  let saveCalls = 0;
  const result = await applyAndPersistPageScale({
    scale: 1.25,
    previousScale: 1,
    applyZoom: async () => ({ ok: false, factor: 1.25, message: "native unavailable" }),
    savePreferences: () => {
      saveCalls += 1;
      return { ...defaultPreferences, pageScale: 1.25 };
    }
  });

  assert.equal(saveCalls, 0);
  assert.deepEqual(result.result, { ok: false, factor: 1, message: "native unavailable" });
});
