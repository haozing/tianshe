import { describe, expect, it } from 'vitest';
import {
  REDACTED_PATH,
  REDACTED_SQL,
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

  it('redacts absolute filesystem paths in text', () => {
    expect(redactSensitiveText('failed to open C:\\Users\\alice\\secret.duckdb')).toBe(
      `failed to open ${REDACTED_PATH}`
    );
    expect(redactSensitiveText('failed to open /home/alice/secret.duckdb')).toBe(
      `failed to open ${REDACTED_PATH}`
    );
  });

  it('redacts SQL statements in text', () => {
    expect(redactSensitiveText('DuckDB error near SELECT * FROM users WHERE token=abc')).toBe(
      `DuckDB error near ${REDACTED_SQL}`
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
