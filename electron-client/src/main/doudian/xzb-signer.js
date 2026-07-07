const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SM3_INIT = [
  1937774191,
  1226093241,
  388252375,
  3666478592,
  2842636476,
  372324522,
  3817729613,
  2969243214
];

const UA_ALPHABET = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const OUT_ALPHABET = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";

function leftShift(value, bits) {
  return (value << (bits % 32)) >>> 0;
}

function rightShift(value, bits) {
  return (value >>> bits) >>> 0;
}

function rotateLeft(value, bits) {
  return (leftShift(value, bits % 32) | rightShift(value, 32 - (bits % 32))) >>> 0;
}

function tj(index) {
  if (index >= 0 && index < 16) return 2043430169;
  if (index >= 16 && index < 64) return 2055708042;
  return 0;
}

function ff(index, x, y, z) {
  if (index >= 0 && index < 16) return (x ^ y ^ z) >>> 0;
  if (index >= 16 && index < 64) return ((x & y) | (x & z) | (y & z)) >>> 0;
  return 0;
}

function gg(index, x, y, z) {
  if (index >= 0 && index < 16) return (x ^ y ^ z) >>> 0;
  if (index >= 16 && index < 64) return ((x & y) | (~x & z)) >>> 0;
  return 0;
}

function bytesFrom(value) {
  if (Array.isArray(value)) return value.slice();
  const encoded = encodeURIComponent(String(value || "")).replace(/%([0-9A-F]{2})/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return Array.from(encoded).map((item) => item.charCodeAt(0));
}

function compressSm3Block(block, reg) {
  const words = new Array(132);
  for (let index = 0; index < 16; index += 1) {
    words[index] = block[4 * index] << 24;
    words[index] |= block[4 * index + 1] << 16;
    words[index] |= block[4 * index + 2] << 8;
    words[index] |= block[4 * index + 3];
    words[index] >>>= 0;
  }
  for (let index = 16; index < 68; index += 1) {
    let next = words[index - 16] ^ words[index - 9] ^ rotateLeft(words[index - 3], 15);
    next = next ^ rotateLeft(next, 15) ^ rotateLeft(next, 23);
    words[index] = (next ^ rotateLeft(words[index - 13], 7) ^ words[index - 6]) >>> 0;
  }
  for (let index = 0; index < 64; index += 1) {
    words[index + 68] = (words[index] ^ words[index + 4]) >>> 0;
  }

  const state = reg.slice();
  for (let index = 0; index < 64; index += 1) {
    let ss1 = rotateLeft((rotateLeft(state[0], 12) + state[4] + rotateLeft(tj(index), index)) >>> 0, 7);
    const ss2 = (ss1 ^ rotateLeft(state[0], 12)) >>> 0;
    let tt1 = ff(index, state[0], state[1], state[2]);
    tt1 = (tt1 + state[3] + ss2 + words[index + 68]) >>> 0;
    let tt2 = gg(index, state[4], state[5], state[6]);
    tt2 = (tt2 + state[7] + ss1 + words[index]) >>> 0;
    state[3] = state[2];
    state[2] = rotateLeft(state[1], 9);
    state[1] = state[0];
    state[0] = tt1;
    state[7] = state[6];
    state[6] = rotateLeft(state[5], 19);
    state[5] = state[4];
    state[4] = (tt2 ^ rotateLeft(tt2, 9) ^ rotateLeft(tt2, 17)) >>> 0;
  }

  for (let index = 0; index < 8; index += 1) {
    reg[index] = (reg[index] ^ state[index]) >>> 0;
  }
}

function sm3(value) {
  const reg = SM3_INIT.slice();
  let chunk = [];
  let size = 0;
  const bytes = bytesFrom(value);
  size += bytes.length;

  let next = 64 - chunk.length;
  if (bytes.length < next) {
    chunk = chunk.concat(bytes);
  } else {
    chunk = chunk.concat(bytes.slice(0, next));
    while (chunk.length >= 64) {
      compressSm3Block(chunk.slice(0, 64), reg);
      chunk = next < bytes.length ? bytes.slice(next, Math.min(next + 64, bytes.length)) : [];
      next += 64;
    }
  }

  const bits = 8 * size;
  let mod = chunk.push(128) % 64;
  if (64 - mod < 8) mod -= 64;
  for (; mod < 56; mod += 1) chunk.push(0);

  const high = Math.floor(bits / 4294967296);
  const low = bits >>> 0;
  for (let index = 0; index < 4; index += 1) chunk.push((high >>> (8 * (3 - index))) & 255);
  for (let index = 0; index < 4; index += 1) chunk.push((low >>> (8 * (3 - index))) & 255);

  for (let index = 0; index < chunk.length; index += 64) {
    compressSm3Block(chunk.slice(index, index + 64), reg);
  }

  const output = new Array(32);
  for (let index = 0; index < 8; index += 1) {
    let value32 = reg[index];
    output[4 * index + 3] = value32 & 255;
    value32 >>>= 8;
    output[4 * index + 2] = value32 & 255;
    value32 >>>= 8;
    output[4 * index + 1] = value32 & 255;
    value32 >>>= 8;
    output[4 * index] = value32 & 255;
  }
  return output;
}

function rc4(key, value) {
  let swap;
  const state = [];
  let cursor = 0;
  let output = "";
  for (let index = 0; index < 256; index += 1) state[index] = index;
  for (let index = 0; index < 256; index += 1) {
    cursor = (cursor + state[index] + key.charCodeAt(index % key.length)) % 256;
    swap = state[index];
    state[index] = state[cursor];
    state[cursor] = swap;
  }
  let left = 0;
  cursor = 0;
  for (let index = 0; index < value.length; index += 1) {
    left = (left + 1) % 256;
    cursor = (cursor + state[left]) % 256;
    swap = state[left];
    state[left] = state[cursor];
    state[cursor] = swap;
    output += String.fromCharCode(value.charCodeAt(index) ^ state[(state[left] + state[cursor]) % 256]);
  }
  return output;
}

function encodeTriplets(value, alphabet) {
  let output = "";
  for (let index = 0; index <= value.length - 1; index += 3) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    const pack = value.charCodeAt(index + 2) | (second << 8) | (first << 16);
    output += alphabet[(16515072 & pack) >> 18];
    output += alphabet[(258048 & pack) >> 12];
    output += alphabet[(4032 & pack) >> 6];
    output += alphabet[63 & pack];
  }
  return output;
}

