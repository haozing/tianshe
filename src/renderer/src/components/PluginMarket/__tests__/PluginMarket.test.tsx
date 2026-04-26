import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginMarket } from '../PluginMarket';

const pluginStoreState = vi.hoisted(() => ({
  plugins: [
    {
      id: 'local-plugin',
      name: '本地调试插件',
      author: 'Airpa',
      description: '用于本地调试的插件',
      category: '调试',
      version: '1.0.0',
      installedAt: '2026-04-10T08:00:00.000Z',
      path: 'D:/plugins/local-plugin',
      sourcePath: 'D:/workspace/local-plugin',
      sourceType: 'local_private',
      installChannel: 'manual_import',
      enabled: true,
      devMode: true,
      isSymlink: false,
      hotReloadEnabled: true,
      policyVersion: '101',
      cloudPluginCode: '',
      cloudReleaseVersion: '',
    },
    {
      id: 'cloud-plugin',
      name: '云端插件',
      author: 'Cloud Team',
      description: '用于云端发布的插件',
      category: '生产',
      version: '2.1.0',
      installedAt: '2026-04-10T09:00:00.000Z',
      path: 'D:/plugins/cloud-plugin',
      sourceType: 'cloud_managed',
      installChannel: 'cloud_download',
      enabled: false,
      devMode: false,
      isSymlink: false,
      hotReloadEnabled: false,
      policyVersion: '102',
      cloudPluginCode: 'cloud.plugin.demo',
      cloudReleaseVersion: '2.1.0',
    },
  ],
  pluginsLoading: false,
  searchQuery: '',
  expandedPlugins: new Set(['local-plugin']),
  loadPlugins: vi.fn().mockResolvedValue(undefined),
  installPlugin: vi.fn().mockResolvedValue(undefined),
  uninstallPlugin: vi.fn().mockResolvedValue(undefined),
  enablePlugin: vi.fn().mockResolvedValue(undefined),
  disablePlugin: vi.fn().mockResolvedValue(undefined),
  reloadPlugin: vi.fn().mockResolvedValue(undefined),
  repairPlugin: vi.fn().mockResolvedValue(undefined),
  openPluginDirectory: vi.fn(),
  toggleHotReload: vi.fn().mockResolvedValue(undefined),
  setSearchQuery: vi.fn(),
  togglePluginExpanded: vi.fn(),
}));

const pluginRuntimeStoreState = vi.hoisted(() => ({
  statuses: {
    'local-plugin': {
      pluginId: 'local-plugin',
      pluginName: '本地调试插件',
      lifecyclePhase: 'active',
      workState: 'busy',
      activeQueues: 1,
      runningTasks: 1,
      pendingTasks: 1,
      failedTasks: 0,
      cancelledTasks: 0,
      currentSummary: '本地调试插件 · 正在执行批量任务',
      currentOperation: '批量任务',
      progressPercent: 40,
      updatedAt: 1712736000000,
      lastActivityAt: 1712736000000,
    },
    'cloud-plugin': {
      pluginId: 'cloud-plugin',
      pluginName: '云端插件',
      lifecyclePhase: 'disabled',
      workState: 'idle',
      activeQueues: 0,
      runningTasks: 0,
      pendingTasks: 0,
      failedTasks: 0,
      cancelledTasks: 0,
      updatedAt: 1712736000000,
    },
  },
  loading: false,
  error: null,
  loadStatuses: vi.fn().mockResolvedValue(undefined),
  cancelPluginTasks: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(() => vi.fn()),
  reset: vi.fn(),
}));

vi.mock('../../../stores/pluginStore', () => ({
  usePluginStore: (selector?: (state: typeof pluginStoreState) => unknown) =>
    typeof selector === 'function' ? selector(pluginStoreState) : pluginStoreState,
}));

vi.mock('../../../stores/pluginRuntimeStore', () => ({
  usePluginRuntimeStore: (selector?: (state: typeof pluginRuntimeStoreState) => unknown) =>
    typeof selector === 'function' ? selector(pluginRuntimeStoreState) : pluginRuntimeStoreState,
}));

