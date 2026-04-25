import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanPanel } from '../panels/CleanPanel';
import type { CleanConfig } from '../../../../../core/query-engine/types';

const materializeDatasetCleanColumns = vi.fn();
const previewDatasetClean = vi.fn();

const previewState = {
  data: null,
  loading: false,
  error: null,
  setData: vi.fn(),
  setError: vi.fn(),
  clearPreview: vi.fn(),
  triggerPreview: vi.fn(),
};

const baseSchema = [
  { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
  { name: 'amount_text', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
];

const storeState = {
  currentDataset: {
    id: 'ds1',
    schema: baseSchema,
  },
  applyLocalDatasetSchema: vi.fn(),
  activeQueryConfig: {} as { clean?: CleanConfig },
};

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  selectActiveQueryConfig: (state: typeof storeState) => state.activeQueryConfig,
}));

vi.mock('../../../hooks', () => ({
  useDatasetFields: () => ({
    availableFields: [
      { name: 'name', type: 'VARCHAR', fieldType: 'text' },
      { name: 'amount_text', type: 'VARCHAR', fieldType: 'text' },
    ],
    currentDataset: { id: 'ds1', schema: baseSchema, rowCount: 2 },
    isLoading: false,
  }),
  usePreviewState: () => previewState,
}));

vi.mock('../../../services/datasets/datasetPanelService', () => ({
  materializeDatasetCleanColumns: (...args: unknown[]) => materializeDatasetCleanColumns(...args),
  previewDatasetClean: (...args: unknown[]) => previewDatasetClean(...args),
}));

vi.mock('../../common/AnchoredPanel', () => ({
  AnchoredPanel: ({ title, children, footer }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
      <div>{footer}</div>
    </div>
  ),
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('CleanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    storeState.currentDataset = {
      id: 'ds1',
      schema: [...baseSchema],
    };
    storeState.activeQueryConfig = {};
  });

  it('restores saved clean config and applies it to the current view', async () => {
    storeState.activeQueryConfig = {
      clean: [
        {
          field: 'name',
          outputField: 'name_clean',
          operations: [{ type: 'lower' }],
        },
      ],
    };

    const onApply = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(<CleanPanel datasetId="ds1" onClose={onClose} onApply={onApply} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('name_clean')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('应用并刷新结果'));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(storeState.activeQueryConfig.clean);
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('supports clearing and saving the current clean config', async () => {
    const cleanConfig: CleanConfig = [
      {
        field: 'name',
        outputField: 'name_clean',
        operations: [{ type: 'trim' }, { type: 'lower' }],
      },
    ];
    storeState.activeQueryConfig = { clean: cleanConfig };

    const onClear = vi.fn().mockResolvedValue(undefined);
    const onSaveAsTemplate = vi.fn();
    const onClose = vi.fn();

    render(
      <CleanPanel
        datasetId="ds1"
        onClose={onClose}
        onApply={vi.fn()}
        onClear={onClear}
        onSaveAsTemplate={onSaveAsTemplate}
      />
    );

    fireEvent.click(screen.getByText('保存为模板'));
    expect(onSaveAsTemplate).toHaveBeenCalledWith(cleanConfig);

    fireEvent.click(screen.getByText('清除清洗'));

    await waitFor(() => {
      expect(onClear).toHaveBeenCalled();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('adds a default trim operation for newly created clean fields', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);

    render(<CleanPanel datasetId="ds1" onClose={vi.fn()} onApply={onApply} />);

    fireEvent.click(screen.getByText('添加清洗字段'));
    fireEvent.click(screen.getByText('应用并刷新结果'));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith([
        {
          field: 'name',
          outputField: undefined,
          operations: [{ type: 'trim' }],
        },
      ]);
    });
  });

  it('materializes new columns using inferred schema types instead of default text', async () => {
    const cleanConfig: CleanConfig = [
      {
        field: 'amount_text',
        outputField: 'amount_number',
        operations: [{ type: 'cast', params: { targetType: 'DOUBLE' } }],
      },
    ];
    storeState.activeQueryConfig = { clean: cleanConfig };
    materializeDatasetCleanColumns.mockResolvedValue({
      createdColumns: ['amount_number'],
      updatedColumns: ['amount_number'],
    });

    render(<CleanPanel datasetId="ds1" onClose={vi.fn()} onApply={vi.fn()} />);

    fireEvent.click(screen.getByText('写入新列'));

    await waitFor(() => {
      expect(materializeDatasetCleanColumns).toHaveBeenCalledWith('ds1', cleanConfig);
      expect(storeState.applyLocalDatasetSchema).toHaveBeenCalled();
    });

    const appliedSchema = storeState.applyLocalDatasetSchema.mock.calls[0][1];
    const createdColumn = appliedSchema.find((column: any) => column.name === 'amount_number');

    expect(createdColumn).toEqual(
      expect.objectContaining({
        name: 'amount_number',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
      })
    );
  });
});
