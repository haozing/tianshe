import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatasetFields } from './useDatasetFields';

const storeState = {
  currentDataset: null as any,
};

const mockGetDatasetInfo = vi.fn();

vi.mock('../stores/datasetStore', () => ({
  useDatasetStore: (selector?: any) => (selector ? selector(storeState) : storeState),
}));

vi.mock('../services/datasets/datasetFacade', () => ({
  datasetFacade: {
    getDatasetInfo: (...args: any[]) => mockGetDatasetInfo(...args),
  },
}));

function Probe({ datasetId }: { datasetId: string }) {
  const { availableFields, currentDataset, isLoading } = useDatasetFields(datasetId);

  return (
    <div>
      <div data-testid="dataset-id">{currentDataset?.id ?? 'none'}</div>
      <div data-testid="fields">{availableFields.map((field) => field.name).join(',')}</div>
      <div data-testid="loading">{String(isLoading)}</div>
    </div>
  );
}

describe('useDatasetFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.currentDataset = null;
    mockGetDatasetInfo.mockResolvedValue({
      success: true,
      dataset: {
        id: 'ds_target',
        schema: [{ name: 'target_field', duckdbType: 'VARCHAR', fieldType: 'text' }],
      },
    });
  });

  it('returns fields for the matching dataset without refetching', async () => {
    storeState.currentDataset = {
      id: 'ds1',
      schema: [
        { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text' },
        { name: 'age', duckdbType: 'INTEGER', fieldType: 'number' },
      ],
    };

    render(<Probe datasetId="ds1" />);

    await waitFor(() => {
      expect(screen.getByTestId('dataset-id').textContent).toBe('ds1');
      expect(screen.getByTestId('fields').textContent).toBe('name,age');
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(mockGetDatasetInfo).not.toHaveBeenCalled();
  });

  it('does not leak fields from another dataset while waiting for the correct schema', async () => {
    storeState.currentDataset = {
      id: 'ds_other',
      schema: [{ name: 'wrong_field', duckdbType: 'VARCHAR', fieldType: 'text' }],
    };

    render(<Probe datasetId="ds_target" />);

    await waitFor(() => {
      expect(screen.getByTestId('dataset-id').textContent).toBe('ds_target');
      expect(screen.getByTestId('fields').textContent).toBe('target_field');
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(mockGetDatasetInfo).toHaveBeenCalledWith('ds_target');
  });
});
