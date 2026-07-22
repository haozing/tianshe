const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { lockBrowserWindowTitle } = require("../src/main/window/window-title");

const root = path.resolve(__dirname, "../..");

test("store windows request a locked native title using the store name", async () => {
  const [storeGroupsSource, nativeTypesSource, windowsSource] = await Promise.all([
    readFile(path.join(root, "remote-web/client-shell/src/domain/doudian/storeGroups.ts"), "utf8"),
    readFile(path.join(root, "remote-web/client-shell/src/native/types.ts"), "utf8"),
    readFile(path.join(root, "electron-client/src/main/ipc/windows.js"), "utf8")
  ]);

  assert.match(storeGroupsSource, /title: options\.title \|\| store\.shopName \|\| store\.shopId,\s*lockTitle: true/);
  assert.match(nativeTypesSource, /lockTitle\?: boolean/);
  assert.match(windowsSource, /if \(args\.lockTitle\) lockBrowserWindowTitle\(child, args\.title\)/);
});

test("a platform page title update cannot replace a locked store title", () => {
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.title = "";
    }

    isDestroyed() {
      return this.destroyed;
    }

    getTitle() {
      return this.title;
    }

    setTitle(title) {
      this.title = title;
    }
  }

  const window = new FakeWindow();
  assert.equal(lockBrowserWindowTitle(window, "康鸟鹭专卖店"), true);
  assert.equal(window.getTitle(), "康鸟鹭专卖店");

  let prevented = false;
  window.title = "首页";
  window.emit("page-title-updated", {
    preventDefault() {
      prevented = true;
    }
  }, "首页");

  assert.equal(prevented, true);
  assert.equal(window.getTitle(), "康鸟鹭专卖店");
});
