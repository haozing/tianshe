const { ipcMain } = require("electron");

const JIEBA_TOKENIZER_VERSION = "@node-rs/jieba-2.0.1-chihu-v1";
const FALLBACK_TOKENIZER_VERSION = "native-rule-segmenter-v1";
const DEFAULT_STOPWORD_VERSION = "chihu-stopwords-v1";
const MAX_TEXTS = 500;
const MAX_TOTAL_CHARS = 200000;
let jiebaState = null;

const STOPWORDS = new Set([
  "\u7684",
  "\u4e86",
  "\u548c",
  "\u4e0e",
  "\u53ca",
  "\u6216",
  "\u662f",
  "\u5728",
  "\u5bf9",
  "\u4e3a",
  "\u4e2d",
  "\u4e0a",
  "\u4e0b",
  "\u6b3e",
  "\u578b",
  "and",
  "or",
  "the",
  "for",
  "with"
]);

function loadJieba() {
  if (jiebaState) return jiebaState;
  try {
    const { Jieba } = require("@node-rs/jieba");
    const { dict } = require("@node-rs/jieba/dict");
    jiebaState = { jieba: Jieba.withDict(dict), error: "" };
  } catch (error) {
    jiebaState = {
      jieba: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return jiebaState;
}

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .trim();
}

function meaningfulToken(value, minTokenLength) {
  const token = normalizeToken(value);
  if (!token) return "";
  if (token.length < minTokenLength) return "";
  if (STOPWORDS.has(token)) return "";
  if (/^\d+$/u.test(token)) return "";
  if (/^[\p{P}\p{S}]+$/u.test(token)) return "";
  return token;
}

function fallbackSegments(text) {
  const segments = [];
  for (const match of String(text).matchAll(/[\p{Script=Han}]+|[a-zA-Z0-9]+/gu)) {
    const value = match[0];
    if (/^[\p{Script=Han}]+$/u.test(value) && value.length > 6) {
      for (let index = 0; index < value.length - 1; index += 1) {
        segments.push(value.slice(index, index + 2));
      }
    } else {
      segments.push(value);
    }
  }
  return segments;
}

function ruleSegments(text, mode) {
  const rawSegments = [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    for (const segment of segmenter.segment(String(text || ""))) {
      if (segment.isWordLike || mode === "search") rawSegments.push(segment.segment);
    }
  }
  if (!rawSegments.length) rawSegments.push(...fallbackSegments(text));
  return rawSegments;
}

function segmentOne(text, mode, minTokenLength) {
  const source = String(text || "");
  const state = loadJieba();
  let rawSegments = [];
  let tokenizerFallback = !state.jieba;
  let fallbackReason = state.error || "";
  if (state.jieba) {
    try {
      rawSegments = mode === "search" && typeof state.jieba.cutForSearch === "function"
        ? state.jieba.cutForSearch(source, false)
        : state.jieba.cut(source, false);
    } catch (error) {
      tokenizerFallback = true;
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!rawSegments.length && !source.trim()) {
    return {
      source,
      tokens: [],
      tokenizerFallback: false,
      fallbackReason: ""
    };
  }
  if (!rawSegments.length) {
    tokenizerFallback = true;
    fallbackReason = fallbackReason || "jieba produced no segments";
    rawSegments = ruleSegments(source, mode);
  }
  const tokens = [];
  const seen = new Set();
  for (const raw of rawSegments) {
    const token = meaningfulToken(raw, minTokenLength);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return {
    source,
    tokens,
    tokenizerFallback,
    fallbackReason
  };
}

function normalizePayload(payload) {
  const record = payload && typeof payload === "object" ? payload : {};
  const texts = Array.isArray(record.texts) ? record.texts.map((item) => String(item || "")) : [];
  const totalChars = texts.reduce((sum, item) => sum + item.length, 0);
  if (texts.length > MAX_TEXTS) throw new Error(`native text segment supports at most ${MAX_TEXTS} texts`);
  if (totalChars > MAX_TOTAL_CHARS) throw new Error(`native text segment supports at most ${MAX_TOTAL_CHARS} characters`);
  const minTokenLength = Math.max(1, Math.min(16, Math.floor(Number(record.minTokenLength || 2))));
  return {
    texts,
    mode: record.mode === "search" ? "search" : "default",
    stopwordVersion: String(record.stopwordVersion || DEFAULT_STOPWORD_VERSION),
    minTokenLength
  };
}

function registerTextSegmentationHandlers() {
  ipcMain.handle("native:text:segment", async (_event, payload = {}) => {
    const request = normalizePayload(payload);
    const items = request.texts.map((source) => segmentOne(source, request.mode, request.minTokenLength));
    const tokenizerFallback = items.some((item) => item.tokenizerFallback);
    return {
      tokenizerVersion: tokenizerFallback ? FALLBACK_TOKENIZER_VERSION : JIEBA_TOKENIZER_VERSION,
      stopwordVersion: request.stopwordVersion,
      tokenizerFallback,
      fallbackReason: tokenizerFallback ? items.find((item) => item.fallbackReason)?.fallbackReason || "jieba fallback" : "",
      items: items.map((item) => ({
        source: item.source,
        tokens: item.tokens
      }))
    };
  });
}

module.exports = { registerTextSegmentationHandlers };
