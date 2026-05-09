import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { useUIStore } from '../stores/uiStore';

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
});
