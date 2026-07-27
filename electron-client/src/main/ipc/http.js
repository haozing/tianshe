const { ipcMain, session } = require("electron");
const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const { parseLosslessJson } = require("../utils/lossless-json");

const defaultHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 20,
  timeout: 15000
});

const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  rejectUnauthorized: true,
  timeout: 15000
});

const axiosInstance = axios.create({
  httpAgent: defaultHttpAgent,
  httpsAgent: defaultHttpsAgent,
  timeout: 30000,
  decompress: true
});

function normalizeNativeTimeoutMs(value, fallback = 30000) {
  const numeric = Number(value == null ? fallback : value);
  return Math.max(5000, Math.min(120000, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
}

function getImageBase64(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function extractSetCookieLines(headers) {
  if (!headers) return [];
  const raw = headers["set-cookie"] || headers["Set-Cookie"] || headers["Set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [String(raw)];
}

function parseOneSetCookieLine(line) {
  const parts = String(line).split(";").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  if (eq < 1) return null;

  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    path: "/",
    secure: false,
    httpOnly: false
  };

  for (const attr of attrs) {
    const idx = attr.indexOf("=");
    const key = (idx > -1 ? attr.slice(0, idx) : attr).trim().toLowerCase();
    const value = idx > -1 ? attr.slice(idx + 1).trim() : "";

    if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "domain") cookie.domain = value.replace(/^\./, "");
    else if (key === "path") cookie.path = value || "/";
    else if (key === "max-age") {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds)) cookie.expirationDate = Math.floor(Date.now() / 1000 + seconds);
    } else if (key === "expires") {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) cookie.expirationDate = Math.floor(ms / 1000);
    } else if (key === "samesite") {
      const sameSite = value.toLowerCase();
      if (sameSite === "none") cookie.sameSite = "no_restriction";
      if (sameSite === "lax") cookie.sameSite = "lax";
      if (sameSite === "strict") cookie.sameSite = "strict";
    }
  }

  return cookie;
}

function cookieStoreUrl(cookie, requestUrl) {
  let host = cookie.domain;
  if (!host && requestUrl) {
    try {
      host = new URL(requestUrl).hostname;
    } catch {
      host = "localhost";
    }
  }
  return `${cookie.secure ? "https:" : "http:"}//${host || "localhost"}${cookie.path || "/"}`;
}

async function persistSetCookieHeaders(partition, headers, requestUrl) {
  const p = String(partition || "").trim();
  if (!p) return;
  const lines = extractSetCookieLines(headers);
  if (!lines.length) return;

  const ses = session.fromPartition(p);
  for (const line of lines) {
    const parsed = parseOneSetCookieLine(line);
    if (!parsed) continue;

    const detail = {
      url: cookieStoreUrl(parsed, requestUrl),
      name: parsed.name,
      value: parsed.value,
      path: parsed.path || "/",
      secure: parsed.secure,
      httpOnly: parsed.httpOnly
    };
    if (parsed.domain && parsed.domain.includes(".")) {
      detail.domain = `.${parsed.domain.replace(/^\./, "")}`;
    }
    if (parsed.expirationDate != null) detail.expirationDate = parsed.expirationDate;
    if (parsed.sameSite) detail.sameSite = parsed.sameSite;

    try {
      await ses.cookies.set(detail);
    } catch (error) {
      console.warn(`[http] Set-Cookie 写入 partition 失败 (${parsed.name}):`, error.message);
    }
  }
}

function normalizeNativeBody(body) {
  if (body == null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

function normalizeNativeHeaders(headers = {}, body) {
  const nextHeaders = { ...(headers && typeof headers === "object" ? headers : {}) };
  const hasContentType = Object.keys(nextHeaders).some((key) => key.toLowerCase() === "content-type");
  if (!hasContentType && body != null && typeof body !== "string" && !Buffer.isBuffer(body)) {
    nextHeaders["Content-Type"] = "application/json";
  }
  return nextHeaders;
}

function nativeHttpErrorMessage(status, statusText, body) {
  const bodyText = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : "";
  const detail = bodyText.replace(/\s+/g, " ").trim().slice(0, 512);
  const label = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  return detail ? `${label}: ${detail}` : label;
}

async function nativeHttpRequest(args = {}) {
  const url = String(args.url || "").trim();
  if (!url) return { ok: false, status: 0, headers: {}, data: null, error: { message: "missing url" } };

  const losslessJson = args.responseType === "losslessJson";
  const responseType = args.responseType === "arrayBuffer" || args.responseType === "base64"
    ? "arraybuffer"
    : args.responseType === "text" || losslessJson
      ? "text"
      : "json";
  const requestBody = normalizeNativeBody(args.body);
  const headers = normalizeNativeHeaders(args.headers, args.body);

  try {
    const response = await axiosInstance({
      url,
      method: args.method || "GET",
      headers,
      data: requestBody,
      timeout: normalizeNativeTimeoutMs(args.timeoutMs),
      responseType,
      validateStatus: () => true
    });
    if (args.persistSetCookie !== false) {
      await persistSetCookieHeaders(args.partition, response.headers, url);
    }

    let data = response.data;
    if (args.responseType === "base64") {
      data = Buffer.from(data).toString("base64");
    } else if (args.responseType === "arrayBuffer" && Buffer.isBuffer(data)) {
      data = Array.from(data.values());
    } else if (losslessJson) {
      try {
        data = parseLosslessJson(data);
      } catch (error) {
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data,
            error: { message: nativeHttpErrorMessage(response.status, response.statusText, data) }
          };
        }
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: null,
          error: { message: `invalid lossless JSON response: ${error.message || String(error)}` }
        };
      }
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: error.response ? error.response.status : 0,
      headers: error.response ? error.response.headers : {},
      data: error.response ? error.response.data : null,
      error: { message: error.message || String(error) }
    };
  }
}

function registerHttpHandlers() {
  ipcMain.handle("http", async (_event, args = {}) => {
    const result = { data: null, error: null };

    if (args.getBase64) {
      return { data: await getImageBase64(args.url) };
    }

    const httpAgent = args.httpAgentPagrams ? new http.Agent(args.httpAgentPagrams) : defaultHttpAgent;
    const httpsAgent = args.httpsAgentPagrams ? new https.Agent(args.httpsAgentPagrams) : defaultHttpsAgent;
    const axiosParams = {
      ...args.axiosParmars,
      httpAgent,
      httpsAgent,
      timeout: normalizeNativeTimeoutMs(args.axiosParamsTimeout)
    };

    const requestUrl = typeof axiosParams.url === "string" ? axiosParams.url : undefined;

    try {
      const response = await axiosInstance(axiosParams);
      result.data = response.data;
      await persistSetCookieHeaders(args.partition, response.headers, requestUrl);
    } catch (error) {
      const errorInfo = { message: error.message || String(error) };
      if (error.response) {
        errorInfo.status = error.response.status ?? null;
        result.data = error.response.data ?? null;
        await persistSetCookieHeaders(args.partition, error.response.headers, requestUrl);
      }
      result.error = errorInfo;
    }

    return result;
  });

  ipcMain.handle("native:http:request", async (_event, args = {}) => {
    return nativeHttpRequest(args);
  });
}

module.exports = { nativeHttpRequest, normalizeNativeTimeoutMs, registerHttpHandlers };
