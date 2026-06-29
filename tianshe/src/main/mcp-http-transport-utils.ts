import type { Request, Response } from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_PROTOCOL_ALLOWED_VERSIONS,
  MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS,
  MCP_PROTOCOL_UNIFIED_VERSION,
  isAllowedMcpProtocolVersion,
} from '../constants/mcp-protocol';

export type JsonRpcRequestId = string | number;

interface InitializeRequestMatch {
  message: Record<string, unknown>;
  index: number | null;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const asTrimmedText = (value: unknown): string => String(value == null ? '' : value).trim();

export const isValidJsonRpcRequestId = (value: unknown): value is JsonRpcRequestId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));

export const extractSingleJsonRpcRequestId = (body: unknown): JsonRpcRequestId | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const message = body as {
    id?: unknown;
    jsonrpc?: unknown;
    method?: unknown;
  };

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return null;
  }

  return isValidJsonRpcRequestId(message.id) ? message.id : null;
};

const normalizeAllowedOrigins = (origins: readonly string[] | undefined): string[] => {
  if (!origins?.length) {
    return [];
  }

  const normalized = origins
    .map((origin) => {
      try {
        return new URL(asTrimmedText(origin)).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  return Array.from(new Set(normalized));
};

export const writeJsonRpcError = (
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown> | null,
  requestId?: JsonRpcRequestId | null
): void => {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
    id: requestId ?? null,
  });
};

export const findInitializeRequest = (body: unknown): InitializeRequestMatch | undefined => {
  if (isInitializeRequest(body)) {
    return { message: body as Record<string, unknown>, index: null };
  }

  if (!Array.isArray(body)) {
    return undefined;
  }

  const index = body.findIndex((message) => isInitializeRequest(message));
  if (index < 0) {
    return undefined;
  }

  return { message: body[index] as Record<string, unknown>, index };
};

const getInitializeProtocolVersion = (body: unknown): string => {
  const initializeRequest = findInitializeRequest(body);
  if (!initializeRequest) return '';
  const params = (initializeRequest.message as { params?: { protocolVersion?: unknown } }).params;
  return asTrimmedText(params?.protocolVersion);
};

const writeProtocolVersionError = (
  res: Response,
  source: 'mcp-protocol-version' | 'initialize.params.protocolVersion' | 'protocol_mismatch',
  actual: string,
  initializeVersion?: string,
  requestId?: JsonRpcRequestId | null
): void => {
  const allowedVersionsText = MCP_PROTOCOL_ALLOWED_VERSIONS.join(', ');
  writeJsonRpcError(
    res,
    400,
    -32600,
    source === 'protocol_mismatch'
      ? `MCP protocol version mismatch between header (${actual}) and initialize.params.protocolVersion (${initializeVersion || '-'})`
      : `Unsupported ${source}: ${actual}. Allowed MCP protocol versions: ${allowedVersionsText}`,
    {
      source,
      unifiedProtocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
      supportedProtocolVersions: MCP_PROTOCOL_ALLOWED_VERSIONS,
      sdkSupportedProtocolVersions: MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS,
      hint: 'Do not reuse x-airpa-api-version as mcp-protocol-version.',
    },
    requestId
  );
};

export const validateMcpProtocolVersion = (
  req: Request,
  res: Response,
  body: unknown,
  requestId?: JsonRpcRequestId | null
): boolean => {
  const headerVersion = asTrimmedText(req.headers['mcp-protocol-version']);
  const initializeVersion = getInitializeProtocolVersion(body);

  if (headerVersion && !isAllowedMcpProtocolVersion(headerVersion)) {
    writeProtocolVersionError(res, 'mcp-protocol-version', headerVersion, undefined, requestId);
    return false;
  }

  if (initializeVersion && !isAllowedMcpProtocolVersion(initializeVersion)) {
    writeProtocolVersionError(
      res,
      'initialize.params.protocolVersion',
      initializeVersion,
      undefined,
      requestId
    );
    return false;
  }

  if (headerVersion && initializeVersion && headerVersion !== initializeVersion) {
    writeProtocolVersionError(
      res,
      'protocol_mismatch',
      headerVersion,
      initializeVersion,
      requestId
    );
    return false;
  }

  return true;
};

const buildNormalizedMcpAcceptHeader = (
  req: Request
): { changed: boolean; normalized: string } => {
  const raw = req.headers.accept;
  const current = Array.isArray(raw) ? raw.join(',') : asTrimmedText(raw);
  const includesJson = /(^|,)\s*application\/json\s*(;|,|$)/i.test(current);
  const includesSse = /(^|,)\s*text\/event-stream\s*(;|,|$)/i.test(current);

  if (includesJson && includesSse) {
    return { changed: false, normalized: current };
  }

  const tokens = current
    ? current
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];

  if (!includesJson) tokens.push('application/json');
  if (!includesSse) tokens.push('text/event-stream');

  return {
    changed: true,
    normalized: tokens.join(', '),
  };
};

const buildNormalizedRawHeaders = (
  rawHeaders: string[] | undefined,
  normalizedAccept: string
): string[] => {
  const source = Array.isArray(rawHeaders) ? [...rawHeaders] : [];
  const filtered: string[] = [];

  for (let index = 0; index < source.length; index += 2) {
    const key = source[index];
    const value = source[index + 1];
    if (typeof key !== 'string') {
      continue;
    }
    if (key.toLowerCase() === 'accept') {
      continue;
    }
    filtered.push(key, typeof value === 'string' ? value : '');
  }

  filtered.push('accept', normalizedAccept);
  return filtered;
};

export const normalizeMcpAcceptHeader = (req: Request): void => {
  const { changed, normalized } = buildNormalizedMcpAcceptHeader(req);
  if (!changed) {
    return;
  }
  req.headers.accept = normalized;
};

export const createMcpTransportRequest = (req: Request): Request => {
  const { changed, normalized } = buildNormalizedMcpAcceptHeader(req);
  if (!changed) {
    return req;
  }

  const adapted = Object.create(req) as Request & { rawHeaders?: string[] };
  adapted.headers = {
    ...req.headers,
    accept: normalized,
  };
  adapted.rawHeaders = buildNormalizedRawHeaders(
    (req as Request & { rawHeaders?: string[] }).rawHeaders,
    normalized
  );
  return adapted;
};

const isAllowedLoopbackOrigin = (origin: string): boolean => {
  const value = asTrimmedText(origin);
  if (!value) return true;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
};

export const validateMcpOrigin = (
  req: Request,
  res: Response,
  allowedOrigins: readonly string[] | undefined,
  requestId?: JsonRpcRequestId | null
): boolean => {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const normalized = asTrimmedText(origin);
  if (!normalized) {
    return true;
  }

  if (isAllowedLoopbackOrigin(normalized)) {
    return true;
  }

  let requestOrigin = normalized;
  try {
    requestOrigin = new URL(normalized).origin;
  } catch {
    // fall through
  }

  const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  if (normalizedAllowedOrigins.includes(requestOrigin)) {
    return true;
  }

  writeJsonRpcError(
    res,
    403,
    -32000,
    `Invalid Origin: ${normalized}`,
    {
      reason: 'invalid_origin',
      origin: normalized,
      hint:
        normalizedAllowedOrigins.length > 0
          ? 'Use a loopback origin or add the client origin to mcpAllowedOrigins.'
          : 'Use a loopback origin or configure mcpAllowedOrigins for trusted external clients.',
      ...(normalizedAllowedOrigins.length > 0 ? { allowedOrigins: normalizedAllowedOrigins } : {}),
    },
    requestId
  );
  return false;
};
