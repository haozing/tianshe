export const DEFAULT_SCOPE_KEY = 'company:0';

export function normalizeScopeKey(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || DEFAULT_SCOPE_KEY;
}

export function toPayloadObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function hasOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

export function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function toNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return toOptionalString(value);
}

export function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

export function toOptionalNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.trunc(numeric);
}

export function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

export function fallbackName(prefix: string, globalUid: string): string {
  const suffix = String(globalUid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
  return `${prefix}-${suffix}`;
}

export function normalizeProfileRuntimeId(
  value: string | undefined
): BrowserRuntimeId | undefined {
  if (!value) return undefined;
  if (isBrowserRuntimeId(value)) {
    return value;
  }
  throw new Error(`Unsupported profile runtimeId from sync payload: ${value}`);
}
import {
  isBrowserRuntimeId,
  type BrowserRuntimeId,
} from '../../types/browser-runtime';
