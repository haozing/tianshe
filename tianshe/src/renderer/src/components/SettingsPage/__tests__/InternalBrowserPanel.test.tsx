import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalBrowserPanel } from '../InternalBrowserPanel';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

const mockGetDevToolsConfig = vi.fn();
const mockSetDevToolsConfig = vi.fn();

describe('InternalBrowserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetDevToolsConfig.mockResolvedValue({
      success: true,
      config: {
        autoOpenDevTools: false,
      },
    });
    mockSetDevToolsConfig.mockResolvedValue({
      success: true,
      config: {
        autoOpenDevTools: true,
      },
    });

    (window as any).electronAPI = {
      internalBrowser: {
        getDevToolsConfig: mockGetDevToolsConfig,
        setDevToolsConfig: mockSetDevToolsConfig,
      },
    };
  });

  it('loads config and saves updated devtools switch', async () => {
    render(<InternalBrowserPanel />);

    await waitFor(() => {
      expect(mockGetDevToolsConfig).toHaveBeenCalledTimes(1);
    });

    const toggle = screen.getByRole('switch', { name: '自动打开 Developer Tools' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(mockSetDevToolsConfig).toHaveBeenCalledWith({
        autoOpenDevTools: true,
      });
    });

    expect(toastSuccess).toHaveBeenCalledWith('内置浏览器配置已保存');
  });

  it('shows error toast when loading fails', async () => {
    mockGetDevToolsConfig.mockResolvedValue({
      success: false,
      error: 'load failed',
    });

    render(<InternalBrowserPanel />);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('加载内置浏览器配置失败', 'load failed');
    });
  });
});
