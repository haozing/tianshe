import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SamplePanel } from '../panels/SamplePanel';

const storeState = {
  activeQueryConfig: {
    filter: {
      combinator: 'AND' as const,
      conditions: [{ type: 'equal' as const, field: 'status', value: 'active' }],
    },
    sort: {
      topK: 5,
    },
  },
};

const previewDatasetSample = vi.fn();

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  selectActiveQueryConfig: (state: typeof storeState) => state.activeQueryConfig,
}));

vi.mock('../../../hooks', () => ({
  useDatasetFields: () => ({
    currentDataset: { id: 'ds1', rowCount: 100 },
    availableFields: [
      { name: 'status', type: 'VARCHAR', fieldType: 'text' },
      { name: 'city', type: 'VARCHAR', fieldType: 'text' },
    ],
  }),
}));

vi.mock('../../../services/datasets/datasetPanelService', () => ({
  previewDatasetSample: (...args: any[]) => previewDatasetSample(...args),
}));

vi.mock('../../common/AnchoredPanel', () => ({
  AnchoredPanel: ({ children, title }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../common/OperationLoadingState', () => ({
  OperationLoadingState: ({ loading }: { loading: boolean }) =>
    loading ? <div data-testid="sample-preview-loading">loading</div> : null,
  PreviewStats: ({ label, value, description }: any) => (
    <div>
      <div>{label}</div>
      <div>{value}</div>
      <div>{description}</div>
    </div>
  ),
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    warning: vi.fn(),
  },
}));

describe('SamplePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    previewDatasetSample.mockResolvedValue({
      sampleSize: 5,
      samplingRatio: 0.5,
      stats: {
        originalRows: 10,
        selectedRows: 5,
        method: 'percentage',
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the full active query config into sample preview', async () => {
    render(<SamplePanel datasetId="ds1" onClose={vi.fn()} onApply={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(previewDatasetSample).toHaveBeenCalledWith(
      'ds1',
      {
        type: 'percentage',
        value: 10,
        stratifyBy: undefined,
        seed: undefined,
      },
      {
        filter: {
          combinator: 'AND',
          conditions: [{ type: 'equal', field: 'status', value: 'active' }],
        },
        sort: {
          topK: 5,
        },
        sample: undefined,
      }
    );
  });

  it('clears the loading state when switching to stratified mode without fields', async () => {
    render(<SamplePanel datasetId="ds1" onClose={vi.fn()} onApply={vi.fn()} />);

    expect(screen.getByTestId('sample-preview-loading')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /分层采样/ }));
    });

    expect(screen.queryByTestId('sample-preview-loading')).toBeNull();
  });
});
