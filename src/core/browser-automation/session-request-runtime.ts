import type {
  BrowserSessionRequestOptions,
  BrowserSessionRequestResponse,
} from '../../types/browser-interface';

export const DEFAULT_BROWSER_SESSION_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_SESSION_REQUEST_MAX_RESPONSE_BYTES = 2_000_000;

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'x-requested-with',
]);

const DANGEROUS_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'set-cookie',
  'user-agent',
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'location',
  'retry-after',
  'x-request-id',
]);

const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10_000_000;

type EvaluateWithArgs = <T>(
  pageFunction: (...args: unknown[]) => T | Promise<T>,
  ...args: unknown[]
) => Promise<T>;

export class BrowserSessionRequestRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'invalid_url'
      | 'dangerous_header'
      | 'timeout'
      | 'network'
      | 'redirect'
      | 'response_too_large'
      | 'aborted',
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BrowserSessionRequestRuntimeError';
  }
}

const normalizeHeaderName = (name: string): string => name.trim().toLowerCase();

export function sanitizeBrowserSessionRequestHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = normalizeHeaderName(rawName);
    if (!name) {
      continue;
    }
    if (DANGEROUS_REQUEST_HEADERS.has(name) || !REQUEST_HEADER_ALLOWLIST.has(name)) {
      throw new BrowserSessionRequestRuntimeError(
        'dangerous_header',
        `Request header is not allowed for browser session requests: ${rawName}`,
        { header: rawName }
      );
    }
    result[name] = String(rawValue);
  }
  return result;
}

export function redactBrowserSessionResponseHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = normalizeHeaderName(rawName);
    if (!name || !RESPONSE_HEADER_ALLOWLIST.has(name)) {
      continue;
    }
    result[name] = String(rawValue);
  }
  return result;
}

function normalizeTimeoutMs(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_BROWSER_SESSION_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(Number(timeoutMs))));
}

function normalizeMaxResponseBytes(maxResponseBytes?: number): number {
  if (!Number.isFinite(maxResponseBytes)) {
    return DEFAULT_BROWSER_SESSION_REQUEST_MAX_RESPONSE_BYTES;
  }
  return Math.max(0, Math.min(MAX_RESPONSE_BYTES, Math.trunc(Number(maxResponseBytes))));
}

function normalizeMethod(method?: string): BrowserSessionRequestOptions['method'] {
  const normalized = String(method || 'GET').toUpperCase();
  switch (normalized) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
    case 'OPTIONS':
      return normalized;
    default:
      throw new BrowserSessionRequestRuntimeError(
        'network',
        `Unsupported browser session request method: ${method}`
      );
  }
}

function normalizeRequestOptions(
  options: BrowserSessionRequestOptions
): Omit<BrowserSessionRequestOptions, 'signal'> & {
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
} {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new BrowserSessionRequestRuntimeError(
      'invalid_url',
      `Invalid browser session request URL: ${options.url}`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserSessionRequestRuntimeError(
      'invalid_url',
      `Unsupported browser session request URL protocol: ${url.protocol}`
    );
  }

  const method = normalizeMethod(options.method);
  if ((method === 'GET' || method === 'HEAD') && options.body) {
    throw new BrowserSessionRequestRuntimeError(
      'network',
      `${method} browser session requests cannot include a body`
    );
  }

  return {
    url: url.toString(),
    method,
    headers: sanitizeBrowserSessionRequestHeaders(options.headers),
    body: options.body ?? null,
    timeoutMs: normalizeTimeoutMs(options.timeoutMs),
    maxResponseBytes: normalizeMaxResponseBytes(options.maxResponseBytes),
    redirect: options.redirect ?? 'error',
  };
}

function isAbortError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return name === 'AbortError' || message.includes('aborted');
}

function mapRuntimeError(error: unknown): BrowserSessionRequestRuntimeError {
  if (error instanceof BrowserSessionRequestRuntimeError) {
    return error;
  }
  const message = String(error instanceof Error ? error.message : error || '').trim();
  const lower = message.toLowerCase();
  if (isAbortError(error)) {
    return new BrowserSessionRequestRuntimeError(
      'aborted',
      message || 'Browser session request aborted'
    );
  }
  if (lower.includes('timeout')) {
    return new BrowserSessionRequestRuntimeError(
      'timeout',
      message || 'Browser session request timed out'
    );
  }
  if (lower.includes('redirect')) {
    return new BrowserSessionRequestRuntimeError(
      'redirect',
      message || 'Browser session request redirect was blocked'
    );
  }
  if (lower.includes('too_large') || lower.includes('too large')) {
    return new BrowserSessionRequestRuntimeError(
      'response_too_large',
      message || 'Browser session request response is too large'
    );
  }
  return new BrowserSessionRequestRuntimeError(
    'network',
    message || 'Browser session request failed'
  );
}

