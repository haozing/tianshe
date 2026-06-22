import { describe, expect, it } from 'vitest';
import { getRuntimeWindowControlContract } from './window-control-contract';

describe('browser window control contract', () => {
  it('describes Electron embedded handoff as supported', () => {
    expect(getRuntimeWindowControlContract('electron-webcontents')).toMatchObject({
      runtimeId: 'electron-webcontents',
      visibilityMode: 'embedded-view',
      capabilities: {
        window: { status: 'supported' },
        focus: { status: 'supported' },
        restore: { status: 'supported' },
        capture: { status: 'supported' },
        manualHandoff: { status: 'supported' },
      },
    });
  });

  it('describes external runtimes without show/hide as degraded for handoff', () => {
    expect(getRuntimeWindowControlContract('chromium-cloak-playwright')).toMatchObject({
      runtimeId: 'chromium-cloak-playwright',
      visibilityMode: 'external-window',
      capabilities: {
        window: { status: 'degraded' },
        focus: { status: 'degraded' },
        restore: { status: 'degraded' },
        manualHandoff: { status: 'degraded' },
      },
    });
  });
});
