const { session } = require("electron");
const axios = require("axios");

function uniqueCookies(cookies) {
  const byKey = new Map();
  for (const cookie of cookies || []) {
    if (!cookie?.name) continue;
    const key = `${cookie.name};${cookie.domain || ""};${cookie.path || ""}`;
    byKey.set(key, cookie);
  }
  return Array.from(byKey.values());
}

async function getCookieHeader(partition, url, domain) {
  const targetSession = session.fromPartition(partition);
  const cookies = [];
  const filters = [
    { url },
    ...(domain ? [{ domain }] : [])
  ];

  for (const filter of filters) {
    try {
      cookies.push(...(await targetSession.cookies.get(filter)));
    } catch {}
  }

  return uniqueCookies(cookies)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function doudianRequestHeaders(cookieHeader, adapter, plan = {}, url = "") {
  const requestPolicy = adapter?.policies?.platformRequest || {};
  const configuredHeaders = requestPolicy.headers && typeof requestPolicy.headers === "object"
    ? requestPolicy.headers
    : {};
  const planHeaders = plan?.headers && typeof plan.headers === "object"
    ? plan.headers
    : {};
  const includeReferer = requestPolicy.includeReferer !== false;
  const includeCookie = requestPolicy.includeCookie !== false;
  const referer = typeof plan?.referer === "string" && plan.referer.trim()
    ? plan.referer
    : requestPolicy.referer || adapter?.origin || "";
  const origin = typeof plan?.origin === "string" && plan.origin.trim()
    ? plan.origin
    : requestPolicy.origin || "";
  return {
    ...configuredHeaders,
    ...planHeaders,
    ...(origin ? { Origin: origin } : {}),
    ...(includeReferer && referer ? { Referer: referer } : {}),
    ...(!planHeaders.Host && !configuredHeaders.Host && requestPolicy.includeHostFromUrl === true && url ? (() => {
      try {
        return { Host: new URL(url).host };
      } catch {
        return {};
      }
    })() : {}),
    ...(includeCookie && cookieHeader ? { Cookie: cookieHeader } : {})
  };
}

async function doudianRequestGet({ partition, url, adapter, timeoutMs, safeError, plan = {}, data = undefined }) {
  const cookieHeader = await getCookieHeader(partition, url, adapter?.cookieDomain);
  const method = String(plan?.method || "GET").toUpperCase();
  try {
    const response = await axios({
      method,
      url,
      ...(data !== undefined && method !== "GET" ? { data } : {}),
      headers: doudianRequestHeaders(cookieHeader, adapter, plan, url),
      timeout: timeoutMs,
      validateStatus: () => true
    });
    return {
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data,
      error: response.status >= 400 ? { status: response.status } : null
    };
  } catch (error) {
    return {
      success: false,
      status: 0,
      data: null,
      error: { message: safeError ? safeError(error) : error?.message || String(error) }
    };
  }
}

module.exports = { doudianRequestGet, doudianRequestHeaders, getCookieHeader };