function assertSessionRequestResponse(value: unknown): BrowserSessionRequestResponse {
  if (!value || typeof value !== 'object') {
    throw new BrowserSessionRequestRuntimeError(
      'network',
      'Browser session request returned an invalid response'
    );
  }
  const response = value as Partial<BrowserSessionRequestResponse>;
  return {
    url: String(response.url || ''),
    status: Number(response.status || 0),
    statusText: String(response.statusText || ''),
    ok: Boolean(response.ok),
    redirected: Boolean(response.redirected),
    headers: redactBrowserSessionResponseHeaders(response.headers),
    bodyEncoding:
      response.bodyEncoding === 'base64' || response.bodyEncoding === 'empty'
        ? response.bodyEncoding
        : 'text',
    ...(typeof response.bodyText === 'string' ? { bodyText: response.bodyText } : {}),
    ...(typeof response.bodyBase64 === 'string' ? { bodyBase64: response.bodyBase64 } : {}),
    mimeType: typeof response.mimeType === 'string' ? response.mimeType : null,
    byteLength: Math.max(0, Number(response.byteLength || 0)),
  };
}

function createAbortListener(
  signal: AbortSignal | undefined,
  reject: (reason?: unknown) => void
): (() => void) | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    reject(
      new BrowserSessionRequestRuntimeError(
        'aborted',
        'Browser session request aborted before dispatch'
      )
    );
    return undefined;
  }
  const listener = () => {
    reject(new BrowserSessionRequestRuntimeError('aborted', 'Browser session request aborted'));
  };
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

export async function runBrowserSessionRequest(
  evaluateWithArgs: EvaluateWithArgs,
  options: BrowserSessionRequestOptions
): Promise<BrowserSessionRequestResponse> {
  const normalized = normalizeRequestOptions(options);

  return new Promise<BrowserSessionRequestResponse>((resolve, reject) => {
    let settled = false;
    let cleanupAbort: (() => void) | undefined;
    const settle = (
      type: 'resolve' | 'reject',
      value: BrowserSessionRequestResponse | BrowserSessionRequestRuntimeError
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanupAbort?.();
      if (type === 'resolve') {
        resolve(value as BrowserSessionRequestResponse);
      } else {
        reject(value);
      }
    };
    const timer = setTimeout(() => {
      settle(
        'reject',
        new BrowserSessionRequestRuntimeError(
          'timeout',
          `Browser session request timed out after ${normalized.timeoutMs}ms`
        )
      );
    }, normalized.timeoutMs);

    cleanupAbort = createAbortListener(options.signal, (reason) => {
      settle('reject', mapRuntimeError(reason));
    });
    if (settled) {
      return;
    }

    evaluateWithArgs<BrowserSessionRequestResponse>(
      async (requestOptions) => {
        const normalizedOptions = requestOptions as {
          url: string;
          method: string;
          headers: Record<string, string>;
          body: string | null;
          maxResponseBytes: number;
          timeoutMs: number;
          redirect: RequestRedirect;
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), normalizedOptions.timeoutMs);
        try {
          const response = await fetch(normalizedOptions.url, {
            method: normalizedOptions.method,
            headers: normalizedOptions.headers,
            body: normalizedOptions.body ?? undefined,
            credentials: 'include',
            redirect: normalizedOptions.redirect,
            signal: controller.signal,
          });

          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
          });

          const arrayBuffer = await response.arrayBuffer();
          const byteLength = arrayBuffer.byteLength;
          if (byteLength > normalizedOptions.maxResponseBytes) {
            throw new Error('response_too_large');
          }

          const mimeType = response.headers.get('content-type');
          if (byteLength === 0) {
            return {
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              redirected: response.redirected,
              headers,
              bodyEncoding: 'empty',
              mimeType,
              byteLength,
            };
          }

          const contentType = (mimeType || '').toLowerCase();
          const isText =
            contentType.startsWith('text/') ||
            contentType.includes('json') ||
            contentType.includes('xml') ||
            contentType.includes('javascript') ||
            contentType.includes('x-www-form-urlencoded');

          if (isText) {
            return {
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              redirected: response.redirected,
              headers,
              bodyEncoding: 'text',
              bodyText: new TextDecoder().decode(arrayBuffer),
              mimeType,
              byteLength,
            };
          }

          let binary = '';
          for (const byte of new Uint8Array(arrayBuffer)) {
            binary += String.fromCharCode(byte);
          }
          return {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            redirected: response.redirected,
            headers,
            bodyEncoding: 'base64',
            bodyBase64: btoa(binary),
            mimeType,
            byteLength,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      normalized
    )
      .then((response) => {
        if (response.byteLength > normalized.maxResponseBytes) {
          throw new BrowserSessionRequestRuntimeError(
            'response_too_large',
            `Browser session request response exceeded ${normalized.maxResponseBytes} bytes`
          );
        }
        settle('resolve', assertSessionRequestResponse(response));
      })
      .catch((error) => {
        settle('reject', mapRuntimeError(error));
      });
  });
}
