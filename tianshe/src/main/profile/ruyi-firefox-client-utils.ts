import type {
  ConsoleMessage,
  WindowOpenPolicy,
} from '../../core/browser-core/types';
import type { BrowserInterceptPattern, BrowserInterceptedRequest } from '../../types/browser-interface';
import type {
  ScriptCommandResult,
  SerializedWindowOpenPolicy,
} from './ruyi-firefox-client.types';

export type BidiUrlPattern =
  | {
      type: 'string';
      pattern: string;
    }
  | {
      type: 'pattern';
      protocol?: string;
      hostname?: string;
      port?: string;
      pathname?: string;
      search?: string;
    };

export function isNoSuchAlertError(error: unknown): boolean {
  return error instanceof Error && /no such alert/i.test(error.message);
}

export function isNoSuchBrowsingContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(no such frame|no such browsing context|browsing context .* not found)/i.test(error.message)
  );
}

export function isUnsupportedBiDiCommandError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(unknown command|unsupported operation|not implemented|method not found)/i.test(error.message)
  );
}

export function normalizeButton(button: 'left' | 'right' | 'middle' | undefined): number {
  if (button === 'right') {
    return 2;
  }
  if (button === 'middle') {
    return 1;
  }
  return 0;
}

function normalizeHeaderValue(value: unknown): string {
  if (value && typeof value === 'object') {
    if ('value' in (value as Record<string, unknown>)) {
      return String((value as Record<string, unknown>).value ?? '');
    }
  }
  return String(value ?? '');
}

export function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!Array.isArray(headers)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const entry of headers) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const node = entry as Record<string, unknown>;
    const name = String(node.name ?? '').trim().toLowerCase();
    if (!name) {
      continue;
    }
    result[name] = normalizeHeaderValue(node.value);
  }
  return result;
}

export function serializeBidiStringValue(value: string): Record<string, unknown> {
  return {
    type: 'string',
    value,
  };
}

export function serializeBidiHeaders(
  headers?: Record<string, string>
): Array<Record<string, unknown>> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([name]) => String(name).trim().length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([name, value]) => ({
    name,
    value: serializeBidiStringValue(String(value ?? '')),
  }));
}

function looksLikeRegExpPattern(pattern: string): boolean {
  return pattern.includes('.*') || /[\[\](){}+?^$|\\]/.test(pattern);
}

function toBidiUrlPattern(rawPattern: string): BidiUrlPattern | null {
  const normalized = rawPattern.trim();
  if (!normalized) {
    return null;
  }

  // BiDi urlPatterns are exact URL component matchers, not substring or regex filters.
  // We only down-push literal pathname filters that preserve current semantics without
  // risking false negatives for patterns still handled by the local matcher.
  if (!normalized.startsWith('/') || normalized.includes('*') || looksLikeRegExpPattern(normalized)) {
    return null;
  }

  return {
    type: 'pattern',
    pathname: normalized,
  };
}

export function buildBidiUrlPatterns(
  patterns: BrowserInterceptPattern[]
): BidiUrlPattern[] | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  const browserPatterns: BidiUrlPattern[] = [];
  for (const pattern of patterns) {
    const urlPattern = String(pattern.urlPattern ?? '').trim();
    if (!urlPattern) {
      return undefined;
    }

    const bidiPattern = toBidiUrlPattern(urlPattern);
    if (!bidiPattern) {
      return undefined;
    }
    browserPatterns.push(bidiPattern);
  }

  return browserPatterns.length > 0 ? browserPatterns : undefined;
}

function matchesUrlPattern(url: string, pattern: string): boolean {
  const normalized = pattern.trim();
  if (!normalized) {
    return true;
  }

  if (normalized.includes('*') && !looksLikeRegExpPattern(normalized.replace(/\*/g, ''))) {
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(url);
  }

  if (looksLikeRegExpPattern(normalized)) {
    try {
      return new RegExp(normalized, 'i').test(url);
    } catch {
      return url.includes(normalized);
    }
  }

  return url.includes(normalized);
}

export function matchesInterceptPatterns(
  request: BrowserInterceptedRequest,
  patterns: BrowserInterceptPattern[]
): boolean {
  if (patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => {
    if (pattern.urlPattern && !matchesUrlPattern(request.url, pattern.urlPattern)) {
      return false;
    }
    if (
      pattern.methods &&
      pattern.methods.length > 0 &&
      !pattern.methods.some((method) => method.toUpperCase() === request.method.toUpperCase())
    ) {
      return false;
    }
    if (
      pattern.resourceTypes &&
      pattern.resourceTypes.length > 0 &&
      !pattern.resourceTypes.some(
        (resourceType) => resourceType.toLowerCase() === String(request.resourceType || '').toLowerCase()
      )
    ) {
      return false;
    }
    return true;
  });
}

