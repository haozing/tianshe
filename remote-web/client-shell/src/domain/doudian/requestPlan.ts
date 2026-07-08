import type { DoudianAdapterConfig, DoudianAdapterPayload } from "../../types";
import { requireChihuNative } from "../../native/client";
import { signDoudianRequest } from "./signer";

export interface RequestPlanResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
  source: string;
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
}): Promise<RequestPlanResult> {
  const adapter = payload.adapter;
  const plan = (adapter.requestPlans?.[args.planKey] || {}) as Record<string, unknown>;
  const endpointKey = typeof plan.endpointKey === "string" ? plan.endpointKey : args.planKey;
  const endpoint = adapter.endpoints[endpointKey];
  if (!endpoint) return { ok: false, status: 0, data: null, error: `missing endpoint: ${endpointKey}`, source: args.planKey };

  const url = buildPlanUrl(adapter, endpoint, plan, args.context || {});
  if (plan.requestMode === "page-fetch") {
    return pageFetchJson(args.partition, url, args.planKey, plan, args.context || {});
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    ...stringRecord(plan.headers),
    ...(args.headers || {})
  };
  if (typeof plan.referer === "string") headers.referer = interpolate(plan.referer, args.context || {});
  const cookieHeader = await requireChihuNative().cookies.getHeader({
    partition: args.partition,
    url,
    domain: adapter.cookieDomain
  });
  if (cookieHeader.cookieHeader) headers.cookie = cookieHeader.cookieHeader;

  if (plan.sign === true) {
    const sign = await signDoudianRequest(payload, {
      targetUrl: url,
      partition: args.partition,
      plan,
      context: args.context
    });
    if (sign.ok && sign.query) {
      const signedUrl = new URL(url);
      signedUrl.search = sign.query.startsWith("?") ? sign.query : `?${sign.query}`;
      return requestJson(args.partition, signedUrl.toString(), headers, args.planKey, plan, args.context || {});
    }
    if (plan.pageFetchOnSignFailure === true) {
      return pageFetchJson(args.partition, url, args.planKey, plan, args.context || {});
    }
  }

  return requestJson(args.partition, url, headers, args.planKey, plan, args.context || {});
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, next]) => [key, String(next)]));
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

function interpolate(value: unknown, context: Record<string, unknown>): string {
  return String(value ?? "").replace(/\{([^}]+)\}/g, (_match, key) => String(context[key] ?? ""));
}

function interpolateDeep(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolate(value, context);
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
  const response = await requireChihuNative().http.request({
    partition,
    url,
    method,
    headers,
    body,
    responseType: "json",
    timeoutMs: 15000
  });
  const result = response as { ok?: boolean; status?: number; data?: unknown; error?: { message?: string } };
  return {
    ok: result.ok === true,
    status: Number(result.status || 0),
    data: result.data ?? null,
    error: result.error?.message || "",
    source
  };
}

async function pageFetchJson(partition: string, url: string, source: string, plan: Record<string, unknown> = {}, context: Record<string, unknown> = {}): Promise<RequestPlanResult> {
  const native = requireChihuNative();
  const method = String(plan.method || "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  const body = method === "GET" ? undefined : interpolateDeep(plan.body, context);
  const timeoutMs = Math.max(1000, Number(plan.pageFetchTimeoutMs || plan.timeoutMs || 15000));
  const headers = {
    accept: "application/json, text/plain, */*",
    ...stringRecord(plan.headers)
  };
  let winId: number | null = null;
  try {
    winId = await native.windows.open({
      url: String(plan.signerUrl || plan.prepareUrl || url),
      partition,
      show: false,
      waitForLoad: true,
      width: 480,
      height: 360,
      title: "Chihu Doudian Page Fetch",
      nodeIntegration: false,
      contextIsolation: true
    });
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
          let data = text;
          try { data = JSON.parse(text); } catch {}
          return { ok: response.ok, status: response.status, data, error: response.ok ? "" : text.slice(0, 240) };
        } catch (error) {
          return { ok: false, status: 0, data: null, error: error && error.message ? error.message : String(error) };
        } finally {
          clearTimeout(timer);
        }
      })();
    `;
    const result = await native.windows.eval({ winId, code, timeoutMs: timeoutMs + 2000 }) as { ok?: boolean; status?: number; data?: unknown; error?: string };
    return {
      ok: result?.ok === true,
      status: Number(result?.status || 0),
      data: result?.data ?? null,
      error: String(result?.error || ""),
      source
    };
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}
