import { beforeEach, describe, expect, it } from 'vitest';
import { migratePersistedUIState, useUIStore } from '../uiStore';

function resetUIStoreState() {
  useUIStore.setState({
    activeView: 'accountCenter',
    accountCenterTab: 'accounts',
    isActivityBarCollapsed: false,
    activePluginView: null,
    isCloudAuthDialogOpen: false,
  });
}

describe('uiStore', () => {
  beforeEach(() => {
    resetUIStoreState();
  });

  it('defaults to accountCenter as the primary view', () => {
    expect(useUIStore.getState()).toEqual(
      expect.objectContaining({
        activeView: 'accountCenter',
        accountCenterTab: 'accounts',
      })
    );
  });

  it('migrates legacy browserCenterTab and browsers view into accountCenter state', async () => {
    const migrated = await migratePersistedUIState(
      {
        activeView: 'browsers',
        browserCenterTab: 'running',
        isActivityBarCollapsed: true,
        activePluginView: 'plugin-demo',
      },
      4
    );

    expect(migrated).toEqual({
      activeView: 'accountCenter',
      accountCenterTab: 'running',
      isActivityBarCollapsed: true,
      activePluginView: 'plugin-demo',
    });
    expect('browserCenterTab' in migrated).toBe(false);
  });

  it('returns to accountCenter after closing plugin view', () => {
    useUIStore.getState().setActivePluginView('plugin-demo');
    expect(useUIStore.getState().activeView).toBe('plugin');

    useUIStore.getState().setActivePluginView(null);
    expect(useUIStore.getState().activeView).toBe('accountCenter');
  });
});
