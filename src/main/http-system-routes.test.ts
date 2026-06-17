import { describe, expect, it } from 'vitest';
import { resolveHealthStatus } from './http-system-routes';

describe('http system health status', () => {
  it('maps no alerts to ok', () => {
    expect(resolveHealthStatus([])).toBe('ok');
  });

  it('maps warning alerts to degraded', () => {
    expect(resolveHealthStatus([{ severity: 'warning' }])).toBe('degraded');
  });

  it('maps any critical alert to error', () => {
    expect(resolveHealthStatus([{ severity: 'warning' }, { severity: 'critical' }])).toBe(
      'error'
    );
  });
});