export function normalizeConsoleLevel(level: unknown): ConsoleMessage['level'] {
  const normalized = String(level ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'error') {
    return 'error';
  }
  if (normalized === 'warn' || normalized === 'warning') {
    return 'warning';
  }
  if (normalized === 'debug' || normalized === 'trace') {
    return 'verbose';
  }
  return 'info';
}

export function normalizeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return Date.now();
  }
  return timestamp < 10_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp);
}

export function serializeWindowOpenPolicy(
  policy: WindowOpenPolicy
): SerializedWindowOpenPolicy {
  return {
    default: String(policy.default || 'allow'),
    rules: Array.isArray(policy.rules)
      ? policy.rules.map((rule) => ({
          action: String(rule.action || 'allow'),
          match:
            rule.match instanceof RegExp
              ? {
                  kind: 'regex',
                  source: rule.match.source,
                  flags: rule.match.flags,
                }
              : {
                  kind: 'string',
                  value: String(rule.match ?? ''),
                },
        }))
      : [],
  };
}

export function serializeLocalValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { type: 'null' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return { type: 'number', value: 'NaN' };
    }
    if (!Number.isFinite(value)) {
      return { type: 'number', value: value > 0 ? 'Infinity' : '-Infinity' };
    }
    if (Object.is(value, -0)) {
      return { type: 'number', value: '-0' };
    }
    return { type: 'number', value };
  }
  if (typeof value === 'string') {
    return { type: 'string', value };
  }
  if (Array.isArray(value)) {
    return { type: 'array', value: value.map((item) => serializeLocalValue(item)) };
  }
  if (typeof value === 'object') {
    if ('sharedId' in (value as Record<string, unknown>)) {
      const sharedId = (value as Record<string, unknown>).sharedId;
      return {
        type: 'sharedReference',
        sharedId: typeof sharedId === 'string' ? sharedId : String(sharedId ?? ''),
      };
    }
    return {
      type: 'object',
      value: Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializeLocalValue(item),
      ]),
    };
  }

  return { type: 'string', value: String(value) };
}

function parseRemoteValue(node: unknown): unknown {
  if (!node || typeof node !== 'object') {
    return node;
  }

  const valueNode = node as Record<string, unknown>;
  const type = String(valueNode.type || '');

  if (type === 'null' || type === 'undefined') {
    return null;
  }
  if (type === 'string' || type === 'boolean') {
    return valueNode.value;
  }
  if (type === 'number') {
    const value = valueNode.value;
    if (value === 'NaN') return Number.NaN;
    if (value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (value === '-0') return -0;
    return value;
  }
  if (type === 'bigint') {
    return Number.parseInt(String(valueNode.value ?? '0'), 10);
  }
  if (type === 'array') {
    return Array.isArray(valueNode.value)
      ? valueNode.value.map((item) => parseRemoteValue(item))
      : [];
  }
  if (type === 'object') {
    const result: Record<string, unknown> = {};
    const pairs = Array.isArray(valueNode.value) ? valueNode.value : [];
    for (const pair of pairs) {
      if (Array.isArray(pair) && pair.length === 2) {
        const key = typeof pair[0] === 'string' ? pair[0] : String(parseRemoteValue(pair[0]));
        result[key] = parseRemoteValue(pair[1]);
      }
    }
    return result;
  }
  if (type === 'map') {
    const result: Record<string, unknown> = {};
    const pairs = Array.isArray(valueNode.value) ? valueNode.value : [];
    for (const pair of pairs) {
      if (Array.isArray(pair) && pair.length === 2) {
        result[String(parseRemoteValue(pair[0]))] = parseRemoteValue(pair[1]);
      }
    }
    return result;
  }
  if (type === 'set') {
    const items = Array.isArray(valueNode.value) ? valueNode.value : [];
    return items.map((item) => parseRemoteValue(item));
  }

  return valueNode.value ?? valueNode;
}

export function parseScriptResult<TResult>(result: ScriptCommandResult): TResult {
  if (result.type === 'exception') {
    const details = result.exceptionDetails || {};
    const text =
      (typeof details.text === 'string' && details.text.trim()) ||
      (typeof details.columnNumber === 'number' && typeof details.lineNumber === 'number'
        ? `JavaScript exception at ${details.lineNumber}:${details.columnNumber}`
        : '') ||
      'JavaScript evaluation failed';
    throw new Error(text);
  }

  return parseRemoteValue(result.result) as TResult;
}
