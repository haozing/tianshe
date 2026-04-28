const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|session)/i;

const MAX_REDACTION_DEPTH = 6;

export const REDACTED_VALUE = '[REDACTED]';

export function redactSensitiveText(value: string): string {
  return String(value)
    .replace(/(Bearer\s+)[^\s,;]+/gi, `$1${REDACTED_VALUE}`)
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key|access[_-]?key|session)=)[^&\s]+/gi,
      `$1${REDACTED_VALUE}`
    );
}

export function redactSensitiveUrl(value: string): string {
  const raw = String(value || '');
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = REDACTED_VALUE;
    if (parsed.password) parsed.password = REDACTED_VALUE;

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, REDACTED_VALUE);
      }
    }

    return parsed.toString();
  } catch {
    return redactSensitiveText(raw);
  }
}

export function redactSensitiveError(error: Error): Record<string, string> {
  return {
    name: error.name,
    message: redactSensitiveText(error.message),
    ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
  };
}

export function redactSensitiveValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (value instanceof Error) {
    return redactSensitiveError(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return '[MaxDepth]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : redactSensitiveValue(entryValue, depth + 1, seen);
  }

  return out;
}