vi.mock('../CloudPluginCatalogPanel', () => ({
  CloudPluginCatalogPanel: () => (
    <div data-testid="plugin-catalog-panel">CloudPluginCatalogPanel</div>
  ),
}));

vi.mock('../UninstallPluginDialog', () => ({
  UninstallPluginDialog: () => null,
}));

vi.mock('../PluginConfigDialog', () => ({
  PluginConfigDialog: () => null,
}));

describe('PluginMarket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getAppInfo: vi.fn().mockResolvedValue({
          info: {
            shouldShowDevOptions: true,
            isPackaged: false,
          },
        }),
      },
      configurable: true,
    });
  });

  it('renders the home overview with runtime-focused sections by default', async () => {
    render(<PluginMarket />);

    expect(screen.getByRole('heading', { name: '插件中心' })).toBeInTheDocument();

    await waitFor(() => {
      expect(pluginStoreState.loadPlugins).toHaveBeenCalledTimes(1);
      expect(pluginRuntimeStoreState.loadStatuses).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('button', { name: '首页' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '云端目录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已安装' })).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-catalog-panel')).not.toBeInTheDocument();
    expect(screen.getByText('插件运行总览')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByText('当前运行')).toBeInTheDocument();
    expect(screen.getAllByText('需要处理').length).toBeGreaterThan(0);
    expect(screen.getByText('全部运行态')).toBeInTheDocument();
    expect(screen.getByText('运行中插件')).toBeInTheDocument();
    expect(screen.getAllByText('本地调试插件').length).toBeGreaterThan(0);
    expect(screen.getAllByText('本地调试插件 · 正在执行批量任务').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '浏览云端目录' })).not.toBeInTheDocument();
  });

  it('switches to the installed workspace with grouped plugin sections', async () => {
    render(<PluginMarket />);

    fireEvent.click(screen.getByRole('button', { name: '已安装' }));

    await waitFor(() => {
      expect(pluginStoreState.loadPlugins).toHaveBeenCalledTimes(1);
      expect(pluginRuntimeStoreState.loadStatuses).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('heading', { name: '已安装插件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新列表' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入压缩包' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开发模式导入' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('搜索插件名称、ID、作者、描述或分类...')
    ).toBeInTheDocument();
    expect(screen.getByText('自动匹配名称、ID、作者、描述和分类')).toBeInTheDocument();
    expect(screen.getByText('运行中 1')).toBeInTheDocument();
    expect(screen.getByText('异常 0')).toBeInTheDocument();

    expect(screen.getByText('本地插件')).toBeInTheDocument();
    expect(screen.getByText('云插件')).toBeInTheDocument();
    expect(screen.getByText('本地调试插件')).toBeInTheDocument();
    expect(screen.getByText('云端插件')).toBeInTheDocument();
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0);
    expect(screen.getByText('已禁用')).toBeInTheDocument();
    expect(screen.getAllByText('本地调试插件 · 正在执行批量任务').length).toBeGreaterThan(0);
    expect(screen.getByText('D:/plugins/local-plugin')).toBeInTheDocument();
    expect(screen.getByText('D:/workspace/local-plugin')).toBeInTheDocument();
  });

  it('hides the cloud catalog tab in the open edition', async () => {
    render(<PluginMarket />);

    await waitFor(() => {
      expect(pluginStoreState.loadPlugins).toHaveBeenCalledTimes(1);
      expect(pluginRuntimeStoreState.loadStatuses).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByRole('button', { name: '云端目录' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('plugin-catalog-panel')).not.toBeInTheDocument();
  });

  it('allows stopping tasks for a busy plugin', async () => {
    render(<PluginMarket />);

    const stopButtons = await screen.findAllByRole('button', { name: '停止任务' });
    fireEvent.click(stopButtons[0]);

    expect(pluginRuntimeStoreState.cancelPluginTasks).toHaveBeenCalledWith(
      'local-plugin',
      '本地调试插件'
    );
  });
});
