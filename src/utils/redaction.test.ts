import { describe, expect, it } from 'vitest';
import {
  REDACTED_VALUE,
  redactSensitiveText,
  redactSensitiveUrl,
  redactSensitiveValue,
} from './redaction';

describe('redaction utilities', () => {
  it('redacts bearer tokens and query secrets in text', () => {
    expect(redactSensitiveText('Authorization: Bearer abc.def token=secret')).toBe(
      `Authorization: Bearer ${REDACTED_VALUE} token=${REDACTED_VALUE}`
    );
  });

  it('redacts credentials and sensitive query params in URLs', () => {
    const redacted = redactSensitiveUrl(
      'https://user:pass@example.com/callback?token=abc&safe=value'
    );

    expect(redacted).toContain(`token=${encodeURIComponent(REDACTED_VALUE)}`);
    expect(redacted).toContain('safe=value');
    expect(redacted).not.toContain('user:pass');
  });

  it('redacts sensitive object keys recursively', () => {
    expect(
      redactSensitiveValue({
        token: 'abc',
        nested: {
          apiKey: 'def',
          safe: 'Bearer xyz',
        },
      })
    ).toEqual({
      token: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        safe: `Bearer ${REDACTED_VALUE}`,
      },
    });
  });
});