function encodeOutput(value) {
  let output = "";
  const full = value.slice(0, 3 * Math.floor(value.length / 3));
  const rest = value.slice(3 * Math.floor(value.length / 3));
  for (let index = 0; index <= full.length - 1; index += 3) {
    const first = full.charCodeAt(index);
    const second = full.charCodeAt(index + 1);
    const pack = full.charCodeAt(index + 2) | (second << 8) | (first << 16);
    output += OUT_ALPHABET[(16515072 & pack) >> 18];
    output += OUT_ALPHABET[(258048 & pack) >> 12];
    output += OUT_ALPHABET[(4032 & pack) >> 6];
    output += OUT_ALPHABET[63 & pack];
  }
  if (rest.length === 1) {
    const pack = rest.charCodeAt(0) << 16;
    output += OUT_ALPHABET[(16515072 & pack) >> 18];
    output += OUT_ALPHABET[(258048 & pack) >> 12];
  } else {
    for (let index = 0; index < rest.length; index += 2) {
      const first = rest.charCodeAt(index);
      const pack = (rest.charCodeAt(index + 1) << 8) | (first << 16);
      output += OUT_ALPHABET[(16515072 & pack) >> 18];
      output += OUT_ALPHABET[(258048 & pack) >> 12];
      output += OUT_ALPHABET[(4032 & pack) >> 6];
    }
  }
  return output.padEnd(4 * (Math.floor(value.length / 3) + 1), "=");
}

function xorList(list) {
  return list.reduce((left, right) => left ^ right);
}

function randomBlockOne() {
  const value = Math.floor(10000 * Math.random());
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode((170 & left) | 1, (85 & left) | 2, (170 & right) | 5, (85 & right) | 40);
}

function randomBlockTwo() {
  const value = Math.floor(10000 * Math.random());
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode((170 & left) | 1, 85 & left, 170 & right, 85 & right);
}

function randomBlockThree() {
  const value = Math.floor(10000 * Math.random());
  const left = value & 255;
  const right = (value >> 8) & 255;
  return String.fromCharCode((170 & left) | 1, 85 & left, (170 & right) | 1, 85 & right);
}

