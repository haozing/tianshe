import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterPanel } from '../panels/FilterPanel';

const storeState = {
  updateActiveQueryTemplate: vi.fn(),
  clearAllProcessing: vi.fn(),
  activeQueryTemplate: { id: 'tpl_1' },
  activeQueryConfig: {
    filter: {
      combinator: 'AND' as const,
      conditions: [{ type: 'equal' as const, field: 'name', value: 'Alice' }],
    },
  },
};

const previewState = {
  data: null,
  loading: false,
  error: null,
  setData: vi.fn(),
  setError: vi.fn(),
  clearPreview: vi.fn(),
  triggerPreview: vi.fn(),
};

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  selectActiveQueryTemplate: (state: typeof storeState) => state.activeQueryTemplate,
  selectActiveQueryConfig: (state: typeof storeState) => state.activeQueryConfig,
}));

vi.mock('../../../hooks', () => ({
  useDatasetFields: () => ({
    availableFields: [{ name: 'name', type: 'VARCHAR', fieldType: 'text' }],
    currentDataset: { id: 'ds1', rowCount: 3 },
    isLoading: false,
  }),
  usePreviewState: () => previewState,
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

vi.mock('../panels/FilterRow', () => ({
  FilterRow: () => <div data-testid="filter-row">filter-row</div>,
}));

describe('FilterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.activeQueryTemplate = { id: 'tpl_1' };
    storeState.activeQueryConfig = {
      filter: {
        combinator: 'AND',
        conditions: [{ type: 'equal', field: 'name', value: 'Alice' }],
      },
    };
  });

  it('clears only the saved filter', async () => {
    const onClose = vi.fn();

    render(<FilterPanel datasetId="ds1" onClose={onClose} />);

    fireEvent.click(screen.getByText('清除筛选'));

    await waitFor(() => {
      expect(storeState.updateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        filter: undefined,
      });
    });

    expect(storeState.clearAllProcessing).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('applies an empty filter as undefined after local reset', async () => {
    const onClose = vi.fn();

    render(<FilterPanel datasetId="ds1" onClose={onClose} />);

    fireEvent.click(screen.getByText('重置'));

    const applyButton = screen.getByText('应用并刷新结果') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(false);

    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(storeState.updateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        filter: undefined,
      });
    });

    expect(previewState.clearPreview).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
