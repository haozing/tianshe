function lockBrowserWindowTitle(window, title) {
  const lockedTitle = String(title || "").trim();
  if (!lockedTitle) return false;

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!window.isDestroyed() && window.getTitle() !== lockedTitle) {
      window.setTitle(lockedTitle);
    }
  });
  window.setTitle(lockedTitle);
  return true;
}

module.exports = { lockBrowserWindowTitle };
