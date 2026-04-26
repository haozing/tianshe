import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExtensionPackagesPanel } from '../ExtensionPackagesPanel';
import type { BrowserProfile } from '../../../../../types/profile';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: toastSuccess,
    warning: toastWarning,
    error: toastError,
  },
}));

const profileMockState = vi.hoisted(() => ({
  profiles: [
    { id: 'ext-1', name: 'Extension-1', engine: 'extension' },
    { id: 'ext-2', name: 'Extension-2', engine: 'extension' },
    { id: 'el-1', name: 'Electron-1', engine: 'electron' },
  ],
}));

vi.mock('../../../stores/profileStore', () => ({
  useProfileStore: (selector?: (state: typeof profileMockState) => unknown) =>
    (typeof selector === 'function' ? selector(profileMockState) : profileMockState),
}));

const cloudAuthState = vi.hoisted(() => ({
  authState: 'idle',
  session: {
    loggedIn: false,
    baseUrl: 'http://example.test',
  },
  loadSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../stores/cloudAuthStore', () => ({
  useCloudAuthStore: (selector?: (state: typeof cloudAuthState) => unknown) =>
    (typeof selector === 'function' ? selector(cloudAuthState) : cloudAuthState),
}));

vi.mock('../../../lib/edition', () => ({
  isCloudBrowserExtensionCatalogAvailable: () => true,
}));

