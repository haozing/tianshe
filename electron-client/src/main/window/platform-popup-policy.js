const WEB_PROTOCOLS = new Set(["http:", "https:"]);

function platformPopupUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return WEB_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function popupWindowOptions({ parentSession, partition, title }) {
  return {
    width: 1280,
    height: 820,
    show: true,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    title: String(title || ""),
    backgroundColor: "#ffffff",
    webPreferences: {
      session: parentSession,
      ...(partition ? { partition } : {}),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      devTools: false,
      sandbox: true
    }
  };
}

function installPlatformPopupPolicy(parentWindow, options = {}) {
  if (!parentWindow || parentWindow.isDestroyed() || parentWindow.webContents.isDestroyed()) return false;
  const parentContents = parentWindow.webContents;
  if (parentContents.__chihuPlatformPopupPolicyInstalled) return false;
  parentContents.__chihuPlatformPopupPolicyInstalled = true;

  const partition = String(options.partition || "");
  const title = String(options.title || "");
  const logger = options.logger || console;
  const isBlockedUrl = typeof options.isBlockedUrl === "function" ? options.isBlockedUrl : () => false;
  const prepareChild = typeof options.prepareChild === "function" ? options.prepareChild : () => {};

  parentContents.setWindowOpenHandler((details = {}) => {
    const target = platformPopupUrl(details.url);
    if (!target || isBlockedUrl(target.toString())) {
      logger.warn?.(`[windows] denied platform popup url: ${String(details.url || "")}`);
      return { action: "deny" };
    }

    return {
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: popupWindowOptions({
        parentSession: parentContents.session,
        partition,
        title
      })
    };
  });

  parentContents.on("did-create-window", (childWindow, details = {}) => {
    const target = platformPopupUrl(details.url);
    const sameSession = childWindow && !childWindow.isDestroyed() &&
      !childWindow.webContents.isDestroyed() &&
      childWindow.webContents.session === parentContents.session;

    if (!sameSession) {
      logger.error?.(`[windows] platform popup session mismatch; falling back to opener (partition=${partition}, url=${String(details.url || "")})`);
      if (childWindow && !childWindow.isDestroyed()) childWindow.destroy();
      if (target && !parentWindow.isDestroyed() && !parentContents.isDestroyed()) {
        queueMicrotask(() => {
          if (parentWindow.isDestroyed() || parentContents.isDestroyed()) return;
          parentContents.loadURL(target.toString()).catch((error) => {
            logger.warn?.(`[windows] platform popup fallback failed: ${error.message}`);
          });
        });
      }
      return;
    }

    childWindow.setMenu(null);
    const parentUserAgent = parentContents.getUserAgent?.();
    if (parentUserAgent) childWindow.webContents.setUserAgent(parentUserAgent);
    prepareChild(childWindow, { ...details, url: target.toString() });
    installPlatformPopupPolicy(childWindow, options);
    logger.info?.(`[windows] platform popup inherited store session (partition=${partition}, url=${target.toString()})`);
  });

  return true;
}

module.exports = {
  installPlatformPopupPolicy,
  platformPopupUrl,
  popupWindowOptions
};
