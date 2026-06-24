import type { PageSnapshot } from '../../types/browser-interface';
import type { SiteAdapterFixture } from '../site-adapter-runtime';

const SENSITIVE_KEY_PATTERN = /password|passwd|token|secret|authorization|cookie|set-cookie/i;
const SENSITIVE_TEXT_PATTERN =
  /(authorization:\s*bearer\s+)[^\s]+|(set-cookie:\s*)[^\n\r]+|(cookie:\s*)[^\n\r]+|(password=)[^&\s]+|(token=)[^&\s]+/gi;

export interface SiteAdapterLabCaptureInput {
  name: string;
  snapshot: PageSnapshot;
  input?: Record<string, unknown>;
  screenshotDataUrl?: string | null;
}

export interface SiteAdapterLabCaptureResult {
  fixture: SiteAdapterFixture;
  screenshotDataUrl: string | null;
  redactions: Array<{ path: string; reason: 'sensitive_key' | 'sensitive_text' }>;
}

function redactText(value: string): { value: string; redacted: boolean } {
  const next = value.replace(SENSITIVE_TEXT_PATTERN, (match, bearer, setCookie, cookie, password, token) => {
    if (bearer) return `${bearer}[REDACTED]`;
    if (setCookie) return `${setCookie}[REDACTED]`;
    if (cookie) return `${cookie}[REDACTED]`;
    if (password) return `${password}[REDACTED]`;
    if (token) return `${token}[REDACTED]`;
    return '[REDACTED]';
  });
  return { value: next, redacted: next !== value };
}

function sanitizeValue(
  value: unknown,
  path: string,
  redactions: SiteAdapterLabCaptureResult['redactions']
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, redactions));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          redactions.push({ path: childPath, reason: 'sensitive_key' });
          return [key, '[REDACTED]'];
        }
        return [key, sanitizeValue(child, childPath, redactions)];
      })
    );
  }
  if (typeof value === 'string') {
    const redacted = redactText(value);
    if (redacted.redacted) {
      redactions.push({ path, reason: 'sensitive_text' });
    }
    return redacted.value;
  }
  return value;
}

export function captureSiteAdapterFixture(
  input: SiteAdapterLabCaptureInput
): SiteAdapterLabCaptureResult {
  const redactions: SiteAdapterLabCaptureResult['redactions'] = [];
  const snapshot = sanitizeValue(input.snapshot, 'snapshot', redactions);
  const fixture: SiteAdapterFixture = {
    name: input.name,
    snapshot,
    input: input.input || {},
    expected: {},
  };

  return {
    fixture,
    screenshotDataUrl: input.screenshotDataUrl ? '[REDACTED_SCREENSHOT_STORED_AS_ARTIFACT]' : null,
    redactions,
  };
}
