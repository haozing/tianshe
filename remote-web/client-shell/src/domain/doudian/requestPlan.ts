import type { DoudianAdapterConfig, DoudianAdapterPayload } from "../../types";
import JSONbigFactory from "json-bigint";
import { requireChihuNative } from "../../native/client";
import { signDoudianRequest } from "./signer";
import { XZB_SIGN_USER_AGENT } from "./xzbSigner";
import { detailedDoudianLoggingEnabled, reportDoudianDiagnostic } from "./diagnosticLog";
import { requestRetryDelayMs } from "./requestRetryPolicy";

const losslessJson = JSONbigFactory({ storeAsString: true });

export interface RequestPlanResult {
  ok: boolean;
  status: number;
  data: unknown;
  headers?: Record<string, unknown>;
  error?: string;
  source: string;
  url?: string;
  openUrl?: string;
  pageHref?: string;
  pageTitle?: string;
  nonRetryable?: boolean;
  signFailureReason?: string;
  requestCookieState?: Record<string, unknown>;
  requestDiagnostic?: Record<string, unknown>;
  attemptCount?: number;
  durationMs?: number;
}

function endpointUrl(adapter: DoudianAdapterConfig, endpoint: string) {
  return new URL(endpoint, adapter.origin).toString();
}

export function getPathValue(root: unknown, path: string): unknown {
  if (!path) return root;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current == null) return undefined;
    const match = key.match(/^([^\[]+)\[([^=\]]+)=([^\]]+)\]$/);
    if (match) {
      const [, arrayKey, filterKey, filterValue] = match;
      const value = getPathValue(current, arrayKey);
      if (!Array.isArray(value)) return undefined;
      return value.find((item) => String(getPathValue(item, filterKey)) === filterValue);
    }
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