describe('ExtensionPackagesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudAuthState.authState = 'idle';
    cloudAuthState.session.loggedIn = false;
    cloudAuthState.session.baseUrl = 'http://example.test';
  });

  function installElectronAPIMocks(options?: {
    runningBrowsers?: Array<{ id: string; sessionId: string; engine?: string; status?: string }>;
    batchBindDestroyedBrowsers?: number;
    batchBindRestartFailures?: Array<{ profileId: string; error: string }>;
    catalogItems?: Array<{
      extensionId: string;
      name?: string;
      description?: string;
      currentVersion?: string;
      canInstall?: boolean;
      installReason?: string;
    }>;
    catalogCapabilities?: {
      actions?: {
        view?: boolean;
        install?: boolean;
      };
      policyVersion?: string;
    };
  }) {
    const listPackages = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'pkg-1',
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'Demo Ext',
          version: '1.0.0',
          sourceType: 'local',
          extractDir: 'D:/tmp/ext/pkg-1',
          enabled: true,
          createdAt: new Date('2026-02-26T10:00:00.000Z'),
          updatedAt: new Date('2026-02-26T10:00:00.000Z'),
        },
      ],
    });

    const listCatalog = vi.fn().mockResolvedValue({
      success: true,
      data: {
        items: options?.catalogItems || [],
        total: options?.catalogItems?.length || 0,
        pageIndex: 1,
        pageSize: 200,
      },
    });
    const getCatalogCapabilities = vi.fn().mockResolvedValue({
      success: true,
      data: {
        actions: {
          view: options?.catalogCapabilities?.actions?.view ?? true,
          install: options?.catalogCapabilities?.actions?.install ?? true,
        },
        policyVersion: options?.catalogCapabilities?.policyVersion || 'policy-1',
      },
    });

    const listProfileBindings = vi.fn().mockResolvedValue({
      success: true,
      data: [],
    });

    const batchBind = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: true,
        affectedProfiles: [],
        destroyedBrowsers: options?.batchBindDestroyedBrowsers || 0,
        restartFailures: options?.batchBindRestartFailures || [],
      },
    });

    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      extensionPackages: {
        listPackages,
        selectLocalDirectories: vi.fn(),
        selectLocalArchives: vi.fn(),
        importLocalPackages: vi.fn(),
        downloadCloudCatalogPackages: vi.fn(),
        listProfileBindings,
        batchBind,
        batchUnbind: vi.fn(),
      },
      profile: {
        poolListBrowsers: vi.fn().mockResolvedValue({
          success: true,
          data: (options?.runningBrowsers || []).map((browser, index) => ({
            id: browser.id,
            sessionId: browser.sessionId,
            engine: browser.engine || 'extension',
            status: browser.status || 'idle',
            createdAt: index,
            lastAccessedAt: index,
            useCount: 1,
            idleTimeoutMs: 60000,
          })),
        }),
      },
      cloudBrowserExtension: {
        getCatalogCapabilities,
        listCatalog,
      },
    };

    return {
      listPackages,
      getCatalogCapabilities,
      listCatalog,
      listProfileBindings,
      batchBind,
      downloadCloudCatalogPackages:
        (window as any).electronAPI.extensionPackages.downloadCloudCatalogPackages,
    };
  }

  it('loads repository packages on mount', async () => {
    const mocks = installElectronAPIMocks();

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    expect(screen.getByText('扩展中心')).toBeInTheDocument();

    await waitFor(() => {
      expect(mocks.listPackages).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText('Demo Ext')).toBeInTheDocument();
    expect(mocks.listProfileBindings).toHaveBeenCalled();
    expect(mocks.listCatalog).not.toHaveBeenCalled();
  });

  it('shows a stable unavailable state when extension IPC handlers are missing', async () => {
    const mocks = installElectronAPIMocks();
    mocks.listPackages.mockRejectedValue(
      new Error(
        "Error invoking remote method 'extension-packages:list-packages': Error: No handler registered for 'extension-packages:list-packages'"
      )
    );
    mocks.listProfileBindings.mockRejectedValue(
      new Error(
        "Error invoking remote method 'extension-packages:list-profile-bindings': Error: No handler registered for 'extension-packages:list-profile-bindings'"
      )
    );

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    expect(
      await screen.findByText('当前运行版本未注册扩展中心主进程能力，请重新构建并重启桌面端后重试。')
    ).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('binds selected packages to selected extension profiles', async () => {
    const mocks = installElectronAPIMocks();
    const onProfileDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={onProfileDataChanged}
      />
    );

    await screen.findByText('Demo Ext');

    const packageRow = screen.getByText('Demo Ext').closest('tr');
    expect(packageRow).toBeTruthy();
    const packageCheckbox = within(packageRow as HTMLElement).getByRole('checkbox');
    fireEvent.click(packageCheckbox);

    fireEvent.click(screen.getByRole('button', { name: '批量绑定' }));
    fireEvent.click(screen.getByRole('button', { name: '全选' }));

    await screen.findByText(/已选环境 2 个/);
    expect(screen.queryByText('Electron-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '批量绑定到已选环境' }));

    await waitFor(() => expect(mocks.batchBind).toHaveBeenCalledTimes(1));

    expect(mocks.batchBind).toHaveBeenCalledWith({
      profileIds: ['ext-1', 'ext-2'],
      packages: [
        {
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          version: '1.0.0',
          installMode: 'required',
          sortOrder: 0,
          enabled: true,
        },
      ],
    });
    expect(onProfileDataChanged).toHaveBeenCalledWith({ refreshRunning: false });
  });

  it('requires confirmation before binding when selected profiles already have running browsers', async () => {
    const mocks = installElectronAPIMocks({
      runningBrowsers: [{ id: 'browser-1', sessionId: 'ext-1' }],
      batchBindDestroyedBrowsers: 1,
    });
    const onProfileDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={onProfileDataChanged}
      />
    );

    await screen.findByText('Demo Ext');

    const packageRow = screen.getByText('Demo Ext').closest('tr');
    expect(packageRow).toBeTruthy();
    const packageCheckbox = within(packageRow as HTMLElement).getByRole('checkbox');
    fireEvent.click(packageCheckbox);

    fireEvent.click(screen.getByRole('button', { name: '批量绑定' }));
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    await screen.findByText(/已选环境 2 个/);

    fireEvent.click(screen.getByRole('button', { name: '批量绑定到已选环境' }));

    expect(await screen.findByText('检测到运行中实例')).toBeInTheDocument();
    expect(mocks.batchBind).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '继续并关闭实例' }));
    await waitFor(() => expect(mocks.batchBind).toHaveBeenCalledTimes(1));
    expect(onProfileDataChanged).toHaveBeenCalledWith({ refreshRunning: true });
  });

  it('does not auto-select extension profiles by default', async () => {
    installElectronAPIMocks();

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    await screen.findByText('Demo Ext');
    fireEvent.click(screen.getByRole('button', { name: '批量绑定' }));

    await screen.findByText(/已选环境 0 个/);
  });

  it('keeps bind success when runtime restart fails and reports a warning', async () => {
    const mocks = installElectronAPIMocks({
      batchBindRestartFailures: [{ profileId: 'ext-1', error: 'destroy failed' }],
    });
    const onProfileDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={onProfileDataChanged}
      />
    );

    await screen.findByText('Demo Ext');

    const packageRow = screen.getByText('Demo Ext').closest('tr');
    expect(packageRow).toBeTruthy();
    fireEvent.click(within(packageRow as HTMLElement).getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: '批量绑定' }));
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    await screen.findByText(/已选环境 2 个/);

    fireEvent.click(screen.getByRole('button', { name: '批量绑定到已选环境' }));

    await waitFor(() => expect(mocks.batchBind).toHaveBeenCalledTimes(1));
    expect(onProfileDataChanged).toHaveBeenCalledWith({ refreshRunning: true });
    expect(toastSuccess).toHaveBeenCalledWith('绑定完成', '已为 2 个环境绑定 1 个扩展');
    expect(toastWarning).toHaveBeenCalledWith(
      '绑定已保存，但部分后续操作未完成',
      '有 1 个环境的运行中实例未能自动关闭'
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('shows a dedicated message when cloud catalog view permission is denied', async () => {
    cloudAuthState.authState = 'ready';
    cloudAuthState.session.loggedIn = true;
    const mocks = installElectronAPIMocks({
      catalogCapabilities: {
        actions: {
          view: false,
          install: false,
        },
      },
    });

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mocks.getCatalogCapabilities).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText('当前账号没有云端扩展目录查看权限。')).toBeInTheDocument();
    expect(mocks.listCatalog).not.toHaveBeenCalled();
  });

  it('loads browser extension catalog from dedicated cloud namespace', async () => {
    cloudAuthState.authState = 'ready';
    cloudAuthState.session.loggedIn = true;
    installElectronAPIMocks({
      catalogItems: [
        {
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'Browser Extension Demo A',
          currentVersion: '1.0.0',
          canInstall: true,
          installReason: 'OK',
        },
        {
          extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          name: 'Browser Extension Demo B',
          currentVersion: '1.0.0',
          canInstall: true,
          installReason: 'OK',
        },
      ],
    });

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    expect(await screen.findByText('Browser Extension Demo A')).toBeInTheDocument();
    expect(screen.getByText('Browser Extension Demo B')).toBeInTheDocument();
  });

  it('keeps download success when cloud import is partially successful', async () => {
    cloudAuthState.authState = 'ready';
    cloudAuthState.session.loggedIn = true;
    const mocks = installElectronAPIMocks({
      catalogItems: [
        {
          extensionId: 'cccccccccccccccccccccccccccccccc',
          name: 'Browser Extension Good',
          currentVersion: '1.0.0',
          canInstall: true,
          installReason: 'OK',
        },
        {
          extensionId: 'dddddddddddddddddddddddddddddddd',
          name: 'Browser Extension Bad',
          currentVersion: '1.0.0',
          canInstall: true,
          installReason: 'OK',
        },
      ],
    });
    mocks.downloadCloudCatalogPackages.mockResolvedValue({
      success: true,
      data: {
        succeeded: [
          {
            id: 'pkg-2',
            extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            name: 'Browser Extension Good',
            version: '1.0.0',
            sourceType: 'cloud',
            extractDir: 'D:/tmp/ext/pkg-2',
            enabled: true,
            createdAt: new Date('2026-02-26T10:00:00.000Z'),
            updatedAt: new Date('2026-02-26T10:00:00.000Z'),
          },
        ],
        failed: [
          {
            extensionId: 'dddddddddddddddddddddddddddddddd',
            error: 'download failed',
          },
        ],
      },
    });

    render(
      <ExtensionPackagesPanel
        profiles={profileMockState.profiles as BrowserProfile[]}
        onProfileDataChanged={vi.fn()}
      />
    );

    const goodRow = (await screen.findByText('Browser Extension Good')).closest('tr');
    const badRow = screen.getByText('Browser Extension Bad').closest('tr');
    expect(goodRow).toBeTruthy();
    expect(badRow).toBeTruthy();

    fireEvent.click(within(goodRow as HTMLElement).getByRole('checkbox'));
    fireEvent.click(within(badRow as HTMLElement).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '下载并导入已选云端扩展' }));

    await waitFor(() => {
      expect(mocks.downloadCloudCatalogPackages).toHaveBeenCalledTimes(1);
    });

    expect(toastSuccess).toHaveBeenCalledWith('下载完成', '成功 1 个，失败 1 个');
    expect(toastWarning).toHaveBeenCalledWith('部分下载失败', 'download failed');
    expect(toastError).not.toHaveBeenCalled();
  });
});

