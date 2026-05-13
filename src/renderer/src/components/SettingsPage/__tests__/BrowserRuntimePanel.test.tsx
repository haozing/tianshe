import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRuntimeStatus } from '../../../../../core/browser-runtime';
import { BrowserRuntimePanel } from '../BrowserRuntimePanel';

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast', () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

const mockListStatuses = vi.fn();
const mockSelectExecutable = vi.fn();
const mockSetCustomPath = vi.fn();
const mockSetDefaultSource = vi.fn();
const mockInstallManaged = vi.fn();
const mockOpenDownloadPage = vi.fn();

const baseStatus: BrowserRuntimeStatus = {
  runtimeId: 'electron-webcontents',
  descriptor: {
    runtimeId: 'electron-webcontents',
    browserFamily: 'electron',
    controlProtocol: 'webcontents',
    profileMode: 'ephemeral',
    visibilityMode: 'embedded-view',
    fingerprintBackend: 'electron-stealth',
    source: { type: 'bundled' },
    capabilities: {} as BrowserRuntimeStatus['descriptor']['capabilities'],
  },
  source: { type: 'bundled' },
  configuredSourceOverride: null,
  resolvedRuntime: {
    runtimeId: 'electron-webcontents',
    source: { type: 'bundled' },
  },
  installed: true,
  healthy: true,
  installState: 'bundled',
  version: '35.7.5',
  executablePath: 'electron',
  errors: [],
  warnings: [],
  capabilities: {
    'snapshot.page': true,
    'network.capture': true,
  },
};

describe('BrowserRuntimePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListStatuses.mockResolvedValue({
      success: true,
      data: [
        {
          ...baseStatus,
          runtimeId: 'chromium-cloak-playwright',
          descriptor: {
            ...baseStatus.descriptor,
            runtimeId: 'chromium-cloak-playwright',
            browserFamily: 'chromium',
            controlProtocol: 'playwright',
            profileMode: 'persistent',
            visibilityMode: 'external-window',
            fingerprintBackend: 'cloak-flags',
          },
          source: { type: 'managed-download', channel: 'cloakbrowser' },
          configuredSourceOverride: null,
          resolvedRuntime: null,
          installed: false,
          healthy: false,
          installState: 'missing',
          version: null,
          executablePath: undefined,
          errors: ['Cloak runtime not installed'],
          warnings: [],
          capabilities: {},
        },
        baseStatus,
      ],
    });

    (window as any).electronAPI = {
      browserRuntime: {
        listStatuses: mockListStatuses,
        getStatus: vi.fn(),
        selectExecutable: mockSelectExecutable.mockResolvedValue({
          success: true,
          data: {
            canceled: false,
            path: 'C:\\Browsers\\cloak.exe',
          },
        }),
        setCustomPath: mockSetCustomPath.mockResolvedValue({
          success: true,
          data: {
            ...baseStatus,
            runtimeId: 'chromium-cloak-playwright',
            descriptor: {
              ...baseStatus.descriptor,
              runtimeId: 'chromium-cloak-playwright',
              browserFamily: 'chromium',
              controlProtocol: 'playwright',
              profileMode: 'persistent',
              visibilityMode: 'external-window',
              fingerprintBackend: 'cloak-flags',
            },
            source: { type: 'custom-path', executablePath: 'C:\\Browsers\\cloak.exe' },
            configuredSourceOverride: {
              type: 'custom-path',
              executablePath: 'C:\\Browsers\\cloak.exe',
            },
          },
        }),
        setDefaultSource: mockSetDefaultSource.mockResolvedValue({
          success: true,
          data: baseStatus,
        }),
        installManaged: mockInstallManaged.mockResolvedValue({
          success: true,
          data: {
            ...baseStatus,
            runtimeId: 'chromium-cloak-playwright',
            descriptor: {
              ...baseStatus.descriptor,
              runtimeId: 'chromium-cloak-playwright',
              browserFamily: 'chromium',
              controlProtocol: 'playwright',
              profileMode: 'persistent',
              visibilityMode: 'external-window',
              fingerprintBackend: 'cloak-flags',
            },
            source: { type: 'managed-download', channel: 'cloakbrowser' },
            configuredSourceOverride: null,
            installState: 'managed-installed',
          },
        }),
        openDownloadPage: mockOpenDownloadPage.mockResolvedValue({
          success: true,
          data: { url: 'https://github.com/CloakHQ/CloakBrowser' },
        }),
      },
    };
  });

  it('renders runtime status cards and summary counts', async () => {
    render(<BrowserRuntimePanel />);

    await waitFor(() => {
      expect(mockListStatuses).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('已注册')).toBeInTheDocument();
    expect(screen.getAllByText('可用')).toHaveLength(2);
    expect(screen.getByText('Electron WebContents')).toBeInTheDocument();
    expect(screen.getByText('Cloak Playwright')).toBeInTheDocument();
    expect(screen.getByText('Cloak runtime not installed')).toBeInTheDocument();
    expect(screen.getByTestId('browser-runtime-electron-webcontents')).toBeInTheDocument();
    expect(screen.getByTestId('browser-runtime-chromium-cloak-playwright')).toBeInTheDocument();
  });

  it('refreshes status on demand', async () => {
    render(<BrowserRuntimePanel />);

    await waitFor(() => {
      expect(mockListStatuses).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => {
      expect(mockListStatuses).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a toast when loading fails', async () => {
    mockListStatuses.mockResolvedValueOnce({
      success: false,
      error: 'runtime unavailable',
    });

    render(<BrowserRuntimePanel />);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('加载浏览器运行时状态失败', 'runtime unavailable');
    });
  });

  it('selects a custom executable path and installs managed Cloak runtime', async () => {
    render(<BrowserRuntimePanel />);

    await waitFor(() => {
      expect(screen.getByText('Cloak Playwright')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '选择路径' }));

    await waitFor(() => {
      expect(mockSelectExecutable).toHaveBeenCalledWith('chromium-cloak-playwright');
      expect(mockSetCustomPath).toHaveBeenCalledWith(
        'chromium-cloak-playwright',
        'C:\\Browsers\\cloak.exe'
      );
      expect(toastSuccess).toHaveBeenCalledWith('浏览器路径已保存');
    });

    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    await waitFor(() => {
      expect(mockInstallManaged).toHaveBeenCalledWith('chromium-cloak-playwright');
    });
  });

  it('opens runtime download page', async () => {
    render(<BrowserRuntimePanel />);

    await waitFor(() => {
      expect(screen.getByText('Cloak Playwright')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '下载页' }));

    await waitFor(() => {
      expect(mockOpenDownloadPage).toHaveBeenCalledWith('chromium-cloak-playwright');
    });
  });
});
