import { describe, expect, it } from 'vitest';
import { ReadinessRegistry } from './readiness-registry';

describe('ReadinessRegistry', () => {
  it('stores immutable snapshots by service name', () => {
    const registry = new ReadinessRegistry();

    const snapshot = registry.mark('browserPool', 'ready', { updatedAt: 10 });
    snapshot.status = 'failed';

    expect(registry.get('browserPool')).toEqual({
      service: 'browserPool',
      status: 'ready',
      updatedAt: 10,
      error: null,
    });
  });

  it('returns all readiness snapshots', () => {
    const registry = new ReadinessRegistry();

    registry.set({ service: 'app', status: 'ready', updatedAt: 1, error: null });
    registry.set({ service: 'browserPool', status: 'failed', updatedAt: 2, error: 'boom' });

    expect(registry.getAll()).toEqual([
      { service: 'app', status: 'ready', updatedAt: 1, error: null },
      { service: 'browserPool', status: 'failed', updatedAt: 2, error: 'boom' },
    ]);
  });
});