export function firstPathValue(root: unknown, paths: string[] = []) {
  for (const path of paths) {
    const value = getPathValue(root, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function requestPlanResponseOk(response: RequestPlanResult | undefined, adapter: DoudianAdapterConfig, planKey: string, mappings: Record<string, unknown> = {}) {
  if (!response?.ok) return false;
  const plan = (adapter.requestPlans?.[planKey] || {}) as Record<string, unknown>;
  const failureMessages = [
    ...arrayText(plan.failureMessages),
    ...arrayText(plan.denyMessages)
  ];
  if (responseMatches(response, failureMessages)) return false;

  const successPaths = arrayText(plan.successPaths);
  const code = firstPathValue(response.data, ["code", "st", "status_code", "statusCode", "errno"]);
  const successCodes = [
    ...arrayText(mappings.successCodes),
    ...arrayText(plan.successCodes)
  ];
  const codeMatches = code != null && successCodes.length > 0 && successCodes.includes(String(code));
  if (codeMatches && plan.allowSuccessCodeOnly === true) return true;
  if (successPaths.length && !successPaths.some((path) => getPathValue(response.data, path) !== undefined)) return false;
  if (code != null && successCodes.length) return codeMatches;

  const successMessages = arrayText(plan.successMessages);
  if (successMessages.length && responseMatches(response, successMessages)) return true;
  if (successPaths.length) return successPaths.some((path) => getPathValue(response.data, path) !== undefined);
  if (code == null && successCodes.length && plan.allowMissingCode !== true) return false;
  return true;
}

export async function runDoudianRequestPlan(payload: DoudianAdapterPayload, args: {
  partition: string;
  planKey: string;
  headers?: Record<string, string>;
  context?: Record<string, unknown>;
  trackWindow?: (winId: number) => void;
  shouldCancel?: () => boolean;
}): Promise<RequestPlanResult> {
  const startedAt = Date.now();
  let attemptCount = 0;
  const finalize = (result: RequestPlanResult): RequestPlanResult => ({
    ...result,
    attemptCount,
    durationMs: Date.now() - startedAt
  });
  const adapter = payload.adapter;
  const plan = (adapter.requestPlans?.[args.planKey] || {}) as Record<string, unknown>;
  const endpointKey = typeof plan.endpointKey === "string" ? plan.endpointKey : args.planKey;
  const endpoint = adapter.endpoints[endpointKey];
  if (!endpoint) return finalize({ ok: false, status: 0, data: null, error: `missing endpoint: ${endpointKey}`, source: args.planKey });

  const context = args.context || {};
  const url = buildPlanUrl(adapter, endpoint, plan, context);
  if (plan.prepareBeforeRequest === true) {
    await prepareRequestPlanContext(args.partition, args.planKey, plan, adapter, context, url, args.trackWindow);
  }
  const runRequest = async (attempt: number | string = 0) => {
    attemptCount += 1;
    let result: RequestPlanResult;
    if (plan.requestMode === "page-fetch") {
      result = await pageFetchJson(args.partition, url, args.planKey, plan, context, args.trackWindow);
    } else {
      let requestUrl = url;
      if (plan.sign === true) {
        const sign = await signDoudianRequest(payload, {
          targetUrl: url,
          partition: args.partition,
          planKey: args.planKey,
          plan,
          context,
          trackWindow: args.trackWindow
        });
        if (sign.ok && sign.query) {
          const signedUrl = new URL(url);
          signedUrl.search = sign.query.startsWith("?") ? sign.query : `?${sign.query}`;
          requestUrl = signedUrl.toString();
        } else if (plan.pageFetchOnSignFailure === true) {
          result = await pageFetchJson(args.partition, url, args.planKey, plan, context, args.trackWindow);
          await reportPlanSummary(args.planKey, args.partition, attempt, result, adapter, plan);
          return result;
        } else {
          result = {
            ok: false,
            status: 0,
            data: null,
            error: `sign failed${sign.reason ? `: ${sign.reason}` : ""}`,
            source: args.planKey,
            url,
            nonRetryable: true,
            signFailureReason: sign.reason
          };
          await reportPlanSummary(args.planKey, args.partition, attempt, result, adapter, plan);
          return result;
        }
      }
      const headers = await buildRequestHeaders(adapter, args.partition, requestUrl, plan, args.headers, context);
      result = await requestJson(args.partition, requestUrl, headers, args.planKey, plan, context);
      if (headers.cookie) {
        result.requestCookieState = summarizeCookieHeader(headers.cookie);
      }
    }
    await reportPlanSummary(args.planKey, args.partition, attempt, result, adapter, plan);
    return result;
  };

  let response = await runRequest();
  if (response.nonRetryable) return finalize(response);
  const prepareMessages = arrayText(plan.prepareOnMessages);
  const prepareAttempts = Math.max(0, Math.min(3, Math.floor(Number(plan.prepareRetryAttempts || (prepareMessages.length ? 1 : 0)))));
  for (let attempt = 0; attempt < prepareAttempts && responseMatches(response, prepareMessages); attempt += 1) {
    if (args.shouldCancel?.()) break;
    await reportPlanRetry(args.planKey, args.partition, "prepare", attempt + 1, response);
    const delayMs = requestRetryDelayMs(plan, attempt + 1, "prepareRetryDelayMs", "prepareRetryBackoff", 0, response);
    if (delayMs) await delay(delayMs);
    if (args.shouldCancel?.()) break;
    await prepareRequestPlanContext(args.partition, args.planKey, plan, adapter, context, url, args.trackWindow);
    response = await runRequest(`prepare-${attempt + 1}`);
    if (response.nonRetryable) return finalize(response);
  }

  const maxAttempts = Math.max(1, Math.min(8, Math.floor(Number(plan.maxAttempts || 1))));
  if (plan.retryOnHttpError === true) {
    for (let attempt = 1; attempt < maxAttempts && responseHasHttpError(response); attempt += 1) {
      if (args.shouldCancel?.()) break;
      await reportPlanRetry(args.planKey, args.partition, "http", attempt, response);
      const delayMs = requestRetryDelayMs(plan, attempt, "retryDelayMs", "retryBackoff", 1000, response);
      if (delayMs) await delay(delayMs);
      if (args.shouldCancel?.()) break;
      response = await runRequest(attempt);
      if (response.nonRetryable) return finalize(response);
    }
  }

  if (plan.retryOnBusinessFailure === true) {
    for (let attempt = 1; attempt < maxAttempts && !requestPlanResponseOk(response, adapter, args.planKey); attempt += 1) {
      if (args.shouldCancel?.()) break;
      await reportPlanRetry(args.planKey, args.partition, "business", attempt, response);
      const delayMs = requestRetryDelayMs(plan, attempt, "retryDelayMs", "retryBackoff", 1000, response);
      if (delayMs) await delay(delayMs);
      if (args.shouldCancel?.()) break;
      response = await runRequest(`business-${attempt}`);
      if (response.nonRetryable) return finalize(response);
    }
  }

  return finalize(response);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, next]) => [key, String(next)]));
}

function hasHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function mergeCookieHeaders(values: string[]) {
  const cookies = new Map<string, string>();
  for (const value of values) {
    for (const item of String(value || "").split(";")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const name = trimmed.slice(0, index).trim();
      const cookieValue = trimmed.slice(index + 1).trim();
      if (!name) continue;
      if (!cookies.has(name)) cookies.set(name, cookieValue);
    }
  }
  return Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

function summarizeCookieHeader(cookieHeader: string | undefined) {
  const values = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const value of String(cookieHeader || "").split(";")) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const cookieValue = trimmed.slice(index + 1).trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
    if (!values.has(name)) values.set(name, cookieValue);
  }

  const luopanDt = values.get("LUOPAN_DT") || "";
  const msToken = values.get("msToken") || "";
  const sVWebId = values.get("s_v_web_id") || "";
  return {
    finalCookieNameCount: values.size,
    finalDuplicateCookieNames: Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name}:${count}`)
      .slice(0, 12),
    finalHasLuopanDt: !!luopanDt,
    finalLuopanDtLength: luopanDt.length,
    finalLuopanDtHash: luopanDt ? shortHash(luopanDt) : "",
    finalHasMsToken: !!msToken,
    finalMsTokenLength: msToken.length,
    finalHasSVWebId: !!sVWebId,
    finalSVWebIdLength: sVWebId.length
  };
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function responseMessages(response: RequestPlanResult): string[] {
  return [
    firstPathValue(response.data, ["msg", "message", "status_msg", "statusMessage"]),
    response.error
  ].map((item) => String(item || "")).filter(Boolean);
}

function responseMatches(response: RequestPlanResult, patterns: string[]) {
  const messages = responseMessages(response);
  return patterns.some((pattern) => pattern && messages.some((message) => message.includes(pattern)));
}

function responseCode(response: RequestPlanResult | undefined) {
  return firstPathValue(response?.data, ["code", "st", "status_code", "statusCode", "errno"]);
}

function responseMessage(response: RequestPlanResult | undefined) {
  return String(firstPathValue(response?.data, ["msg", "message", "status_msg", "statusMessage"]) || response?.error || "").slice(0, 240);
}

function responseHasHttpError(response: RequestPlanResult | undefined) {
  return Number(response?.status || 0) >= 400 || (Number(response?.status || 0) === 0 && !!response?.error);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function requestQueryKeys(url: string) {
  try {
    return Array.from(new URL(url).searchParams.keys()).sort();
  } catch {
    return [];
  }
}

function requestBodyKeys(body: unknown) {
  if (body == null) return [];
  const value = typeof body === "string"
    ? (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })()
    : body;
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

function requestDiagnostic(method: string, url: string, body: unknown) {
  const bodyText = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    method,
    requestQueryKeys: requestQueryKeys(url),
    requestBodyLength: bodyText.length,
    requestBodyHash: bodyText ? shortHash(bodyText) : "",
    requestBodyKeys: requestBodyKeys(body)
  };
}

function responseDataKeys(data: unknown) {
  return data && typeof data === "object" && !Array.isArray(data)
    ? Object.keys(data as Record<string, unknown>).sort().slice(0, 30)
    : [];
}

function redactDiagnosticText(value: string) {
  return value
    .replace(/([?&](?:a_bogus|msToken|verifyFp|fp)=)[^&\s"]*/gi, "$1[REDACTED]")
    .replace(/("(?:a_bogus|msToken|verifyFp|fp|cookie|token|sessionid)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/((?:a_bogus|msToken|verifyFp|fp|cookie|token|sessionid)\s*[:=]\s*)[^\s,;&"}]+/gi, "$1[REDACTED]");
}

function diagnosticText(value: unknown) {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return redactDiagnosticText(raw);
}

function responseDiagnostic(response: RequestPlanResult | undefined) {
  if (!response) return undefined;
  const dataText = diagnosticText(response.data);
  const errorText = diagnosticText(response.error);
  const combined = dataText || errorText;
  return {
    responseDataType: Array.isArray(response.data) ? "array" : response.data === null ? "null" : typeof response.data,
    responseDataKeys: responseDataKeys(response.data),
    responseDataLength: dataText.length,
    responseDataHash: dataText ? shortHash(dataText) : "",
    responseErrorLength: errorText.length,
    responseSnippet: combined.slice(0, 500)
  };
}

async function removePlanCookies(
  partition: string,
  planKey: string,
  plan: Record<string, unknown>,
  context: Record<string, unknown>,
  targetUrl: string,
  phase: string
) {
  const names = arrayText(plan.removeCookiesBeforePrepare || plan.clearCookiesBeforePrepare);
  if (!names.length) return;
  const native = requireChihuNative();
  if (!native.cookies.remove) return;
  const urls = [
    planWindowUrl(plan, targetUrl, context, ["prepareUrl", "signerUrl"]),
    targetUrl,
    ...arrayText(plan.cookieRemoveUrls).map((url) => interpolate(url, context))
  ].filter(Boolean);
  const seen = new Set<string>();
  let removed = 0;
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const result = await native.cookies.remove({
      partition,
      url,
      names
    }).catch(() => null) as { removed?: number } | null;
    removed += Number(result?.removed || 0);
  }
  if (removed > 0) {
    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "cookies-removed",
      planKey,
      partition,
      phase,
      names,
      removed
    });
  }
}

async function requestPlanCookieState(partition: string, planKey: string) {
  if (planKey !== "businessCoreIndex") return {};
  const native = requireChihuNative();
  const names = ["LUOPAN_DT", "msToken", "s_v_web_id"];
  const candidates = [
    { url: "https://compass.jinritemai.com/shop" },
    { domain: ".jinritemai.com" },
    { domain: ".bytedance.com" }
  ];
  const values = new Map<string, string>();

  for (const candidate of candidates) {
    const result = await native.cookies.getHeader({
      partition,
      names,
      ...candidate
    }).catch(() => null);
    for (const cookie of result?.cookies || []) {
      if (cookie?.name && cookie?.value && !values.has(cookie.name)) values.set(cookie.name, cookie.value);
    }
  }

  const luopanDt = values.get("LUOPAN_DT") || "";
  const msToken = values.get("msToken") || "";
  const sVWebId = values.get("s_v_web_id") || "";
  return {
    cookieState: {
      hasLuopanDt: !!luopanDt,
      luopanDtLength: luopanDt.length,
      luopanDtHash: luopanDt ? shortHash(luopanDt) : "",
      hasMsToken: !!msToken,
      msTokenLength: msToken.length,
      hasSVWebId: !!sVWebId,
      sVWebIdLength: sVWebId.length
    }
  };
}

function hasBadUrlToken(value: string) {
  return /[{}]/.test(value) || /(^|[/?#=&])(?:undefined|null)(?=$|[/?#=&])/.test(value);
}

function fallbackWindowUrl(targetUrl: string) {
  try {
    const target = new URL(targetUrl);
    return `${target.origin}/`;
  } catch {
    return "";
  }
}

function normalizeWindowUrl(value: unknown, context: Record<string, unknown>, targetUrl: string) {
  const raw = typeof value === "string" ? interpolate(value, context).trim() : "";
  if (!raw || hasBadUrlToken(raw)) return "";
  try {
    const base = fallbackWindowUrl(targetUrl) || undefined;
    const normalized = new URL(raw, base).toString();
    return hasBadUrlToken(normalized) ? "" : normalized;
  } catch {
    return "";
  }
}

function planWindowUrl(
  plan: Record<string, unknown>,
  targetUrl: string,
  context: Record<string, unknown>,
  keys: string[] = ["signerUrl", "prepareUrl"]
) {
  for (const key of keys) {
    const candidate = normalizeWindowUrl(plan[key], context, targetUrl);
    if (candidate) return candidate;
  }
  return fallbackWindowUrl(targetUrl) || targetUrl;
}

async function buildRequestHeaders(
  adapter: DoudianAdapterConfig,
  partition: string,
  url: string,
  plan: Record<string, unknown>,
  extraHeaders: Record<string, string> | undefined,
  context: Record<string, unknown>
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    ...stringRecord(plan.headers),
    ...(extraHeaders || {})
  };
  if (typeof plan.referer === "string") headers.referer = interpolate(plan.referer, context);
  if (plan.signStrategy === "mstoken-myargs" && !hasHeader(headers, "user-agent")) {
    const userAgent = typeof plan.userAgent === "string" ? interpolate(plan.userAgent, context).trim() : "";
    headers["User-Agent"] = userAgent || XZB_SIGN_USER_AGENT;
  }
  const cookieHeaderValues: string[] = [];
  const urlCookieHeader = await requireChihuNative().cookies.getHeader({
    partition,
    url
  });
  if (urlCookieHeader.cookieHeader) cookieHeaderValues.push(urlCookieHeader.cookieHeader);

  if (adapter.cookieDomain) {
    const domainCookieHeader = await requireChihuNative().cookies.getHeader({
      partition,
      domain: adapter.cookieDomain
    }).catch(() => null);
    if (domainCookieHeader?.cookieHeader) cookieHeaderValues.push(domainCookieHeader.cookieHeader);
  }

  for (const cookieUrl of arrayText(plan.cookieUrls)) {
    const extra = await requireChihuNative().cookies.getHeader({
      partition,
      url: interpolate(cookieUrl, context)
    }).catch(() => null);
    if (extra?.cookieHeader) cookieHeaderValues.push(extra.cookieHeader);
  }
  for (const cookieDomain of arrayText(plan.cookieDomains)) {
    const extra = await requireChihuNative().cookies.getHeader({
      partition,
      domain: interpolate(cookieDomain, context)
    }).catch(() => null);
    if (extra?.cookieHeader) cookieHeaderValues.push(extra.cookieHeader);
  }

  const mergedCookieHeader = mergeCookieHeaders(cookieHeaderValues);
  if (mergedCookieHeader) headers.cookie = mergedCookieHeader;
  return headers;
}

async function prepareRequestPlanContext(
  partition: string,
  planKey: string,
  plan: Record<string, unknown>,
  adapter: DoudianAdapterConfig,
  context: Record<string, unknown>,
  fallbackUrl: string,
  trackWindow?: (winId: number) => void
) {
  const prepareUrl = planWindowUrl(plan, fallbackUrl, context, ["prepareUrl", "signerUrl"]);
  if (!prepareUrl) return false;
  const native = requireChihuNative();
  let winId: number | null = null;
  try {
    await removePlanCookies(partition, planKey, plan, context, fallbackUrl, "before-prepare");
    winId = await native.windows.open({
      url: prepareUrl,
      partition,
      show: false,
      waitForLoad: false,
      width: 480,
      height: 360,
      title: "Chihu Doudian Prepare",
      nodeIntegration: false,
      contextIsolation: true
    });
    trackWindow?.(winId);
    const waitMs = Math.max(0, Number(plan.prepareWaitMs || adapter.timeouts?.loadMs || 0));
    if (waitMs) await delay(waitMs);
    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "prepared",
      planKey,
      partition,
      openUrl: prepareUrl,
      targetUrl: prepareUrl
    });
    return true;
  } catch (error) {
    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "prepare-failed",
      planKey,
      partition,
      openUrl: prepareUrl,
      targetUrl: prepareUrl,
      message: error instanceof Error ? error.message : String(error)
    }, true);
    return false;
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}

async function reportPlanSummary(
  planKey: string,
  partition: string,
  attempt: number | string,
  response: RequestPlanResult,
  adapter: DoudianAdapterConfig,
  plan: Record<string, unknown>
) {
  const successPaths = arrayText(plan.successPaths);
  const hasSuccessPath = successPaths.some((path) => getPathValue(response.data, path) !== undefined);
  const contractOk = requestPlanResponseOk(response, adapter, planKey);
  const alwaysReport = !contractOk || responseHasHttpError(response);
  if (!alwaysReport && !detailedDoudianLoggingEnabled()) return;
  const cookieState = await requestPlanCookieState(partition, planKey);
  const shouldReportResponseDiagnostic = responseHasHttpError(response) || !contractOk;
  await reportDoudianDiagnostic({
    category: "doudian-request-plan",
    event: "result",
    planKey,
    partition,
    attempt,
    requestMode: String(plan.requestMode || "native-http"),
    status: response.status,
    httpOk: response.ok,
    contractOk,
    code: responseCode(response) ?? null,
    message: responseMessage(response),
    hasSuccessPath,
    targetUrl: response.url,
    openUrl: response.openUrl,
    pageHref: response.pageHref,
    pageTitle: response.pageTitle,
    ...(response.requestDiagnostic ? { requestDiagnostic: response.requestDiagnostic } : {}),
    ...(shouldReportResponseDiagnostic ? { responseDiagnostic: responseDiagnostic(response) } : {}),
    ...(response.requestCookieState ? { requestCookieState: response.requestCookieState } : {}),
    ...(response.nonRetryable ? { nonRetryable: true } : {}),
    ...(response.signFailureReason ? { signFailureReason: response.signFailureReason } : {}),
    ...cookieState
  }, alwaysReport);
}

async function reportPlanRetry(planKey: string, partition: string, kind: string, attempt: number, response: RequestPlanResult) {
  await reportDoudianDiagnostic({
    category: "doudian-request-plan",
    event: "retry",
    planKey,
    partition,
    kind,
    attempt,
    status: response.status,
    code: responseCode(response) ?? null,
    message: responseMessage(response),
    targetUrl: response.url,
    openUrl: response.openUrl,
    pageHref: response.pageHref,
    pageTitle: response.pageTitle,
    ...(response.nonRetryable ? { nonRetryable: true } : {}),
    ...(response.signFailureReason ? { signFailureReason: response.signFailureReason } : {})
  }, true);
}

function interpolate(value: unknown, context: Record<string, unknown>): string {
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

function buildPlanUrl(adapter: DoudianAdapterConfig, endpoint: string, plan: Record<string, unknown>, context: Record<string, unknown>) {
  const origin = typeof plan.origin === "string" && plan.origin ? plan.origin : adapter.origin;
  const url = new URL(interpolate(endpoint, context), origin);
  const rawQuery = typeof plan.rawQuery === "string" ? interpolate(plan.rawQuery, context) : "";
  if (rawQuery) {
    const params = new URLSearchParams(rawQuery);
    params.forEach((value, key) => url.searchParams.set(key, value));
  }
  const query = interpolateDeep(plan.query, context);
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      url.searchParams.set(key, String(value ?? ""));
    }
  }
  return url.toString();
}

async function requestJson(partition: string, url: string, headers: Record<string, string>, source: string, plan: Record<string, unknown> = {}, context: Record<string, unknown> = {}): Promise<RequestPlanResult> {
  const method = String(plan.method || "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  const body = method === "GET" ? undefined : interpolateDeep(plan.body, context);
  const responseType = plan.responseType === "base64" || plan.responseType === "arrayBuffer" || plan.responseType === "text" || plan.responseType === "losslessJson"
    ? plan.responseType
    : "losslessJson";
  const response = await requireChihuNative().http.request({
    partition,
    url,
    method,
    headers,
    body,
    responseType,
    timeoutMs: 15000
  });
  const result = response as { ok?: boolean; status?: number; headers?: Record<string, unknown>; data?: unknown; error?: { message?: string } | string };
  return {
    ok: result.ok === true,
    status: Number(result.status || 0),
    headers: result.headers || {},
    data: result.data ?? null,
    error: typeof result.error === "string" ? result.error : result.error?.message || "",
    source,
    url,
    requestDiagnostic: requestDiagnostic(method, url, body)
  };
}

async function pageFetchJson(partition: string, url: string, source: string, plan: Record<string, unknown> = {}, context: Record<string, unknown> = {}, trackWindow?: (winId: number) => void): Promise<RequestPlanResult> {
  const native = requireChihuNative();
  const method = String(plan.method || "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  const body = method === "GET" ? undefined : interpolateDeep(plan.body, context);
  const timeoutMs = Math.max(1000, Number(plan.pageFetchTimeoutMs || plan.timeoutMs || 15000));
  const headers = {
    accept: "application/json, text/plain, */*",
    ...stringRecord(plan.headers)
  };
  let winId: number | null = null;
  const openUrl = planWindowUrl(plan, url, context);
  try {
    winId = await native.windows.open({
      url: openUrl,
      partition,
      show: false,
      waitForLoad: false,
      width: 480,
      height: 360,
      title: "Chihu Doudian Page Fetch",
      nodeIntegration: false,
      contextIsolation: true
    });
    trackWindow?.(winId);
    const bootWaitMs = Math.max(0, Number(plan.pageFetchBootWaitMs ?? 800));
    if (bootWaitMs) await delay(bootWaitMs);
    const code = `
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ${JSON.stringify(timeoutMs)});
        try {
          const init = {
            method: ${JSON.stringify(method)},
            credentials: "include",
            headers: ${JSON.stringify(headers)},
            signal: controller.signal
          };
          const body = ${JSON.stringify(body === undefined ? null : body)};
          if (body !== null && init.method !== "GET" && init.method !== "HEAD") {
            init.body = typeof body === "string" ? body : JSON.stringify(body);
          }
          const response = await fetch(${JSON.stringify(url)}, init);
          const text = await response.text();
          return {
            ok: response.ok,
            status: response.status,
            url: response.url || ${JSON.stringify(url)},
            pageHref: location.href,
            pageTitle: document.title,
            text,
            error: response.ok ? "" : text.slice(0, 240)
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            url: ${JSON.stringify(url)},
            pageHref: location.href,
            pageTitle: document.title,
            data: null,
            error: error && error.message ? error.message : String(error)
          };
        } finally {
          clearTimeout(timer);
        }
      })();
    `;
    const result = await native.windows.eval({ winId, code, timeoutMs: timeoutMs + 2000 }) as { ok?: boolean; status?: number; url?: string; pageHref?: string; pageTitle?: string; text?: string; data?: unknown; error?: string } | null;
    if (!result) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: "page fetch eval returned no result",
        source,
        url,
        openUrl,
        requestDiagnostic: requestDiagnostic(method, url, body)
      };
    }
    let data = result.text ?? result.data ?? null;
    if (typeof result.text === "string" && plan.responseType !== "text") {
      try {
        data = losslessJson.parse(result.text);
      } catch (error) {
        return {
          ok: false,
          status: Number(result.status || 0),
          data: null,
          error: `invalid lossless JSON response: ${error instanceof Error ? error.message : String(error)}`,
          source,
          url: String(result.url || url),
          openUrl,
          pageHref: String(result.pageHref || ""),
          pageTitle: String(result.pageTitle || ""),
          requestDiagnostic: requestDiagnostic(method, url, body)
        };
      }
    }
    return {
      ok: result?.ok === true,
      status: Number(result?.status || 0),
      data,
      error: String(result?.error || ""),
      source,
      url: String(result?.url || url),
      openUrl,
      pageHref: String(result?.pageHref || ""),
      pageTitle: String(result?.pageTitle || ""),
      requestDiagnostic: requestDiagnostic(method, url, body)
    };
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}
