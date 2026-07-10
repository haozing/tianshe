import type { DoudianAdapterPayload } from "../../types";
import { requireChihuNative } from "../../native/client";

export const XZB_SIGN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface XzbSignRequest {
  targetUrl: string;
  partition?: string;
  plan?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface XzbSignResult {
  ok: boolean;
  reason?: string;
  targetUrl: string;
  query: string;
  signature: string;
  source: string;
  mode: string;
  userAgent: string;
  error?: string;
  detail?: Record<string, unknown>;
}

function text(value: unknown) {
  return String(value || "");
}

function interpolate(value: unknown, context: Record<string, unknown>) {
  return String(value ?? "").replace(/\{([^}]+)\}/g, (_match, key) => String(context[key] ?? ""));
}

function interpolateDeep(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{([^}]+)\}$/);
    if (exact) return context[exact[1]] ?? "";
    return interpolate(value, context);
  }
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, next]) => [key, interpolateDeep(next, context)]));
  }
  return value;
}

function normalizeQuery(value: string) {
  return String(value || "").trim().replace(/^[?&]+/, "");
}

function targetSearchQuery(targetUrl: string) {
  try {
    const target = new URL(targetUrl);
    return normalizeQuery(target.search ? target.search.slice(1) : "");
  } catch {
    return "";
  }
}

function pickSignQuery(targetUrl: string, plan: Record<string, unknown>, context: Record<string, unknown>) {
  if (typeof plan.signQuery === "string") return normalizeQuery(interpolate(plan.signQuery, context));
  if (typeof plan.signQueryString === "string") return normalizeQuery(interpolate(plan.signQueryString, context));
  return targetSearchQuery(targetUrl);
}

function pickSignBody(plan: Record<string, unknown>, context: Record<string, unknown>) {
  if (typeof plan.signBody === "string") {
    const exact = plan.signBody.match(/^\{([^}]+)\}$/);
    if (exact) {
      const value = context[exact[1]];
      return typeof value === "string" ? value : JSON.stringify(value ?? "");
    }
    return interpolate(plan.signBody, context);
  }
  if (plan.signBody != null) return JSON.stringify(interpolateDeep(plan.signBody, context));

  const method = String(plan.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || plan.body == null) return "";
  const body = interpolateDeep(plan.body, context);
  return typeof body === "string" ? body : JSON.stringify(body);
}

function pickUserAgent(plan: Record<string, unknown>, context: Record<string, unknown>) {
  const configured = typeof plan.userAgent === "string" ? interpolate(plan.userAgent, context).trim() : "";
  return configured || XZB_SIGN_USER_AGENT;
}

function randomFp() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let index = 0; index < 50; index += 1) {
    output += chars[Math.floor(Math.random() * chars.length)];
  }
  return output;
}

async function readCookieValue(partition: string, name: string, candidates: Array<{ domain?: string; url?: string }>) {
  const native = requireChihuNative();
  for (const candidate of candidates) {
    const result = await native.cookies.getHeader({
      partition,
      names: [name],
      ...(candidate.url ? { url: candidate.url } : {}),
      ...(candidate.domain ? { domain: candidate.domain } : {})
    }).catch(() => null);
    const cookie = result?.cookies?.find((item) => item.name === name && item.value);
    if (cookie?.value) return cookie.value;
  }
  return "";
}

function domainCandidates(targetUrl: string, signDomain: string, name: "fp" | "msToken") {
  const candidates: Array<{ domain?: string; url?: string }> = [];
  const addDomain = (domain: string) => {
    if (domain && !candidates.some((item) => item.domain === domain)) candidates.push({ domain });
  };
  const addUrl = (url: string) => {
    if (url && !candidates.some((item) => item.url === url)) candidates.push({ url });
  };

  if (name === "msToken") addDomain(".bytedance.com");
  addDomain(signDomain);
  addDomain(".jinritemai.com");
  if (name === "fp") addDomain(".bytedance.com");
  try {
    const target = new URL(targetUrl);
    addUrl(target.origin + "/");
  } catch {}
  return candidates;
}

