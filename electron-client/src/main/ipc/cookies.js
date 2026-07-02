const { ipcMain, session } = require("electron");

function normalizeCookieForSet(cookie) {
  let domain = cookie.domain;
  if (domain) {
    domain = domain.startsWith(".") ? domain.slice(1) : domain;
    if (!domain.includes(".")) domain = undefined;
  }

  const protocol = cookie.secure ? "https:" : "http:";
  const host = domain || "localhost";
  const url = `${protocol}//${host}${cookie.path || "/"}`;

  return {
    ...cookie,
    url,
    ...(domain ? { domain } : {})
  };
}

async function setCookies(partition, cookies) {
  if (!Array.isArray(cookies)) {
    return new Error("传入的 cookies 不是数组类型");
  }

  const targetSession = session.fromPartition(partition);
  let err = null;
  try {
    for (const cookie of cookies) {
      if (typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
      await targetSession.cookies.set(normalizeCookieForSet(cookie));
    }
  } catch (error) {
    err = error;
  }
  return err;
}

async function copyCookies(oldPartition, newPartition) {
  const oldSession = session.fromPartition(oldPartition);
  const newSession = session.fromPartition(newPartition);
  let err = null;
  try {
    const cookies = await oldSession.cookies.get({});
    for (const cookie of cookies) {
      await newSession.cookies.set(normalizeCookieForSet(cookie));
    }
  } catch (error) {
    err = error;
  }
  return err;
}

async function clearAllSessionData(partition) {
  const currentSession = session.fromPartition(partition);
  let err = null;
  try {
    await currentSession.clearStorageData({
      storages: [
        "appcache",
        "cookies",
        "filesystem",
        "indexdb",
        "localstorage",
        "shadercache",
        "websql",
        "serviceworkers"
      ]
    });
    await currentSession.clearCache();
  } catch (error) {
    err = error;
  }
  return err;
}

function registerCookieHandlers() {
  ipcMain.handle("get_cookies", async (_event, args = {}) => {
    const ses = session.fromPartition(args.partition);
    if (typeof args.url === "string" && args.url.trim()) {
      return ses.cookies.get({ url: args.url.trim() });
    }
    return ses.cookies.get({ domain: args.domain });
  });

  ipcMain.handle("copy_cookies", async (_event, args = {}) => {
    const err = await copyCookies(args.oldPartition, args.newPartition);
    return { err };
  });

  ipcMain.handle("clear_session", async (_event, args = {}) => {
    const err = await clearAllSessionData(args.partition);
    return { err };
  });

  ipcMain.handle("set_cookies", async (_event, args = {}) => {
    const err = await setCookies(args.partition, args.cookies);
    return { err };
  });
}

module.exports = { registerCookieHandlers };

