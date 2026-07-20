const principals = new Map();
const revokeListeners = new Set();

function principalError(code, message) {
  const error = new Error(message || code);
  error.name = "PrincipalError";
  error.code = code;
  return error;
}

function normalizedUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function urlMatchesPrincipal(principal, value) {
  const url = normalizedUrl(value);
  if (!url) return false;
  if (url.protocol !== principal.expectedProtocol || url.host !== principal.expectedHost) return false;
  if (url.origin !== principal.expectedOrigin) return false;
  if (url.pathname !== principal.expectedPathPrefix) return false;
  if (principal.releaseId && url.protocol === "chihu-release:") {
    const releaseId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
    if (releaseId !== principal.releaseId) return false;
  }
  const runnerFlag = url.searchParams.get("runner") === "1";
  if (principal.role === "runner" && !runnerFlag) return false;
  if (principal.role === "main" && runnerFlag) return false;
  return true;
}

function revokeWebContentsPrincipal(webContentsOrId, reason = "revoked") {
  const id = typeof webContentsOrId === "number" ? webContentsOrId : webContentsOrId?.id;
  const principal = principals.get(id);
  if (!principal) return null;
  principals.delete(id);
  const revoked = { ...principal, revoked: true, revokeReason: reason };
  for (const listener of revokeListeners) {
    try {
      listener(revoked);
    } catch {}
  }
  return revoked;
}

function registerWebContentsPrincipal(contents, options) {
  if (!contents || contents.isDestroyed()) throw principalError("PRINCIPAL_INVALID", "webContents is unavailable");
  const expected = normalizedUrl(options.expectedUrl);
  if (!expected) throw principalError("PRINCIPAL_INVALID", "principal expected URL is invalid");
  const previous = principals.get(contents.id);
  const principal = {
    role: options.role,
    webContentsId: contents.id,
    ownerOperationId: options.ownerOperationId || "",
    releaseId: options.releaseId || "",
    expectedProtocol: expected.protocol,
    expectedHost: expected.host,
    expectedOrigin: expected.origin,
    expectedPathPrefix: options.expectedPathPrefix || expected.pathname,
    navigationEpoch: Number(previous?.navigationEpoch || 0) + 1,
    allowedPlatformOrigins: new Set(options.allowedPlatformOrigins || [])
  };
  principals.set(contents.id, principal);

  if (!contents.__chihuPrincipalGuardInstalled) {
    contents.__chihuPrincipalGuardInstalled = true;
    const guardNavigation = (event, url, isMainFrame = true) => {
      const current = principals.get(contents.id);
      if (!current || !isMainFrame) return;
      if (current.role === "platform-child") {
        const target = normalizedUrl(url);
        if (target && current.allowedPlatformOrigins.has(target.origin)) return;
      } else if (urlMatchesPrincipal(current, url)) {
        return;
      }
      event.preventDefault();
      revokeWebContentsPrincipal(contents.id, "navigation_boundary");
    };
    contents.on("will-navigate", (event, url) => guardNavigation(event, url, true));
    contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => guardNavigation(event, url, isMainFrame !== false));
    try {
      contents.on("will-frame-navigate", (event, url, _isInPlace, isMainFrame) => guardNavigation(event, url, isMainFrame !== false));
    } catch {}
    contents.once("destroyed", () => revokeWebContentsPrincipal(contents.id, "destroyed"));
  }
  return principal;
}

function getWebContentsPrincipal(webContentsOrId) {
  const id = typeof webContentsOrId === "number" ? webContentsOrId : webContentsOrId?.id;
  return principals.get(id) || null;
}

function isMainFrameEvent(event) {
  if (!event?.sender || event.sender.isDestroyed()) return false;
  if (event.senderFrame && event.sender.mainFrame) return event.senderFrame === event.sender.mainFrame;
  return event.frameId === undefined || event.frameId === 0;
}

function requireWebContentsPrincipal(event, allowedRoles) {
  if (!isMainFrameEvent(event)) throw principalError("IPC_FRAME_DENIED", "privileged IPC requires the main frame");
  const principal = getWebContentsPrincipal(event.sender);
  if (!principal) throw principalError("IPC_PRINCIPAL_REQUIRED", "webContents principal is not registered");
  if (!allowedRoles.includes(principal.role)) throw principalError("IPC_ROLE_DENIED", `principal role ${principal.role} is not allowed`);
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (principal.role !== "platform-child" && !urlMatchesPrincipal(principal, senderUrl)) {
    revokeWebContentsPrincipal(event.sender.id, "ipc_url_mismatch");
    throw principalError("IPC_NAVIGATION_STALE", "principal navigation boundary is no longer valid");
  }
  return principal;
}

function onPrincipalRevoked(listener) {
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

module.exports = {
  getWebContentsPrincipal,
  isMainFrameEvent,
  onPrincipalRevoked,
  registerWebContentsPrincipal,
  requireWebContentsPrincipal,
  revokeWebContentsPrincipal,
  urlMatchesPrincipal
};