export async function signWithXzbMstoken(payload: DoudianAdapterPayload, request: XzbSignRequest): Promise<XzbSignResult> {
  const plan = request.plan || {};
  const context = request.context || {};
  const partition = request.partition || payload.adapter.signerPartition || payload.adapter.sourcePartition;
  const signDomain = text(plan.signDomain) || payload.adapter.cookieDomain || ".jinritemai.com";
  const userAgent = pickUserAgent(plan, context);
  const targetUrl = request.targetUrl;

  try {
    const query = pickSignQuery(targetUrl, plan, context);
    const body = pickSignBody(plan, context);
    if (!query && String(plan.method || "GET").toUpperCase() === "GET") {
      return {
        ok: false,
        reason: "empty-sign-query",
        targetUrl,
        query: "",
        signature: "",
        source: "xzb-local",
        mode: "mstoken-myargs",
        userAgent
      };
    }

    const fp = await readCookieValue(partition, "s_v_web_id", domainCandidates(targetUrl, signDomain, "fp"))
      || await readCookieValue(partition, "MONITOR_WEB_ID", domainCandidates(targetUrl, signDomain, "fp"))
      || randomFp();
    const useMsToken = plan.signUseMsToken !== false && plan.useMsToken !== false;
    const includeMsTokenParam = useMsToken || plan.signIncludeEmptyMsToken === true || plan.signIncludeMsTokenParam === true;
    const msToken = useMsToken
      ? await readCookieValue(partition, "msToken", domainCandidates(targetUrl, signDomain, "msToken"))
        || text(plan.signToken)
        || text(plan.signFallbackToken)
      : "";
    if (useMsToken && (plan.signRequireMsToken === true || plan.requireMsToken === true) && !msToken) {
      return {
        ok: false,
        reason: "missing-msToken",
        targetUrl,
        query: "",
        signature: "",
        source: "xzb-local",
        mode: "mstoken-myargs",
        userAgent,
        detail: { hasFp: !!fp, hasMsToken: false, queryLength: query.length, bodyLength: body.length }
      };
    }
    const queryBase = [
      query,
      `fp=${encodeURIComponent(fp)}`,
      `verifyFp=${encodeURIComponent(fp)}`,
      includeMsTokenParam ? `msToken=${msToken ? encodeURIComponent(msToken) : ""}` : ""
    ].filter(Boolean).join("&");
    const aBogus = getABougsSign(queryBase, body, userAgent);
    if (!aBogus) {
      return {
        ok: false,
        reason: "abogus-empty",
        targetUrl,
        query: queryBase,
        signature: "",
        source: "xzb-local",
        mode: "mstoken-myargs",
        userAgent,
        detail: { hasFp: !!fp, hasMsToken: !!msToken, queryLength: query.length, bodyLength: body.length }
      };
    }
    const myargs = `${queryBase}&a_bogus=${aBogus}`;
    return {
      ok: true,
      targetUrl,
      query: myargs,
      signature: aBogus,
      source: "xzb-local",
      mode: "mstoken-myargs",
      userAgent,
      detail: { hasFp: !!fp, hasMsToken: !!msToken, queryLength: query.length, bodyLength: body.length }
    };
  } catch (error) {
    return {
      ok: false,
      reason: "xzb-local-error",
      targetUrl,
      query: "",
      signature: "",
      source: "xzb-local",
      mode: "mstoken-myargs",
      userAgent,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function rotateLeft(value: number, bits: number) {
  bits %= 32;
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sm3T(index: number) {
  return index >= 0 && index < 16 ? 2043430169 : index >= 16 && index < 64 ? 2055708042 : 0;
}

function sm3FF(index: number, left: number, mid: number, right: number) {
  return index >= 0 && index < 16
    ? (left ^ mid ^ right) >>> 0
    : index >= 16 && index < 64
      ? ((left & mid) | (left & right) | (mid & right)) >>> 0
      : 0;
}

function sm3GG(index: number, left: number, mid: number, right: number) {
  return index >= 0 && index < 16
    ? (left ^ mid ^ right) >>> 0
    : index >= 16 && index < 64
      ? ((left & mid) | (~left & right)) >>> 0
      : 0;
}

function stringBytes(value: string) {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_match, hex) => {
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
  return Array.from(encoded, (char) => char.charCodeAt(0));
}

function sm3Digest(input: string | number[]) {
  let vectors = [1937774191, 1226093241, 388252375, 3666478592, 2842636476, 372324522, 3817729613, 2969243214];
  let buffer: number[] = [];
  let totalLength = 0;

  const compress = (chunk: number[]) => {
    const schedule = new Array<number>(132);
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = chunk[4 * index] << 24;
      schedule[index] |= chunk[4 * index + 1] << 16;
      schedule[index] |= chunk[4 * index + 2] << 8;
      schedule[index] |= chunk[4 * index + 3];
      schedule[index] >>>= 0;
    }
    for (let index = 16; index < 68; index += 1) {
      let value = schedule[index - 16] ^ schedule[index - 9] ^ rotateLeft(schedule[index - 3], 15);
      value = value ^ rotateLeft(value, 15) ^ rotateLeft(value, 23);
      schedule[index] = (value ^ rotateLeft(schedule[index - 13], 7) ^ schedule[index - 6]) >>> 0;
    }
    for (let index = 0; index < 64; index += 1) {
      schedule[index + 68] = (schedule[index] ^ schedule[index + 4]) >>> 0;
    }

    const next = vectors.slice(0);
    for (let index = 0; index < 64; index += 1) {
      let ss1 = rotateLeft(next[0], 12) + next[4] + rotateLeft(sm3T(index), index);
      ss1 = rotateLeft((0xffffffff & ss1) >>> 0, 7);
      const ss2 = (ss1 ^ rotateLeft(next[0], 12)) >>> 0;
      let tt1 = sm3FF(index, next[0], next[1], next[2]);
      tt1 = (0xffffffff & (tt1 + next[3] + ss2 + schedule[index + 68])) >>> 0;
      let tt2 = sm3GG(index, next[4], next[5], next[6]);
      tt2 = (0xffffffff & (tt2 + next[7] + ss1 + schedule[index])) >>> 0;
      next[3] = next[2];
      next[2] = rotateLeft(next[1], 9);
      next[1] = next[0];
      next[0] = tt1;
      next[7] = next[6];
      next[6] = rotateLeft(next[5], 19);
      next[5] = next[4];
      next[4] = (tt2 ^ rotateLeft(tt2, 9) ^ rotateLeft(tt2, 17)) >>> 0;
    }
    vectors = vectors.map((value, index) => (value ^ next[index]) >>> 0);
  };

  const update = (value: string | number[]) => {
    const bytes = typeof value === "string" ? stringBytes(value) : value.slice();
    totalLength += bytes.length;
    let remainingCapacity = 64 - buffer.length;
    if (bytes.length < remainingCapacity) {
      buffer = buffer.concat(bytes);
      return;
    }
    buffer = buffer.concat(bytes.slice(0, remainingCapacity));
    while (buffer.length >= 64) {
      compress(buffer);
      if (remainingCapacity < bytes.length) {
        buffer = bytes.slice(remainingCapacity, Math.min(remainingCapacity + 64, bytes.length));
      } else {
        buffer = [];
      }
      remainingCapacity += 64;
    }
  };

  const pad = () => {
    const bitLength = 8 * totalLength;
    let offset = buffer.push(128) % 64;
    if (64 - offset < 8) offset -= 64;
    for (; offset < 56; offset += 1) buffer.push(0);
    for (let index = 0; index < 4; index += 1) {
      const high = Math.floor(bitLength / 4294967296);
      buffer.push((high >>> (8 * (3 - index))) & 255);
    }
    for (let index = 0; index < 4; index += 1) {
      buffer.push((bitLength >>> (8 * (3 - index))) & 255);
    }
  };

  update(input);
  pad();
  for (let index = 0; index < buffer.length; index += 64) compress(buffer.slice(index, index + 64));

  const output = new Array<number>(32);
  for (let index = 0; index < 8; index += 1) {
    let value = vectors[index];
    output[4 * index + 3] = (255 & value) >>> 0;
    value >>>= 8;
    output[4 * index + 2] = (255 & value) >>> 0;
    value >>>= 8;
    output[4 * index + 1] = (255 & value) >>> 0;
    value >>>= 8;
    output[4 * index] = (255 & value) >>> 0;
  }
  return output;
}

function rc4(key: string, input: string) {
  let temp = 0;
  const box: number[] = [];
  let j = 0;
  let output = "";
  for (let index = 0; index < 256; index += 1) box[index] = index;
  for (let index = 0; index < 256; index += 1) {
    j = (j + box[index] + key.charCodeAt(index % key.length)) % 256;
    temp = box[index];
    box[index] = box[j];
    box[j] = temp;
  }
  let i = 0;
  j = 0;
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) % 256;
    j = (j + box[i]) % 256;
    temp = box[i];
    box[i] = box[j];
    box[j] = temp;
    output += String.fromCharCode(input.charCodeAt(index) ^ box[(box[i] + box[j]) % 256]);
  }
  return output;
}

function customBase64Every3(input: string) {
  const alphabet = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
  let output = "";
  for (let index = 0; index <= input.length - 1; index += 3) {
    const left = input.charCodeAt(index);
    const mid = input.charCodeAt(index + 1);
    const right = input.charCodeAt(index + 2);
    const value = right | (mid << 8) | (left << 16);
    output += alphabet[(value & 16515072) >> 18]
      + alphabet[(value & 258048) >> 12]
      + alphabet[(value & 4032) >> 6]
      + alphabet[value & 63];
  }
  return output;
}

function customBase64Pad(input: string) {
  const alphabet = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
  let output = "";
  const full = input.slice(0, Math.floor(input.length / 3) * 3);
  const rest = input.slice(Math.floor(input.length / 3) * 3);
  for (let index = 0; index <= full.length - 1; index += 3) {
    const left = full.charCodeAt(index);
    const mid = full.charCodeAt(index + 1);
    const right = full.charCodeAt(index + 2);
    const value = right | (mid << 8) | (left << 16);
    output += alphabet[(value & 16515072) >> 18]
      + alphabet[(value & 258048) >> 12]
      + alphabet[(value & 4032) >> 6]
      + alphabet[value & 63];
  }
  if (rest.length === 1) {
    const value = rest.charCodeAt(0) << 16;
    output += alphabet[(value & 16515072) >> 18];
    output += alphabet[(value & 258048) >> 12];
  } else {
    for (let index = 0; index < rest.length; index += 2) {
      const left = rest.charCodeAt(index);
      const mid = (rest.charCodeAt(index + 1) << 8) | (left << 16);
      output += alphabet[(mid & 16515072) >> 18]
        + alphabet[(mid & 258048) >> 12]
        + alphabet[(mid & 4032) >> 6];
    }
  }
  return output.padEnd((Math.floor(input.length / 3) + 1) * 4, "=");
}

function xorBytes(input: number[]) {
  return input.reduce((left, right) => left ^ right);
}

function randomHeaderOne() {
  const value = Math.floor(Math.random() * 10000);
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode(left & 170 | 1, left & 85 | 2, right & 170 | 5, right & 85 | 40);
}

function randomHeaderTwo() {
  const value = Math.floor(Math.random() * 10000);
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode(left & 170 | 1, left & 85 | 0, right & 170 | 0, right & 85 | 0);
}

function randomHeaderThree() {
  const value = Math.floor(Math.random() * 10000);
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode(left & 170 | 1, left & 85 | 0, right & 170 | 1, right & 85 | 0);
}

function buildABogus(query: string, userAgent: string, body: string) {
  const suffix = "cus";
  const timestamp = Date.now();
  const queryHash = sm3Digest(sm3Digest(query + suffix));
  const userAgentHash = sm3Digest(customBase64Every3(rc4("\0\u0001\0", userAgent)));
  const bodyHash = sm3Digest(sm3Digest(body + suffix));
  const timestampMinus = timestamp - 100;
  const timestampRatio = timestampMinus / 256 / 256 / 256 / 256;
  const constantOne = 23756;
  const constantTwo = 4272;
  const screenBytes = [
    49, 57, 50, 48, 124, 52, 55, 57, 124, 49, 57, 50, 48, 124, 49, 48, 53, 48, 124, 48, 124, 48, 124, 51,
    50, 49, 124, 51, 50, 49, 124, 49, 57, 50, 48, 124, 49, 48, 53, 48, 124, 49, 57, 50, 48, 124, 49,
    48, 56, 48, 124, 49, 57, 48, 51, 124, 52, 55, 57, 124, 50, 52, 124, 50, 52, 124, 87, 105, 110, 51, 50
  ];
  const headerBytes = [
    44,
    (timestamp >> 24) & 255,
    0,
    0,
    0,
    0,
    16,
    queryHash[21],
    bodyHash[21],
    0,
    userAgentHash[23],
    (timestamp >> 16) & 255,
    0,
    (constantOne >> 8) & 255,
    constantOne & 255,
    1,
    0,
    constantTwo & 255,
    queryHash[22],
    bodyHash[22],
    userAgentHash[24],
    (timestamp >> 8) & 255,
    0,
    0,
    0,
    0,
    timestamp & 255,
    0,
    0,
    0,
    (timestampMinus >> 24) & 255,
    (timestampMinus >> 16) & 255,
    0,
    (timestampMinus >> 8) & 255,
    timestampMinus & 255,
    3,
    Math.floor(timestampRatio),
    Math.floor(timestampRatio / 256),
    Math.floor(timestampRatio),
    Math.floor(timestampRatio / 256),
    screenBytes.length,
    0,
    0,
    0
  ];
  const payload = headerBytes.concat(screenBytes);
  payload.push(xorBytes(headerBytes));
  const encrypted = rc4("y", String.fromCharCode.apply(null, payload));
  return customBase64Pad(randomHeaderOne() + randomHeaderTwo() + randomHeaderThree() + encrypted);
}

export function getABougsSign(query: string, body = "", userAgent = XZB_SIGN_USER_AGENT) {
  return buildABogus(query, userAgent, body || "");
}
