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

function cookieSetKey(cookie) {
  return `${cookie.name};${cookie.domain || ""};${cookie.path || "/"}`;
}

function uniqueCookiesForSet(cookies) {
  const byKey = new Map();
  for (const cookie of cookies || []) {
    if (typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
    const detail = normalizeCookieForSet(cookie);
    const key = cookieSetKey(detail);
    const existing = byKey.get(key);
    if (!existing || (detail.secure && !existing.secure)) {
      byKey.set(key, detail);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => Number(left.secure) - Number(right.secure));
}

function optionSet(value) {
  return new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean));
}

async function setCookies(partition, cookies) {
  if (!Array.isArray(cookies)) {
    return new Error("传入的 cookies 不是数组类型");
  }

  const targetSession = session.fromPartition(partition);
  let err = null;
  try {
    for (const cookie of uniqueCookiesForSet(cookies)) {
      await targetSession.cookies.set(cookie);
    }
  } catch (error) {
    err = error;
  }
  return err;
}

async function copyCookies(oldPartition, newPartition, options = {}) {
  const oldSession = session.fromPartition(oldPartition);
  const newSession = session.fromPartition(newPartition);
  let err = null;
  try {
    const cookies = await oldSession.cookies.get({});
    const excludeNames = optionSet(options.excludeNames || options.excludeCookieNames);
    if (oldPartition !== newPartition && options.clearTarget !== false) {
      await newSession.clearStorageData({
        storages: ["cookies"]
      });
    }
    for (const detail of uniqueCookiesForSet(cookies)) {
      if (excludeNames.has(detail.name)) continue;
      try {
        await newSession.cookies.set(detail);
      } catch (error) {
        try {
          await newSession.cookies.remove(detail.url, detail.name);
          await newSession.cookies.set(detail);
        } catch {
          throw error;
        }
      }
    }
  } catch (error) {
    err = error;
  }
  return err;
}

async function removeCookies(partition, args = {}) {
  const currentSession = session.fromPartition(partition);
  const names = optionSet([
    ...(Array.isArray(args.names) ? args.names : []),
    args.name
  ]);
  const query = {};
  if (typeof args.url === "string" && args.url.trim()) {
    query.url = args.url.trim();
  } else if (typeof args.domain === "string" && args.domain.trim()) {
    query.domain = args.domain.trim();
  }

  let err = null;
  let removed = 0;
  try {
    const cookies = await currentSession.cookies.get(query);
    for (const cookie of cookies) {
      if (names.size && !names.has(cookie.name)) continue;
      const detail = normalizeCookieForSet(cookie);
      await currentSession.cookies.remove(detail.url, cookie.name);
      removed += 1;
    }
  } catch (error) {
    err = error;
  }
  return { err, removed };
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

async function getCookieHeader(args = {}) {
  const partition = String(args.partition || "").trim();
  if (!partition) return { ok: false, cookieHeader: "", cookies: [], message: "missing partition" };

  const query = {};
  if (typeof args.url === "string" && args.url.trim()) {
    query.url = args.url.trim();
  } else if (typeof args.domain === "string" && args.domain.trim()) {
    query.domain = args.domain.trim();
  }

  const names = Array.isArray(args.names)
    ? new Set(args.names.map((name) => String(name)).filter(Boolean))
    : null;
  const cookies = await session.fromPartition(partition).cookies.get(query);
  const filtered = names ? cookies.filter((cookie) => names.has(cookie.name)) : cookies;
  return {
    ok: true,
    cookieHeader: filtered.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    cookies: filtered.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path
    }))
  };
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

  ipcMain.handle("native:cookies:get", async (_event, args = {}) => {
    const ses = session.fromPartition(args.partition);
    if (typeof args.url === "string" && args.url.trim()) {
      return { ok: true, cookies: await ses.cookies.get({ url: args.url.trim() }) };
    }
    return { ok: true, cookies: await ses.cookies.get({ domain: args.domain }) };
  });

  ipcMain.handle("native:cookies:set", async (_event, args = {}) => {
    const err = await setCookies(args.partition, args.cookies);
    return { ok: !err, err };
  });

  ipcMain.handle("native:cookies:copy", async (_event, args = {}) => {
    const err = await copyCookies(args.oldPartition || args.fromPartition, args.newPartition || args.toPartition, args);
    return { ok: !err, err };
  });

  ipcMain.handle("native:cookies:remove", async (_event, args = {}) => {
    const result = await removeCookies(args.partition, args);
    return { ok: !result.err, ...result };
  });

  ipcMain.handle("native:cookies:getHeader", async (_event, args = {}) => {
    return getCookieHeader(args);
  });

  ipcMain.handle("native:cookies:clear", async (_event, args = {}) => {
    const err = await clearAllSessionData(args.partition);
    return { ok: !err, err };
  });
}

module.exports = {
  clearAllSessionData,
  copyCookies,
  getCookieHeader,
  removeCookies,
  registerCookieHandlers,
  setCookies
};
