import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterRow } from '../panels/FilterRow';

describe('FilterRow', () => {
  it('switches to between mode and updates range values', () => {
    const onUpdate = vi.fn();

    const { rerender } = render(
      <FilterRow
        filterId="filter_1"
        filter={{ type: 'equal', field: 'price', value: '10' }}
        availableFields={[{ name: 'price', type: 'DOUBLE' }]}
        onUpdate={onUpdate}
        onRemove={vi.fn()}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'between' } });
    expect(onUpdate).toHaveBeenCalledWith('filter_1', {
      type: 'between',
      value: undefined,
      values: ['', ''],
      options: undefined,
    });

    rerender(
      <FilterRow
        filterId="filter_1"
        filter={{ type: 'between', field: 'price', values: ['', ''] }}
        availableFields={[{ name: 'price', type: 'DOUBLE' }]}
        onUpdate={onUpdate}
        onRemove={vi.fn()}
      />
    );

    onUpdate.mockClear();
    fireEvent.change(screen.getByPlaceholderText('最小值'), { target: { value: '1' } });
    expect(onUpdate).toHaveBeenCalledWith('filter_1', {
      value: undefined,
      values: ['1', ''],
    });
  });

  it('switches to relative time mode and updates its options', () => {
    const onUpdate = vi.fn();

    render(
      <FilterRow
        filter={{ type: 'relative_time', field: 'created_at', options: {} }}
        filterId="filter_2"
        availableFields={[{ name: 'created_at', type: 'TIMESTAMP' }]}
        onUpdate={onUpdate}
        onRemove={vi.fn()}
      />
    );

    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '3' } });
    expect(onUpdate).toHaveBeenCalledWith('filter_2', {
      value: undefined,
      values: undefined,
      options: {
        relativeTimeValue: 3,
        relativeTimeUnit: 'day',
        relativeTimeDirection: 'past',
      },
    });
  });
});