function getABougsSign(query, body = "") {
  const salt = "cus";
  const timestamp1 = Date.now();
  const paramsList = sm3(sm3(`${query || ""}${salt}`));
  const uaString = encodeTriplets(rc4("\0\u0001\0", DEFAULT_USER_AGENT), UA_ALPHABET);
  const uaList = sm3(uaString);
  const dataList = sm3(sm3(`${body || ""}${salt}`));
  const timestamp2 = timestamp1 - 100;
  const timeInt = timestamp2 / 256 / 256 / 256 / 256;
  const pageId = 23756;
  const aid = 4272;
  const saltArray = [
    49,
    57,
    50,
    48,
    124,
    52,
    55,
    57,
    124,
    49,
    57,
    50,
    48,
    124,
    49,
    48,
    53,
    48,
    124,
    48,
    124,
    48,
    124,
    51,
    50,
    49,
    124,
    51,
    50,
    49,
    124,
    49,
    57,
    50,
    48,
    124,
    49,
    48,
    53,
    48,
    124,
    49,
    57,
    50,
    48,
    124,
    49,
    48,
    56,
    48,
    124,
    49,
    57,
    48,
    51,
    124,
    52,
    55,
    57,
    124,
    50,
    52,
    124,
    50,
    52,
    124,
    87,
    105,
    110,
    51,
    50
  ];
  const array1 = [
    44,
    (timestamp1 >> 24) & 255,
    0,
    0,
    0,
    0,
    16,
    paramsList[21],
    dataList[21],
    0,
    uaList[23],
    (timestamp1 >> 16) & 255,
    0,
    pageId >> 8,
    pageId & 255,
    1,
    0,
    aid & 255,
    paramsList[22],
    dataList[22],
    uaList[24],
    (timestamp1 >> 8) & 255,
    0,
    0,
    0,
    0,
    timestamp1 & 255,
    0,
    0,
    0,
    (timestamp2 >> 24) & 255,
    (timestamp2 >> 16) & 255,
    0,
    (timestamp2 >> 8) & 255,
    timestamp2 & 255,
    3,
    Math.floor(timeInt),
    Math.floor(timeInt / 256),
    Math.floor(timeInt),
    Math.floor(timeInt / 256),
    saltArray.length,
    0,
    0,
    0
  ];
  const array = array1.concat(saltArray);
  array.push(xorList(array1));
  const encrypted = rc4("y", String.fromCharCode.apply(null, array));
  return encodeOutput(`${randomBlockOne()}${randomBlockTwo()}${randomBlockThree()}${encrypted}`);
}

function randomFp() {
  let value = "";
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz".split("");
  for (let index = 0; index < 50; index += 1) {
    value += chars[Math.round(Math.random() * (chars.length - 1))];
  }
  return value;
}

function normalizeQuery(query = "") {
  return String(query || "").replace(/^[?&]+/, "");
}

function uniqueList(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function domainCandidates(domain = ".jinritemai.com") {
  return uniqueList([domain, ".jinritemai.com", ".bytedance.com"]);
}

function msTokenDomains(domain = ".jinritemai.com") {
  return uniqueList([".bytedance.com", domain, ".jinritemai.com"]);
}

function electronSession() {
  try {
    return require("electron").session;
  } catch {
    return null;
  }
}

async function readCookieValue(partition, name, domains) {
  const electronSessionApi = electronSession();
  if (!electronSessionApi || !partition || !name) return { value: "", source: "" };
  const targetSession = electronSessionApi.fromPartition(partition);
  for (const domain of domains) {
    try {
      const cookies = await targetSession.cookies.get({ domain });
      const found = cookies.find((cookie) => cookie?.name === name && cookie.value);
      if (found) return { value: found.value, source: found.domain || domain };
    } catch {}
  }
  return { value: "", source: "" };
}

async function signMstokenMyargs({ partition, targetUrl = "", adapter = {}, plan = {} } = {}) {
  const signQuery = normalizeQuery(plan.signQuery || plan.signQueryString || (() => {
    try {
      return new URL(targetUrl).search.slice(1);
    } catch {
      return "";
    }
  })());
  const signBody = plan.signBody === undefined || plan.signBody === null
    ? ""
    : (typeof plan.signBody === "string" ? plan.signBody : JSON.stringify(plan.signBody));
  const domain = String(plan.signDomain || adapter.cookieDomain || ".jinritemai.com");
  const fpCookie = await readCookieValue(partition, "s_v_web_id", domainCandidates(domain));
  const fp = fpCookie.value || randomFp();
  const msCookie = plan.readMsToken === false
    ? { value: "", source: "" }
    : await readCookieValue(partition, "msToken", msTokenDomains(domain));
  const msToken = msCookie.value || String(plan.signToken || plan.signFallbackToken || "");
  const baseQuery = `${signQuery}${signQuery ? "&" : ""}fp=${fp}&verifyFp=${fp}&msToken=${msToken}`;
  const aBogus = getABougsSign(baseQuery, signBody);
  if (!aBogus) {
    return {
      ok: false,
      reason: "empty-abogus",
      source: "xzb-local-mstoken",
      mode: "GetMstokenSign/GetABougsSign"
    };
  }
  return {
    ok: true,
    query: `${baseQuery}&a_bogus=${aBogus}`,
    myargs: `${baseQuery}&a_bogus=${aBogus}`,
    source: "xzb-local-mstoken",
    mode: "GetMstokenSign/GetABougsSign",
    fpSource: fpCookie.value ? fpCookie.source : "generated",
    msTokenSource: msCookie.value ? msCookie.source : "",
    hasMsToken: !!msToken
  };
}

module.exports = {
  DEFAULT_USER_AGENT,
  getABougsSign,
  signMstokenMyargs
};
