import type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncErrorCode,
  SyncErrorResponse,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../types/sync-contract';
import {
  type SyncSchemaDefinitionName,
  validateSyncContractDefinition,
} from './sync-contract-validator';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

export const SYNC_V1_ENDPOINTS = {
  handshake: '/sync/v1/handshake',
  push: '/sync/v1/push',
  pull: '/sync/v1/pull',
  artifactUploadUrl: '/sync/v1/artifacts/upload-url',
  artifactDownloadUrl: '/sync/v1/artifacts/download-url',
} as const;

export interface SyncGatewayOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  clientVersion?: string;
  fetchImpl?: FetchLike;
}

export interface SyncGatewayRequestContext {
  timeoutMs?: number;
  token?: string;
  extraHeaders?: Record<string, string>;
}

export class SyncGatewayError extends Error {
  constructor(message: string, readonly causeData?: unknown) {
    super(message);
    this.name = 'SyncGatewayError';
  }
}

export class SyncGatewayContractError extends SyncGatewayError {
  constructor(
    message: string,
    readonly direction: 'request' | 'response',
    readonly definition: SyncSchemaDefinitionName,
    readonly validationErrors: string[]
  ) {
    super(message);
    this.name = 'SyncGatewayContractError';
  }
}

export class SyncGatewayRequestError extends SyncGatewayError {
  constructor(
    message: string,
    readonly status?: number,
    readonly traceId?: string,
    readonly errorCode?: SyncErrorCode,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SyncGatewayRequestError';
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const candidate = String(baseUrl || '').trim();
  if (!candidate) {
    throw new Error('Sync gateway baseUrl is required');
  }

  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Sync gateway baseUrl is invalid');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${normalizedPath === '/' ? '' : normalizedPath}`;
}

function buildApiUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function resolveTimeoutMs(rawTimeoutMs: number | undefined): number {
  const timeoutMs = Number(rawTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(timeoutMs);
}

function parseJsonText(rawText: string, status: number): unknown {
  const text = rawText.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new SyncGatewayRequestError(`Sync endpoint returned non-JSON payload (HTTP ${status})`, status);
  }
}

function extractMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;

  const message = record.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }

  const msg = record.msg;
  if (typeof msg === 'string' && msg.trim()) {
    return msg.trim();
  }

  const error = record.error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  if (error && typeof error === 'object') {
    const nestedMessage = (error as Record<string, unknown>).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  return fallback;
}

function mapStatusToSyncErrorCode(status: number): SyncErrorCode | undefined {
  if (!Number.isFinite(status)) return undefined;
  if (status === 401 || status === 403) return 'SYNC_AUTH_REQUIRED';
  if (status === 409) return 'SYNC_ENTITY_CONFLICT';
  if (status === 413) return 'SYNC_PAYLOAD_TOO_LARGE';
  if (status === 404) return 'SYNC_ARTIFACT_NOT_FOUND';
  if (status === 422) return 'SYNC_SCOPE_INVALID';
  if (status >= 500) return 'SYNC_INTERNAL_ERROR';
  return undefined;
}

function extractLegacyEnvelopeError(payload: unknown): {
  status: number;
  message: string;
  traceId?: string;
  details?: Record<string, unknown>;
} | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const codeValue = Number(record.code);
  if (!Number.isFinite(codeValue)) {
    return null;
  }
  const status = Math.trunc(codeValue);
  if (status < 400) {
    return null;
  }

  const traceId = typeof record.traceId === 'string' && record.traceId.trim() ? record.traceId : undefined;
  const details =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;

  return {
    status,
    message: extractMessage(payload, `HTTP ${status}`),
    ...(traceId ? { traceId } : {}),
    ...(details ? { details } : {}),
  };
}

interface PostContractArgs<TRequest, TResponse> {
  endpoint: string;
  requestDefinition: SyncSchemaDefinitionName;
  responseDefinition: SyncSchemaDefinitionName;
  payload: TRequest;
  context?: SyncGatewayRequestContext;
}

function resolveRequestUrl(baseUrl: string, rawUrl: string): string {
  const normalized = String(rawUrl || '').trim();
  if (!normalized) {
    throw new SyncGatewayRequestError('Sync artifact URL is required');
  }
  try {
    return new URL(normalized).toString();
  } catch {
    return buildApiUrl(baseUrl, normalized);
  }
}

