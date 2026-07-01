import type {
  BrowserCapabilityName,
  BrowserInterface,
  BrowserSessionRequestOptions,
  BrowserSessionRequestCapability,
  BrowserSessionRequestResponse,
} from '../../types/browser-interface';
import {
  hasBrowserSessionRequestCapability,
} from '../../types/browser-interface';
import {
  DEFAULT_BROWSER_SESSION_REQUEST_MAX_RESPONSE_BYTES,
  BrowserSessionRequestRuntimeError,
  redactBrowserSessionResponseHeaders,
  sanitizeBrowserSessionRequestHeaders,
} from '../browser-automation/session-request-runtime';

export type ProfileSessionGatewayIntent = 'read' | 'write';

export type ProfileSessionGatewayErrorCode =
  | 'invalid_url'
  | 'url_scope_denied'
  | 'dangerous_header'
  | 'unsupported_runtime'
  | 'write_intent_denied'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'response_too_large'
  | 'aborted';

export class ProfileSessionGatewayError extends Error {
  constructor(
    public readonly code: ProfileSessionGatewayErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProfileSessionGatewayError';
  }
}

export interface ProfileSessionGatewayExecutionContext {
  capability?: string;
  confirmed?: boolean;
  scopes?: readonly string[];
}

export interface ProfileSessionGatewayWithSessionOptions {
  profileId: string;
  site: string;
  pluginId?: string;
  intent?: ProfileSessionGatewayIntent;
  requiredCapabilities?: readonly BrowserCapabilityName[];
  allowedOrigins?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  executionContext?: ProfileSessionGatewayExecutionContext;
}

export interface ProfileSessionGatewayRequestOptions extends BrowserSessionRequestOptions {
  allowedOrigins?: readonly string[];
}

export interface ProfileSession {
  readonly profileId: string;
  readonly site: string;
  readonly browser: BrowserInterface;
  request(options: ProfileSessionGatewayRequestOptions): Promise<BrowserSessionRequestResponse>;
}

