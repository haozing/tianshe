import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpApiPanel } from '../HttpApiPanel';
import { DEFAULT_HTTP_API_CONFIG } from '../../../../../constants/http-api';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    warning: toastWarning,
    info: toastInfo,
  },
}));

const mockGetConfig = vi.fn();
const mockGetRuntimeStatus = vi.fn();
const mockSetConfig = vi.fn();
const mockRepairRuntime = vi.fn();

describe('HttpApiPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetConfig.mockResolvedValue({
      success: true,
      storedConfig: {
        ...DEFAULT_HTTP_API_CONFIG,
        enabled: true,
        enableAuth: true,
        token: 'saved-token',
        enableMcp: false,
      },
      effectiveConfig: {
        ...DEFAULT_HTTP_API_CONFIG,
        enabled: true,
        enableAuth: true,
        token: 'saved-token',
        enableMcp: true,
      },
      runtimeOverrides: {
        enabled: true,
        enableMcp: true,
      },
    });
    mockGetRuntimeStatus.mockResolvedValue({
      success: true,
      running: true,
      reachable: true,
      port: 19080,
      health: {
        status: 'ok',
      },
      metrics: {
        alerts: [],
      },
      runtimeAlerts: [],
      diagnosis: {
        code: 'healthy_self',
        severity: 'info',
        owner: 'self',
        summary: '当前进程服务健康',
      },
    });
    mockSetConfig.mockResolvedValue({ success: true });
    mockRepairRuntime.mockResolvedValue({
      success: true,
      repaired: false,
      action: 'noop',
      running: true,
      reachable: true,
      runtimeAlerts: [],
      diagnosis: {
        code: 'healthy_self',
        severity: 'info',
        owner: 'self',
        summary: '当前进程服务健康',
      },
    });

    (window as any).electronAPI = {
      httpApi: {
        getConfig: mockGetConfig,
        getRuntimeStatus: mockGetRuntimeStatus,
        setConfig: mockSetConfig,
        repairRuntime: mockRepairRuntime,
      },
    };
  });

  it('shows runtime override warning and does not re-probe runtime while editing an unsaved token', async () => {
    render(<HttpApiPanel />);

    await waitFor(() => {
      expect(mockGetConfig).toHaveBeenCalledTimes(1);
      expect(mockGetRuntimeStatus).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('当前进程存在启动参数覆盖')).toBeInTheDocument();
    expect(
      screen.getByText('HTTP 服务开关 当前被启动参数覆盖，已保存值为 开启，本次生效值为 开启。')
    ).toBeInTheDocument();
    expect(
      screen.getByText('MCP 服务开关 当前被启动参数覆盖，已保存值为 关闭，本次生效值为 开启。')
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('认证 Token'), {
      target: {
        value: 'draft-token',
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('认证 Token')).toHaveValue('draft-token');
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetRuntimeStatus).toHaveBeenCalledTimes(1);
  });
});
