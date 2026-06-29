import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LookupPanel } from '../panels/LookupPanel';

const { storeState, previewDatasetLookup, toast, datasetFieldsById } = vi.hoisted(() => ({
  storeState: {
    datasets: [
      { id: 'ds1', name: '主表', rowCount: 10 },
      { id: 'lookup_ds', name: '维表', rowCount: 5 },
    ],
    activeQueryConfig: {
      lookup: [
        {
          type: 'join' as const,
          joinKey: 'category',
          lookupDatasetId: 'lookup_ds',
          lookupKey: 'code',
          selectColumns: ['label'],
          leftJoin: true,
        },
        {
          type: 'map' as const,
          joinKey: 'status',
          lookupKey: 'status_label',
          codeMapping: {
            active: 'ACTIVE',
          },
        },
      ],
    },
  },
  previewDatasetLookup: vi.fn(),
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
  },
  datasetFieldsById: {
    ds1: {
      currentDataset: { id: 'ds1', rowCount: 10 },
      availableFields: [
        { name: 'category', type: 'VARCHAR', fieldType: 'text' },
        { name: 'status', type: 'VARCHAR', fieldType: 'text' },
      ],
      isLoading: false,
    },
    lookup_ds: {
      currentDataset: { id: 'lookup_ds', rowCount: 5 },
      availableFields: [
        { name: 'code', type: 'VARCHAR', fieldType: 'text' },
        { name: 'label', type: 'VARCHAR', fieldType: 'text' },
      ],
      isLoading: false,
    },
    empty: {
      currentDataset: null,
      availableFields: [],
      isLoading: false,
    },
  },
}));

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  selectActiveQueryConfig: (state: typeof storeState) => state.activeQueryConfig,
}));

vi.mock('../../../hooks', () => ({
  useDatasetFields: (datasetId: string) => datasetFieldsById[datasetId] ?? datasetFieldsById.empty,
}));

vi.mock('../../../services/datasets/datasetPanelService', () => ({
  previewDatasetLookup: (...args: any[]) => previewDatasetLookup(...args),
}));

vi.mock('../../../lib/toast', () => ({
  toast,
}));

vi.mock('../../common/AnchoredPanel', () => ({
  AnchoredPanel: ({ title, children }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../common/OperationLoadingState', () => ({
  OperationLoadingState: ({ loading }: { loading: boolean }) =>
    loading ? <div data-testid="lookup-preview-loading">loading</div> : null,
  PreviewStats: ({ label, value, description }: any) => (
    <div>
      <div>{label}</div>
      <div>{value}</div>
      <div>{description}</div>
    </div>
  ),
  PreviewTable: ({ title }: { title: string }) => <div>{title}</div>,
  PreviewWarning: ({ message }: { message: string }) => <div>{message}</div>,
}));

describe('LookupPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.activeQueryConfig = {
      lookup: [
        {
          type: 'join',
          joinKey: 'category',
          lookupDatasetId: 'lookup_ds',
          lookupKey: 'code',
          selectColumns: ['label'],
          leftJoin: true,
        },
        {
          type: 'map',
          joinKey: 'status',
          lookupKey: 'status_label',
          codeMapping: {
            active: 'ACTIVE',
          },
        },
      ],
    };
    previewDatasetLookup.mockResolvedValue({
      stats: {
        totalRows: 10,
        matchedRows: 8,
        unmatchedRows: 2,
        matchRate: 0.8,
        resultRows: 10,
      },
      sampleMatched: [{ category: 'A' }],
      sampleUnmatched: [{ category: 'X' }],
      steps: [
        {
          index: 0,
          lookup: storeState.activeQueryConfig.lookup[0],
          stats: {
            totalRows: 10,
            matchedRows: 8,
            unmatchedRows: 2,
            matchRate: 0.8,
            resultRows: 10,
          },
          sampleMatched: [{ category: 'A' }],
          sampleUnmatched: [{ category: 'X' }],
          generatedSQL: 'SELECT 1',
        },
        {
          index: 1,
          lookup: storeState.activeQueryConfig.lookup[1],
          stats: {
            totalRows: 10,
            matchedRows: 10,
            unmatchedRows: 0,
            matchRate: 1,
            resultRows: 10,
          },
          sampleMatched: [{ status: 'active' }],
          sampleUnmatched: [],
          generatedSQL: 'SELECT 2',
        },
      ],
      generatedSQL: 'SELECT *',
    });
  });

  it('previews the full lookup chain instead of only the first lookup', async () => {
    render(
      <LookupPanel datasetId="ds1" onClose={vi.fn()} onApply={vi.fn()} anchorEl={null} />
    );

    await waitFor(() => {
      expect(previewDatasetLookup).toHaveBeenCalledWith(
        'ds1',
        expect.arrayContaining([
          expect.objectContaining({ type: 'join', lookupDatasetId: 'lookup_ds' }),
          expect.objectContaining({ type: 'map', lookupKey: 'status_label' }),
        ]),
        { limit: 5 }
      );
    });

    expect(screen.getByText('关联 1 · JOIN')).toBeTruthy();
    expect(screen.getByText('关联 2 · MAP')).toBeTruthy();
    expect(
      screen.getByText('当前关联配置会自动保存到当前查询模板，不需要额外点“保存查询模板”。')
    ).toBeTruthy();
  }, 2000);

  it('blocks apply when map codeMapping JSON is invalid', async () => {
    const onApply = vi.fn();

    render(<LookupPanel datasetId="ds1" onClose={vi.fn()} onApply={onApply} anchorEl={null} />);

    const textareas = screen.getAllByRole('textbox');
    const codeMappingTextarea = textareas[textareas.length - 1] as HTMLTextAreaElement;

    fireEvent.change(codeMappingTextarea, {
      target: { value: '{"active": "ACTIVE"' },
    });

    await waitFor(() => {
      expect(
        screen.getByText('码值映射 JSON 无法解析，当前不会应用这次修改')
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /应用关联/i }));

    expect(toast.warning).toHaveBeenCalledWith('码值映射 JSON 无法解析，当前不会应用这次修改');
    expect(onApply).not.toHaveBeenCalled();
  });
});
