import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SortPanel } from '../panels/SortPanel';

const storeState = {
  updateActiveQueryTemplate: vi.fn().mockResolvedValue(undefined),
  activeQueryConfig: undefined as
    | {
        sort?: {
          columns?: Array<{
            field: string;
            direction: 'ASC' | 'DESC';
            nullsFirst?: boolean;
          }>;
        };
      }
    | undefined,
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
      { name: 'amount', type: 'DOUBLE', fieldType: 'number' },
      { name: 'created_at', type: 'TIMESTAMP', fieldType: 'date' },
    ],
  }),
}));

vi.mock('../../common/AnchoredPanel', () => ({
  AnchoredPanel: ({ title, children }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    warning: vi.fn(),
  },
}));

describe('SortPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.activeQueryConfig = undefined;
  });

  it('adds and removes sort columns before applying the remaining config', async () => {
    const onClose = vi.fn();

    render(<SortPanel datasetId="ds1" onClose={onClose} />);

    const [initialSelect] = screen.getAllByRole('combobox');
    fireEvent.change(initialSelect, { target: { value: 'name' } });

    const selectsAfterFirstAdd = screen.getAllByRole('combobox');
    fireEvent.change(selectsAfterFirstAdd[1] as HTMLSelectElement, {
      target: { value: 'amount' },
    });

    fireEvent.click(screen.getAllByTitle('删除排序')[1] as HTMLButtonElement);
    fireEvent.click(screen.getByText('应用并刷新结果'));

    await waitFor(() => {
      expect(storeState.updateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        sort: {
          columns: [{ field: 'name', direction: 'ASC', nullsFirst: false }],
        },
      });
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('moves sort priority up and down before applying', async () => {
    const onClose = vi.fn();
    storeState.activeQueryConfig = {
      sort: {
        columns: [
          { field: 'name', direction: 'ASC', nullsFirst: false },
          { field: 'amount', direction: 'DESC', nullsFirst: false },
        ],
      },
    };

    render(<SortPanel datasetId="ds1" onClose={onClose} />);

    fireEvent.click(screen.getAllByTitle('下移')[0] as HTMLButtonElement);
    fireEvent.click(screen.getByText('应用并刷新结果'));

    await waitFor(() => {
      expect(storeState.updateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        sort: {
          columns: [
            { field: 'amount', direction: 'DESC', nullsFirst: false },
            { field: 'name', direction: 'ASC', nullsFirst: false },
          ],
        },
      });
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('clears saved sort config when cancelling sort', async () => {
    const onClose = vi.fn();
    storeState.activeQueryConfig = {
      sort: {
        columns: [{ field: 'name', direction: 'ASC', nullsFirst: false }],
      },
    };

    render(<SortPanel datasetId="ds1" onClose={onClose} />);

    fireEvent.click(screen.getByText('取消排序'));

    await waitFor(() => {
      expect(storeState.updateActiveQueryTemplate).toHaveBeenCalledWith('ds1', {
        sort: undefined,
      });
    });

    expect(onClose).toHaveBeenCalled();
  });
});
