import type { RuyiPrimitive } from '../../../types/profile';

export type NativeFingerprintPayload = Record<string, RuyiPrimitive>;

export function setPayloadField(
  payload: NativeFingerprintPayload,
  key: string,
  value: RuyiPrimitive | undefined | null
): void {
  if (!key.trim()) {
    return;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    payload[key] = normalized;
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return;
    }
    payload[key] = value;
    return;
  }
  if (typeof value === 'boolean') {
    payload[key] = value;
  }
}

export function setJoinedPayloadField(
  payload: NativeFingerprintPayload,
  key: string,
  values: readonly string[] | undefined,
  separator: string
): void {
  if (!values || values.length === 0) {
    return;
  }

  const normalized = values.map((item) => String(item || '').trim()).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  payload[key] = normalized.join(separator);
}

export function stringifyNativeFingerprintValue(value: RuyiPrimitive): string {
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  return String(value);
}

export function toNativeFingerprintText(payload: NativeFingerprintPayload): string {
  return Object.entries(payload)
    .filter(([key]) => key.trim().length > 0)
    .map(([key, value]) => `${key}:${stringifyNativeFingerprintValue(value)}`)
    .join('\n');
}
