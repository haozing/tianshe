import { describe, expect, it } from 'vitest';
import {
  areControlledAppShellPagesHidden,
  normalizeAppShellConfig,
  resolveAppShellActiveView,
} from './app-shell-config';

describe('app shell config', () => {
  it('normalizes page visibility from aliases and hiddenPages', () => {
    const config = normalizeAppShellConfig({
      pages: {
        data: false,
        pluginMarket: 'off',
        account_center: 'enabled',
      },
      hiddenPages: ['settings'],
    });

    expect(config.pages).toEqual({
      datasets: false,
      marketplace: false,
      accountCenter: true,
      settings: false,
    });
  });

  it('normalizes activity bar visibility and default plugin', () => {
    const config = normalizeAppShellConfig({
      hiddenPages: ['datasets', 'marketplace', 'accountCenter', 'settings'],
      activityBar: {
        visible: false,
      },
      defaultPlugin: '  xiaojingbao-client  ',
    });

    expect(config.activityBar).toEqual({ visible: false });
    expect(config.defaultPlugin).toBe('xiaojingbao-client');
    expect(areControlledAppShellPagesHidden(config)).toBe(true);
  });

  it('falls back to plugin when every controlled page is hidden', () => {
    const config = normalizeAppShellConfig({
      pages: {
        datasets: false,
        marketplace: false,
        accountCenter: false,
        settings: false,
      },
    });

    expect(areControlledAppShellPagesHidden(config)).toBe(true);
    expect(resolveAppShellActiveView('accountCenter', config, { workbenchAvailable: true })).toBe(
      'plugin'
    );
  });

  it('moves a hidden active view to the first visible built-in view', () => {
    const config = normalizeAppShellConfig({
      pages: {
        datasets: false,
        marketplace: true,
        accountCenter: false,
        settings: true,
      },
    });

    expect(resolveAppShellActiveView('datasets', config, { workbenchAvailable: false })).toBe(
      'marketplace'
    );
  });
});
