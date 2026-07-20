const { app } = require("electron");

function developmentShortcutsEnabled() {
  return app.isPackaged === false && process.env.CHIHU_EXPLICIT_TEST_MODE === "1" && process.env.CHIHU_ENABLE_DEVTOOLS === "1";
}

function addDevShortcuts(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const key = String(input.key || "").toLowerCase();
    if (input.control && input.shift && key === "n") {
      event.preventDefault();
      if (developmentShortcutsEnabled()) win.webContents.toggleDevTools();
    }

    if (input.control && key === "r") {
      win.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
  });
}

module.exports = { addDevShortcuts, developmentShortcutsEnabled };