export class SyncGateway {
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;
  private clientVersion?: string;

  constructor(options: SyncGatewayOptions) {
    if (typeof options.fetchImpl === 'function') {
      this.fetchImpl = options.fetchImpl;
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error('Fetch API is not available in current runtime');
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = String(options.token || '').trim() || undefined;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
    this.clientVersion = String(options.clientVersion || '').trim() || undefined;
    this.defaultHeaders = { ...(options.defaultHeaders || {}) };
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  setToken(token?: string): void {
    this.token = String(token || '').trim() || undefined;
  }

  setTimeout(timeoutMs: number): void {
    this.timeoutMs = resolveTimeoutMs(timeoutMs);
  }

  async handshake(
    payload: SyncHandshakeRequest,
    context?: SyncGatewayRequestContext
  ): Promise<SyncHandshakeResponse> {
    return this.postContract({
      endpoint: SYNC_V1_ENDPOINTS.handshake,
      requestDefinition: 'HandshakeRequest',
      responseDefinition: 'HandshakeResponse',
      payload,
      context,
    });
  }

  async push(payload: SyncPushRequest, context?: SyncGatewayRequestContext): Promise<SyncPushResponse> {
    return this.postContract({
      endpoint: SYNC_V1_ENDPOINTS.push,
      requestDefinition: 'PushRequest',
      responseDefinition: 'PushResponse',
      payload,
      context,
    });
  }

  async pull(payload: SyncPullRequest, context?: SyncGatewayRequestContext): Promise<SyncPullResponse> {
    return this.postContract({
      endpoint: SYNC_V1_ENDPOINTS.pull,
      requestDefinition: 'PullRequest',
      responseDefinition: 'PullResponse',
      payload,
      context,
    });
  }

  async artifactUploadUrl(
    payload: SyncArtifactUploadUrlRequest,
    context?: SyncGatewayRequestContext
  ): Promise<SyncArtifactUploadUrlResponse> {
    return this.postContract({
      endpoint: SYNC_V1_ENDPOINTS.artifactUploadUrl,
      requestDefinition: 'ArtifactUploadUrlRequest',
      responseDefinition: 'ArtifactUploadUrlResponse',
      payload,
      context,
    });
  }

  async artifactDownloadUrl(
    payload: SyncArtifactDownloadUrlRequest,
    context?: SyncGatewayRequestContext
  ): Promise<SyncArtifactDownloadUrlResponse> {
    return this.postContract({
      endpoint: SYNC_V1_ENDPOINTS.artifactDownloadUrl,
      requestDefinition: 'ArtifactDownloadUrlRequest',
      responseDefinition: 'ArtifactDownloadUrlResponse',
      payload,
      context,
    });
  }

  async uploadArtifactFile(
    uploadUrl: string,
    fileName: string,
    bytes: Uint8Array | ArrayBuffer,
    context?: SyncGatewayRequestContext
  ): Promise<Record<string, unknown>> {
    const timeoutMs = resolveTimeoutMs(context?.timeoutMs ?? this.timeoutMs);
    const token = String(context?.token ?? this.token ?? '').trim();
    const resolvedFileName = String(fileName || '').trim() || 'artifact.zip';
    const bodyBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const uploadBytes = new Uint8Array(bodyBytes.byteLength);
    uploadBytes.set(bodyBytes);
    const formData = new FormData();
    formData.append('file', new Blob([uploadBytes], { type: 'application/zip' }), resolvedFileName);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
      ...(this.clientVersion ? { 'X-Airpa-Client-Version': this.clientVersion } : {}),
      ...(context?.extraHeaders || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(resolveRequestUrl(this.baseUrl, uploadUrl), {
        method: 'PUT',
        headers,
        body: formData,
        signal: controller.signal,
      });
      const rawText = await response.text();
      const parsed = parseJsonText(rawText, response.status);
      if (!response.ok) {
        this.throwHttpError(response.status, parsed, rawText);
      }
      this.throwLegacyEnvelopeErrorIfNeeded(parsed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (error) {
      if (error instanceof SyncGatewayError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncGatewayRequestError(`Sync artifact upload timeout after ${timeoutMs}ms`);
      }
      throw new SyncGatewayRequestError(
        error instanceof Error ? error.message : 'Sync artifact upload failed unexpectedly'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadArtifactFile(
    downloadUrl: string,
    context?: SyncGatewayRequestContext
  ): Promise<Uint8Array> {
    const timeoutMs = resolveTimeoutMs(context?.timeoutMs ?? this.timeoutMs);
    const token = String(context?.token ?? this.token ?? '').trim();
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream, application/zip, */*',
      ...this.defaultHeaders,
      ...(this.clientVersion ? { 'X-Airpa-Client-Version': this.clientVersion } : {}),
      ...(context?.extraHeaders || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(resolveRequestUrl(this.baseUrl, downloadUrl), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const rawText = await response.text();
        const parsed = parseJsonText(rawText, response.status);
        this.throwHttpError(response.status, parsed, rawText);
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('json')) {
        const rawText = await response.text();
        const parsed = parseJsonText(rawText, response.status);
        this.throwLegacyEnvelopeErrorIfNeeded(parsed);
        throw new SyncGatewayRequestError(
          extractMessage(parsed, 'Sync artifact download returned JSON payload unexpectedly'),
          response.status
        );
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      if (error instanceof SyncGatewayError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncGatewayRequestError(`Sync artifact download timeout after ${timeoutMs}ms`);
      }
      throw new SyncGatewayRequestError(
        error instanceof Error ? error.message : 'Sync artifact download failed unexpectedly'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async postContract<TRequest, TResponse>({
    endpoint,
    requestDefinition,
    responseDefinition,
    payload,
    context,
  }: PostContractArgs<TRequest, TResponse>): Promise<TResponse> {
    const requestValidation = validateSyncContractDefinition(requestDefinition, payload);
    if (!requestValidation.valid) {
      throw new SyncGatewayContractError(
        `Sync request validation failed: ${requestDefinition}`,
        'request',
        requestDefinition,
        requestValidation.errors
      );
    }

    const timeoutMs = resolveTimeoutMs(context?.timeoutMs ?? this.timeoutMs);
    const token = String(context?.token ?? this.token ?? '').trim();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...(this.clientVersion ? { 'X-Airpa-Client-Version': this.clientVersion } : {}),
      ...(context?.extraHeaders || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(buildApiUrl(this.baseUrl, endpoint), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = parseJsonText(rawText, response.status);

      if (!response.ok) {
        this.throwHttpError(response.status, parsed, rawText);
      }
      this.throwLegacyEnvelopeErrorIfNeeded(parsed);

      const responseValidation = validateSyncContractDefinition(responseDefinition, parsed);
      if (responseValidation.valid) {
        return parsed as TResponse;
      }

      const errorValidation = validateSyncContractDefinition('ErrorResponse', parsed);
      if (errorValidation.valid) {
        const errorPayload = parsed as SyncErrorResponse;
        throw new SyncGatewayRequestError(
          errorPayload.error.message,
          response.status,
          errorPayload.traceId,
          errorPayload.error.code,
          errorPayload.error.details
        );
      }

      throw new SyncGatewayContractError(
        `Sync response validation failed: ${responseDefinition}`,
        'response',
        responseDefinition,
        responseValidation.errors
      );
    } catch (error) {
      if (error instanceof SyncGatewayError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncGatewayRequestError(`Sync request timeout after ${timeoutMs}ms`);
      }

      throw new SyncGatewayRequestError(
        error instanceof Error ? error.message : 'Sync request failed unexpectedly',
        undefined,
        undefined,
        undefined,
        undefined
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private throwHttpError(status: number, parsed: unknown, rawText: string): never {
    const errorValidation = validateSyncContractDefinition('ErrorResponse', parsed);
    if (errorValidation.valid) {
      const errorPayload = parsed as SyncErrorResponse;
      throw new SyncGatewayRequestError(
        errorPayload.error.message,
        status,
        errorPayload.traceId,
        errorPayload.error.code,
        errorPayload.error.details
      );
    }

    const fallback = rawText.trim().slice(0, 300) || `HTTP ${status}`;
    throw new SyncGatewayRequestError(extractMessage(parsed, fallback), status);
  }

  private throwLegacyEnvelopeErrorIfNeeded(parsed: unknown): void {
    const legacyError = extractLegacyEnvelopeError(parsed);
    if (!legacyError) {
      return;
    }
    throw new SyncGatewayRequestError(
      legacyError.message,
      legacyError.status,
      legacyError.traceId,
      mapStatusToSyncErrorCode(legacyError.status),
      legacyError.details
    );
  }
}
