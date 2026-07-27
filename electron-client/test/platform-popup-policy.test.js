const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  installPlatformPopupPolicy,
  platformPopupUrl
} = require("../src/main/window/platform-popup-policy");

class FakeContents extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.destroyed = false;
    this.handler = null;
    this.loadedUrls = [];
    this.userAgent = "Chihu-Test-UA";
  }

  isDestroyed() {
    return this.destroyed;
  }

  setWindowOpenHandler(handler) {
    this.handler = handler;
  }

  getUserAgent() {
    return this.userAgent;
  }

  setUserAgent(value) {
    this.userAgent = value;
  }

  async loadURL(url) {
    this.loadedUrls.push(url);
  }
}

class FakeWindow {
  constructor(session) {
    this.webContents = new FakeContents(session);
    this.destroyed = false;
    this.menu = undefined;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }

  setMenu(value) {
    this.menu = value;
  }
}

const quietLogger = { info() {}, warn() {}, error() {} };

test("platform popups explicitly reuse the opener store session", () => {
  const storeSession = { id: "store-session" };
  const parent = new FakeWindow(storeSession);
  assert.equal(installPlatformPopupPolicy(parent, {
    partition: "persist:chihu_doudian_shop_10001",
    title: "Store 10001",
    logger: quietLogger
  }), true);

  const decision = parent.webContents.handler({ url: "https://fxg.jinritemai.com/ffa/g/create/edit?id=1" });
  assert.equal(decision.action, "allow");
  assert.equal(decision.outlivesOpener, false);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.session, storeSession);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.partition, "persist:chihu_doudian_shop_10001");
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.sandbox, true);
});

test("platform popup policy rejects non-web targets", () => {
  const parent = new FakeWindow({ id: "store-session" });
  installPlatformPopupPolicy(parent, { logger: quietLogger });

  assert.equal(parent.webContents.handler({ url: "file:///C:/Windows/System32/calc.exe" }).action, "deny");
  assert.equal(parent.webContents.handler({ url: "javascript:alert(1)" }).action, "deny");
  assert.equal(platformPopupUrl("https://fxg.jinritemai.com/").hostname, "fxg.jinritemai.com");
});

test("created platform popups keep the session policy recursively", () => {
  const storeSession = { id: "store-session" };
  const parent = new FakeWindow(storeSession);
  const child = new FakeWindow(storeSession);
  const prepared = [];
  installPlatformPopupPolicy(parent, {
    partition: "persist:chihu_doudian_shop_10001",
    logger: quietLogger,
    prepareChild(window, details) {
      prepared.push({ window, details });
    }
  });

  parent.webContents.emit("did-create-window", child, {
    url: "https://fxg.jinritemai.com/ffa/g/create/edit?id=1"
  });

  assert.equal(child.menu, null);
  assert.equal(child.webContents.userAgent, parent.webContents.userAgent);
  assert.equal(typeof child.webContents.handler, "function");
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].details.url, "https://fxg.jinritemai.com/ffa/g/create/edit?id=1");
});

test("a popup with the wrong session is closed and falls back to the opener", async () => {
  const parent = new FakeWindow({ id: "store-session" });
  const child = new FakeWindow({ id: "default-session" });
  installPlatformPopupPolicy(parent, {
    partition: "persist:chihu_doudian_shop_10001",
    logger: quietLogger
  });

  parent.webContents.emit("did-create-window", child, {
    url: "https://fxg.jinritemai.com/ffa/g/create/edit?id=1"
  });
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.equal(child.destroyed, true);
  assert.deepEqual(parent.webContents.loadedUrls, ["https://fxg.jinritemai.com/ffa/g/create/edit?id=1"]);
});
