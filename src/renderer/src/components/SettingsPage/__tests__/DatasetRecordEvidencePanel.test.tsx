import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetRecordEvidencePanel } from '../DatasetRecordEvidencePanel';
import { datasetFacade } from '../../../services/datasets/datasetFacade';

vi.mock('../../../services/datasets/datasetFacade', () => ({
  datasetFacade: {
    getRecordEvidence: vi.fn(),
  },
}));

const evidence = {
  datasetId: 'dataset-42',
  rowId: 7,
  limit: 5,
  summary: {
    totalProvenanceRecords: 8,
    returnedProvenanceRecords: 1,
    hasMoreProvenance: true,
    operationCounts: [{ key: 'insert', count: 1 }],
    adapterCounts: [{ key: 'books-to-scrape', count: 1 }],
    runtimeCounts: [{ key: 'chromium-cloak-playwright', count: 1 }],
    traceStatusCounts: [{ key: 'ok', count: 1 }],
  },
  provenance: [
    {
      id: 'prov-1',
      datasetId: 'dataset-42',
      rowId: 7,
      runId: 'run-1',
      operation: 'insert',
      occurredAt: 1710000000000,
      traceId: 'trace-1',
      adapterId: 'books-to-scrape',
      adapterVersion: '1.0.0',
      runtimeId: 'chromium-cloak-playwright',
      sourceUrl: 'https://books.toscrape.com/catalogue/book_1/index.html',
      metadata: { profileId: 'profile-1' },
      before: null,
      after: { title: 'Book One' },
    },
  ],
  sources: [
    {
      id: 'prov-1',
      runId: 'run-1',
      operation: 'insert',
      occurredAt: 1710000000000,
      traceId: 'trace-1',
      adapterId: 'books-to-scrape',
      adapterVersion: '1.0.0',
      runtimeId: 'chromium-cloak-playwright',
      sourceUrl: 'https://books.toscrape.com/catalogue/book_1/index.html',
      profileId: 'profile-1',
    },
  ],
  traceIds: ['trace-1'],
  traces: [
    {
      traceId: 'trace-1',
      summary: { traceId: 'trace-1', status: 'ok' },
      failureBundle: { traceId: 'trace-1', artifacts: [] },
      timeline: { traceId: 'trace-1', events: [{ type: 'extractor.completed' }] },
    },
  ],
};

describe('DatasetRecordEvidencePanel', () => {
  beforeEach(() => {
    vi.mocked(datasetFacade.getRecordEvidence).mockReset();
  });

  it('queries dataset record evidence and renders sources and observation traces', async () => {
    vi.mocked(datasetFacade.getRecordEvidence).mockResolvedValue({
      success: true,
      evidence,
    });

    render(<DatasetRecordEvidencePanel />);

    expect(screen.getByText('尚未查询记录来源')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('数据集 ID'), { target: { value: 'dataset-42' } });
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('返回上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(datasetFacade.getRecordEvidence).toHaveBeenCalledWith('dataset-42', 7, 5);
    });
    expect((await screen.findAllByText('books-to-scrape')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('chromium-cloak-playwright')).toBeInTheDocument();
    expect(screen.getAllByText('trace-1')).toHaveLength(2);
    expect(screen.getByText('1/8 sources')).toBeInTheDocument();
    expect(screen.getByText('more available')).toBeInTheDocument();
    expect(screen.getByText('Evidence Summary')).toBeInTheDocument();
    expect(screen.getByText('insert: 1')).toBeInTheDocument();
    expect(screen.getAllByText('ok: 1')).toHaveLength(2);
    expect(screen.getByText(/extractor.completed/)).toBeInTheDocument();
  });

  it('validates row id before calling the dataset facade', async () => {
    render(<DatasetRecordEvidencePanel />);

    fireEvent.change(screen.getByLabelText('数据集 ID'), { target: { value: 'dataset-42' } });
    fireEvent.change(screen.getByLabelText('行号'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByText(/行号必须是正整数/)).toBeInTheDocument();
    expect(datasetFacade.getRecordEvidence).not.toHaveBeenCalled();
  });
});
