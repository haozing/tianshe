import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockExecuteActionColumn = vi.hoisted(() => vi.fn());
const mockGetPlugin = vi.hoisted(() => vi.fn());
const mockListPlugins = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../services/datasets/pluginFacade', () => ({
  pluginFacade: {
    listPlugins: mockListPlugins,
    getPlugin: mockGetPlugin,
    executeActionColumn: mockExecuteActionColumn,
  },
}));

import { ButtonField } from '../fields/ButtonField';
import { ButtonCell } from '../TanStackDataTable/ButtonCell';
import { toast } from '../../../lib/toast';

describe('button metadata interop', () => {
  beforeEach(() => {
    mockListPlugins.mockReset();
    mockGetPlugin.mockReset();
    mockExecuteActionColumn.mockReset();
    vi.clearAllMocks();
    (window as any).electronAPI = {
      ...(window as any).electronAPI,
      jsPlugin: {
        ...(window as any).electronAPI?.jsPlugin,
        list: mockListPlugins,
        executeActionColumn: mockExecuteActionColumn,
      },
    };
    mockListPlugins.mockResolvedValue({
      success: true,
      plugins: [{ id: 'plugin-1' }],
    });
    mockGetPlugin.mockResolvedValue({
      success: true,
      plugin: { id: 'plugin-1' },
    });
    mockExecuteActionColumn.mockResolvedValue({
      success: true,
      result: {},
    });
  });

  it('ButtonField treats plugin-based metadata as configured', () => {
    render(
      <ButtonField
        metadata={{
          pluginId: 'plugin-1',
          methodId: 'run',
          buttonLabel: 'Run',
          buttonVariant: 'success',
          parameterBindings: [{ parameterName: 'name', bindingType: 'field', fieldName: 'name' }],
        }}
      />
    );

    expect(screen.getByText('已配置动作')).toBeInTheDocument();
    expect(screen.getByText('1 个绑定')).toBeInTheDocument();
  });

  it('ButtonCell maps legacy button colors to canonical variants', () => {
    render(
      <ButtonCell
        rowData={{ _row_id: 1 }}
        datasetId="dataset-1"
        metadata={{
          pluginId: 'plugin-1',
          methodId: 'run',
          buttonLabel: 'Run',
          buttonColor: 'red',
        }}
      />
    );

    expect(screen.getByRole('button', { name: /Run/ })).toHaveClass('bg-red-600');
  });

  it('ButtonCell surfaces failure state and toast when action execution fails', async () => {
    mockListPlugins.mockResolvedValue({
      success: true,
      plugins: [],
    });

    render(
      <ButtonCell
        rowData={{ _row_id: 1 }}
        datasetId="dataset-1"
        metadata={{
          pluginId: 'missing-plugin',
          methodId: 'missing-method',
          buttonLabel: '执行',
          buttonVariant: 'success',
        }}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /执行/ }));

    await waitFor(() => {
      expect(mockListPlugins).toHaveBeenCalledTimes(1);
      expect(mockGetPlugin).not.toHaveBeenCalled();
      expect(mockExecuteActionColumn).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /失败/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /失败/ })).toHaveAttribute(
        'title',
        '上次失败: Plugin missing-plugin is not installed. Please install it first.'
      );
      expect(toast.error).toHaveBeenCalledWith(
        '执行失败: Plugin missing-plugin is not installed. Please install it first.'
      );
    });
  });
});
