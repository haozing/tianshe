import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetToolbar } from '../DatasetToolbar';

const storeState = vi.hoisted(() => ({
  activeQueryConfig: {
    clean: [
      { field: 'name', operations: [{ type: 'trim' }] },
      { field: 'email', operations: [{ type: 'lower' }] },
    ],
    filter: {
      conditions: [],
    },
    sort: {
      columns: [],
    },
    sample: null as null | Record<string, unknown>,
  },
}));

const toolbarHookState = vi.hoisted(() => ({
  toolbarButtons: [] as Array<{
    id: string;
    label: string;
    icon?: string;
    requiresSelection?: boolean;
    minSelection?: number;
    maxSelection?: number;
  }>,
  executeToolbarButton: vi.fn(),
}));

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  selectActiveQueryConfig: (state: typeof storeState) => state.activeQueryConfig,
}));

vi.mock('../../../hooks/useJSPluginUIExtensions', () => ({
  useToolbarButtons: () => toolbarHookState,
}));

vi.mock('../TanStackDataTable/ToolbarButton', () => ({
  JSPluginToolbarButton: ({
    button,
    variant,
  }: {
    button: { label: string };
    variant?: 'toolbar' | 'menu';
  }) => (
    <button type="button" role={variant === 'menu' ? 'menuitem' : undefined}>
      {button.label}
    </button>
  ),
}));

describe('DatasetToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.activeQueryConfig.clean = [
      { field: 'name', operations: [{ type: 'trim' }] },
      { field: 'email', operations: [{ type: 'lower' }] },
    ];
    storeState.activeQueryConfig.filter = { conditions: [] };
    storeState.activeQueryConfig.sort = { columns: [] };
    storeState.activeQueryConfig.sample = null;
    toolbarHookState.toolbarButtons = [];
  });

  it('shows the clean badge count from activeQueryConfig.clean', () => {
    render(<DatasetToolbar datasetId="ds1" />);

    expect(screen.getByTitle('清洗')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders create-tab-copy action inside the toolbar when provided', () => {
    const onCreateTabCopy = vi.fn();

    render(<DatasetToolbar datasetId="ds1" onCreateTabCopy={onCreateTabCopy} />);

    fireEvent.click(screen.getByRole('button', { name: '复制为新标签页' }));
    expect(onCreateTabCopy).toHaveBeenCalledTimes(1);
  });

  it('keeps the main actions inside a horizontal toolbar strip and uses shell menu styling for more actions', () => {
    storeState.activeQueryConfig.sample = { mode: 'rows', value: 10 };

    const { container } = render(<DatasetToolbar datasetId="ds1" onSample={vi.fn()} />);

    expect(container.querySelector('.overflow-x-auto')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '更多' }));

    expect(container.querySelector('.shell-field-panel')).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: '更多功能菜单' })).toBeInTheDocument();
    expect(screen.getByText('行高设置')).toBeInTheDocument();
    expect(screen.getByText('已配置')).toBeInTheDocument();
  });

  it('closes the more menu on Escape and restores trigger focus', () => {
    render(<DatasetToolbar datasetId="ds1" />);

    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.click(moreButton);

    expect(screen.getByRole('menu', { name: '更多功能菜单' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: '更多功能菜单' })).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();
  });

  it('shows plugin actions inside the same shell menu language', () => {
    toolbarHookState.toolbarButtons = [
      {
        id: 'plugin-action-1',
        label: '插件动作',
        icon: 'zap',
        requiresSelection: false,
        minSelection: 0,
      },
    ];

    const { container } = render(<DatasetToolbar datasetId="ds1" />);

    fireEvent.click(screen.getByRole('button', { name: '插件' }));

    expect(container.querySelector('.shell-field-panel')).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: '插件功能菜单' })).toBeInTheDocument();
    expect(screen.getByText('插件功能')).toBeInTheDocument();
    expect(screen.getByText('插件动作')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插件动作' })).toBeInTheDocument();
  });

  it('disables primary write actions in read-only mode', () => {
    toolbarHookState.toolbarButtons = [
      {
        id: 'plugin-action-1',
        label: '插件动作',
        icon: 'zap',
        requiresSelection: false,
        minSelection: 0,
      },
    ];

    render(<DatasetToolbar datasetId="ds1" readOnly />);

    expect(screen.getByTitle('数据未就绪，暂不支持新增记录')).toBeDisabled();
    expect(screen.getByTitle('数据未就绪，暂不支持执行插件操作')).toBeDisabled();
    expect(screen.getByTitle('数据未就绪，暂不支持清洗')).toBeDisabled();
  });
});
