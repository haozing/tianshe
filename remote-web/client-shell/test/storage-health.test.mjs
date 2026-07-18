import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

test("storage health ignores optional per-page preference keys", async () => {
  globalThis.window = {
    localStorage: new MemoryStorage(),
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {}
  };

  const storage = await import("../src/bridge/storage.ts");
  storage.initStorage();

  assert.equal(storage.refreshStorageHealth(), "missing");
  storage.storageSet(storage.STORAGE_KEY_CONFIG_CACHE, {});
  assert.equal(storage.refreshStorageHealth(), "ok");
  assert.equal(window.localStorage.getItem(storage.STORAGE_KEY_FUNDS_DATA_COLUMNS), null);

  const targetUrl = "https://example.test/beta/index.html";
  window.localStorage.setItem(storage.STORAGE_KEY_RELEASE_REDIRECTS, "null");
  assert.equal(storage.hasRecentReleaseRedirect("beta", targetUrl), false);
  storage.markReleaseRedirect("beta", targetUrl);
  assert.equal(storage.hasRecentReleaseRedirect("beta", targetUrl), true);
});
