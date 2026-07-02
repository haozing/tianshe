function addDevShortcuts(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const key = String(input.key || "").toLowerCase();
    if (input.control && input.shift && key === "n") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }

    if (input.control && key === "r") {
      win.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
  });
}

module.exports = { addDevShortcuts };