export interface ProfileSessionGatewayAcquireOptions {
  profileId: string;
  pluginId?: string;
  requiredCapabilities: readonly BrowserCapabilityName[];
  intent: ProfileSessionGatewayIntent;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProfileSessionGatewayAcquireResult {
  browser: BrowserInterface;
  release(options?: unknown): Promise<unknown>;
}

export interface ProfileSessionGatewayOptions {
  acquire(options: ProfileSessionGatewayAcquireOptions): Promise<ProfileSessionGatewayAcquireResult>;
}

const SESSION_REQUEST_CAPABILITY: BrowserCapabilityName = 'network.sessionRequest';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isBrowserHandle(value: ProfileSessionGatewayAcquireResult): value is ProfileSessionGatewayAcquireResult {
  return (
    Boolean(value) &&
    typeof value.release === 'function' &&
    Boolean(value.browser)
  );
}

function normalizeAcquiredHandle(
  acquired: ProfileSessionGatewayAcquireResult
): ProfileSessionGatewayAcquireResult {
  if (isBrowserHandle(acquired)) {
    return {
      browser: acquired.browser,
      release: acquired.release.bind(acquired),
    };
  }
  return acquired;
}

function normalizeOrigin(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new ProfileSessionGatewayError('invalid_url', 'Profile session site is required');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ProfileSessionGatewayError(
      'invalid_url',
      `Invalid Profile session origin: ${input}`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProfileSessionGatewayError(
      'invalid_url',
      `Unsupported Profile session origin protocol: ${parsed.protocol}`
    );
  }
  return parsed.origin;
}

function normalizeUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ProfileSessionGatewayError('invalid_url', `Invalid session request URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProfileSessionGatewayError(
      'invalid_url',
      `Unsupported session request URL protocol: ${parsed.protocol}`
    );
  }
  return parsed;
}

function buildAllowedOriginSet(
  options: ProfileSessionGatewayWithSessionOptions,
  requestOptions?: ProfileSessionGatewayRequestOptions
): Set<string> {
  const origins = new Set<string>([normalizeOrigin(options.site)]);
  for (const origin of options.allowedOrigins || []) {
    origins.add(normalizeOrigin(origin));
  }
  for (const origin of requestOptions?.allowedOrigins || []) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!origins.has(normalizedOrigin)) {
      throw new ProfileSessionGatewayError(
        'url_scope_denied',
        `Request-level allowed origin is outside the Profile session scope: ${normalizedOrigin}`,
        {
          origin: normalizedOrigin,
          allowedOrigins: [...origins],
        }
      );
    }
  }
  return origins;
}

function assertUrlInScope(
  url: string,
  sessionOptions: ProfileSessionGatewayWithSessionOptions,
  requestOptions?: ProfileSessionGatewayRequestOptions
): string {
  const parsed = normalizeUrl(url);
  const allowedOrigins = buildAllowedOriginSet(sessionOptions, requestOptions);
  if (!allowedOrigins.has(parsed.origin)) {
    throw new ProfileSessionGatewayError(
      'url_scope_denied',
      `Session request URL origin is outside the Profile session scope: ${parsed.origin}`,
      {
        origin: parsed.origin,
        allowedOrigins: [...allowedOrigins],
      }
    );
  }
  return parsed.toString();
}

function assertRuntimeSupported(
  browser: BrowserInterface
): asserts browser is BrowserInterface & BrowserSessionRequestCapability {
  const descriptor = browser.describeRuntime();
  const capability = descriptor.capabilities[SESSION_REQUEST_CAPABILITY];
  if (capability?.supported !== true || !browser.hasCapability(SESSION_REQUEST_CAPABILITY)) {
    throw new ProfileSessionGatewayError(
      'unsupported_runtime',
      `${descriptor.runtimeId} does not support ${SESSION_REQUEST_CAPABILITY}`,
      { runtimeId: descriptor.runtimeId }
    );
  }
  if (!hasBrowserSessionRequestCapability(browser)) {
    throw new ProfileSessionGatewayError(
      'unsupported_runtime',
      `${descriptor.runtimeId} is missing sessionRequest() despite descriptor support`,
      { runtimeId: descriptor.runtimeId }
    );
  }
}

function assertWriteIntentAllowed(
  sessionOptions: ProfileSessionGatewayWithSessionOptions,
  requestOptions: ProfileSessionGatewayRequestOptions
): void {
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const isWriteRequest = WRITE_METHODS.has(method);
  if (sessionOptions.intent !== 'write' && isWriteRequest) {
    throw new ProfileSessionGatewayError(
      'write_intent_denied',
      `${method} session request requires write intent`
    );
  }
  if (sessionOptions.intent !== 'write') {
    return;
  }
  if (!sessionOptions.executionContext?.capability || sessionOptions.executionContext.confirmed !== true) {
    throw new ProfileSessionGatewayError(
      'write_intent_denied',
      'Write session requests require a confirmed capability execution context'
    );
  }
}

function normalizeMaxResponseBytes(maxResponseBytes?: number): number {
  if (!Number.isFinite(maxResponseBytes)) {
    return DEFAULT_BROWSER_SESSION_REQUEST_MAX_RESPONSE_BYTES;
  }
  return Math.max(0, Math.trunc(Number(maxResponseBytes)));
}

function sanitizeRequestForGateway(
  sessionOptions: ProfileSessionGatewayWithSessionOptions,
  requestOptions: ProfileSessionGatewayRequestOptions
): BrowserSessionRequestOptions {
  assertWriteIntentAllowed(sessionOptions, requestOptions);
  const url = assertUrlInScope(requestOptions.url, sessionOptions, requestOptions);
  const { allowedOrigins: _allowedOrigins, ...browserRequestOptions } = requestOptions;
  return {
    ...browserRequestOptions,
    url,
    headers: sanitizeBrowserSessionRequestHeaders(requestOptions.headers),
    maxResponseBytes: normalizeMaxResponseBytes(requestOptions.maxResponseBytes),
    redirect: requestOptions.redirect ?? 'error',
    signal: requestOptions.signal ?? sessionOptions.signal,
  };
}

function classifyRuntimeError(error: unknown): ProfileSessionGatewayError {
  if (error instanceof ProfileSessionGatewayError) {
    return error;
  }
  if (error instanceof BrowserSessionRequestRuntimeError) {
    return new ProfileSessionGatewayError(error.code, error.message, error.details);
  }
  const message = String(error instanceof Error ? error.message : error || '').trim();
  const lower = message.toLowerCase();
  if (lower.includes('abort')) {
    return new ProfileSessionGatewayError('aborted', message || 'Session request aborted');
  }
  if (lower.includes('timeout')) {
    return new ProfileSessionGatewayError('timeout', message || 'Session request timed out');
  }
  if (lower.includes('redirect')) {
    return new ProfileSessionGatewayError('redirect', message || 'Session request redirect failed');
  }
  if (lower.includes('too_large') || lower.includes('too large')) {
    return new ProfileSessionGatewayError(
      'response_too_large',
      message || 'Session request response is too large'
    );
  }
  return new ProfileSessionGatewayError('network', message || 'Session request failed');
}

export class ProfileSessionGateway {
  constructor(private readonly options: ProfileSessionGatewayOptions) {}

  async withSession<T>(
    sessionOptions: ProfileSessionGatewayWithSessionOptions,
    handler: (session: ProfileSession) => Promise<T>
  ): Promise<T> {
    const requiredCapabilities = Array.from(
      new Set([...(sessionOptions.requiredCapabilities || []), SESSION_REQUEST_CAPABILITY])
    );
    let acquired: ProfileSessionGatewayAcquireResult | null = null;
    try {
      acquired = normalizeAcquiredHandle(
        await this.options.acquire({
          profileId: sessionOptions.profileId,
          pluginId: sessionOptions.pluginId,
          requiredCapabilities,
          intent: sessionOptions.intent ?? 'read',
          timeoutMs: sessionOptions.timeoutMs,
          signal: sessionOptions.signal,
        })
      );
      const browser = acquired.browser;
      assertRuntimeSupported(browser);
      const session: ProfileSession = {
        profileId: sessionOptions.profileId,
        site: sessionOptions.site,
        browser,
        request: async (requestOptions) => {
          try {
            const sanitized = sanitizeRequestForGateway(sessionOptions, requestOptions);
            const response = await browser.sessionRequest(sanitized);
            const finalUrl = response.url
              ? assertUrlInScope(response.url, sessionOptions, requestOptions)
              : sanitized.url;
            if (response.byteLength > sanitizeMaxBytesForCompare(sanitized.maxResponseBytes)) {
              throw new ProfileSessionGatewayError(
                'response_too_large',
                `Session request response exceeded ${sanitized.maxResponseBytes} bytes`
              );
            }
            return {
              ...response,
              url: finalUrl,
              headers: redactBrowserSessionResponseHeaders(response.headers),
            };
          } catch (error) {
            throw classifyRuntimeError(error);
          }
        },
      };
      return await handler(session);
    } finally {
      await acquired?.release().catch(() => undefined);
    }
  }
}

function sanitizeMaxBytesForCompare(maxResponseBytes?: number): number {
  return normalizeMaxResponseBytes(maxResponseBytes);
}

export const createProfileSessionGateway = (
  options: ProfileSessionGatewayOptions
): ProfileSessionGateway => new ProfileSessionGateway(options);
