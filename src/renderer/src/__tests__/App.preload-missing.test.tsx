import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { useUIStore } from '../stores/uiStore';

vi.mock('../components/ActivityBar', () => ({
  ActivityBar: () => <nav>Activity bar fallback</nav>,
}));

vi.mock('../components/AccountCenter', () => ({
  AccountCenterPage: () => <div>Account center fallback page</div>,
}));

vi.mock('../components/DatasetsPage', () => ({
  DatasetsPage: () => <div>Datasets fallback page</div>,
}));

vi.mock('../components/PluginMarket', () => ({
  PluginMarketPage: () => <div>Plugin market fallback page</div>,
}));

vi.mock('../components/SettingsPage', () => ({
  SettingsPage: () => <div>Settings fallback page</div>,
}));

vi.mock('../components/UpdateNotification', () => ({
  UpdateNotification: () => <div>Update notification</div>,
}));

const originalElectronAPI = window.electronAPI;

afterEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: originalElectronAPI,
  });
  vi.restoreAllMocks();
});

describe('App without preload bridge', () => {
  it('renders a bridge-unavailable fallback instead of crashing when window.electronAPI is missing', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: undefined,
    });
    useUIStore.setState({
      activeView: 'accountCenter',
      accountCenterTab: 'accounts',
      activePluginView: null,
      isActivityBarCollapsed: false,
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('客户端桥接未加载')).toBeInTheDocument();
    });

    expect(
      screen.getByText('当前页面缺少 Electron preload 注入，桌面客户端能力暂不可用。')
    ).toBeInTheDocument();
    expect(screen.queryByText('Account center fallback page')).not.toBeInTheDocument();
    expect(screen.queryByText('应用出现错误')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('hides the host activity bar and opens the configured default plugin', async () => {
    const setActivityBarWidth = vi.fn().mockResolvedValue({ success: true });
    const showPluginView = vi.fn().mockResolvedValue({ success: true });
    const unsubscribe = vi.fn();
    const baseElectronAPI = originalElectronAPI as NonNullable<typeof originalElectronAPI>;

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...baseElectronAPI,
        getAppInfo: vi.fn().mockResolvedValue({
          success: true,
          info: {
            isPackaged: false,
            platform: 'test',
            appShell: {
              hiddenPages: ['datasets', 'marketplace', 'accountCenter', 'settings'],
              activityBar: { visible: false },
              defaultPlugin: 'preferred-plugin',
            },
          },
        }),
        jsPlugin: {
          ...baseElectronAPI.jsPlugin,
          list: vi.fn().mockResolvedValue({
            success: true,
            plugins: [
              {
                id: 'fallback-plugin',
                name: 'Fallback Plugin',
                version: '1.0.0',
                author: 'test',
                installedAt: 1,
                path: '/plugins/fallback',
                hasActivityBarView: true,
              },
              {
                id: 'preferred-plugin',
                name: 'Preferred Plugin',
                version: '1.0.0',
                author: 'test',
                installedAt: 2,
                path: '/plugins/preferred',
                hasActivityBarView: true,
              },
            ],
          }),
          onPluginStateChanged: vi.fn(() => unsubscribe),
          showPluginView,
        },
        view: {
          ...baseElectronAPI.view,
          setActivityBarWidth,
        },
      },
    });
    useUIStore.setState({
      activeView: 'accountCenter',
      accountCenterTab: 'accounts',
      activePluginView: null,
      isActivityBarCollapsed: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(setActivityBarWidth).toHaveBeenCalledWith(0);
      expect(showPluginView).toHaveBeenCalledWith('preferred-plugin');
    });

    expect(screen.queryByText('Activity bar fallback')).not.toBeInTheDocument();
    expect(useUIStore.getState().activeView).toBe('plugin');
    expect(useUIStore.getState().activePluginView).toBe('preferred-plugin');
  });
});
