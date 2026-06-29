import { useMemo, useState } from 'react';
import { AlertCircle, DatabaseZap, Loader2, Search, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { datasetFacade } from '../../services/datasets/datasetFacade';
import type { DatasetRecordEvidenceBundle } from '../../../../main/duckdb/types';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

function getTraceStatus(trace: DatasetRecordEvidenceBundle['traces'][number]): string {
  if (trace.error) {
    return 'error';
  }
  const summary = trace.summary as Record<string, unknown> | null;
  const status = summary && typeof summary.status === 'string' ? summary.status : '';
  return status || 'available';
}

function isEvidenceResponse(
  value: Awaited<ReturnType<typeof datasetFacade.getRecordEvidence>>
): value is { success: true; evidence: DatasetRecordEvidenceBundle } {
  return value.success === true && !!value.evidence;
}

function renderBuckets(buckets: DatasetRecordEvidenceBundle['summary']['operationCounts']) {
  if (!buckets.length) {
    return <span className="text-xs text-muted-foreground">none</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {buckets.map((bucket) => (
        <Badge key={bucket.key} variant="outline">
          {bucket.key}: {bucket.count}
        </Badge>
      ))}
    </div>
  );
}

export function DatasetRecordEvidencePanel() {
  const [datasetId, setDatasetId] = useState('');
  const [rowId, setRowId] = useState('');
  const [limit, setLimit] = useState('20');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<DatasetRecordEvidenceBundle | null>(null);

  const traceStatusCounts = useMemo(() => {
    if (evidence?.summary.traceStatusCounts.length) {
      return evidence.summary.traceStatusCounts.map(
        (bucket) => [bucket.key, bucket.count] as const
      );
    }
    const counts = new Map<string, number>();
    for (const trace of evidence?.traces || []) {
      const status = getTraceStatus(trace);
      counts.set(status, (counts.get(status) || 0) + 1);
    }
    return Array.from(counts.entries());
  }, [evidence]);

  async function loadEvidence() {
    const trimmedDatasetId = datasetId.trim();
    const parsedRowId = Number.parseInt(rowId, 10);
    const parsedLimit = Number.parseInt(limit, 10);

    if (!trimmedDatasetId) {
      setError('请先填写 Dataset ID。');
      return;
    }
    if (!Number.isInteger(parsedRowId) || parsedRowId <= 0) {
      setError('行号必须是正整数。');
      return;
    }
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      setError('返回上限必须是正整数。');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await datasetFacade.getRecordEvidence(
        trimmedDatasetId,
        parsedRowId,
        parsedLimit
      );
      if (!isEvidenceResponse(response)) {
        throw new Error(response.error || 'Dataset record evidence was not returned.');
      }
      setEvidence(response.evidence);
    } catch (caught) {
      setEvidence(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold">
              <DatabaseZap className="h-4 w-4" />
              数据来源追溯
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              查看某条数据记录由哪个采集运行、站点适配器和 trace 写入；通常从数据集行详情带入
              datasetId 和行号。
            </p>
          </div>
          {evidence ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {evidence.summary.returnedProvenanceRecords}/
                {evidence.summary.totalProvenanceRecords} sources
              </Badge>
              <Badge variant="secondary">{evidence.traceIds.length} traces</Badge>
              {evidence.summary.hasMoreProvenance ? (
                <Badge variant="outline">more available</Badge>
              ) : null}
              {traceStatusCounts.map(([status, count]) => (
                <Badge key={status} variant={status === 'error' ? 'destructive' : 'outline'}>
                  {status}: {count}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_120px_auto]">
          <div className="space-y-1">
            <Label htmlFor="dataset-evidence-dataset">数据集 ID</Label>
            <Input
              id="dataset-evidence-dataset"
              placeholder="datasetId"
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dataset-evidence-row">行号</Label>
            <Input
              id="dataset-evidence-row"
              inputMode="numeric"
              placeholder="rowId"
              value={rowId}
              onChange={(event) => setRowId(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dataset-evidence-limit">返回上限</Label>
            <Input
              id="dataset-evidence-limit"
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2 md:w-auto" disabled={loading} onClick={loadEvidence}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              查询
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="font-medium">查询失败：{error}</div>
            <div className="mt-1 text-xs">
              请确认数据集 ID 和行号来自同一条数据记录；如果该行没有来源记录，可从采集历史或 trace
              面板继续排查。
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {!evidence && !error ? (
        <div className="rounded-lg border border-dashed bg-white p-5 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">尚未查询记录来源</div>
          <div className="mt-1">
            从数据集行详情复制 datasetId 和行号后查询。这里不再预填演示值，避免误查不存在的数据。
          </div>
        </div>
      ) : null}

      {evidence ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <section className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Evidence Summary</h3>
                <Badge variant={evidence.summary.hasMoreProvenance ? 'secondary' : 'outline'}>
                  {evidence.summary.returnedProvenanceRecords} shown
                </Badge>
              </div>
              <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="mb-1 font-medium text-muted-foreground">Operations</dt>
                  <dd>{renderBuckets(evidence.summary.operationCounts)}</dd>
                </div>
                <div>
                  <dt className="mb-1 font-medium text-muted-foreground">Adapters</dt>
                  <dd>{renderBuckets(evidence.summary.adapterCounts)}</dd>
                </div>
                <div>
                  <dt className="mb-1 font-medium text-muted-foreground">Runtimes</dt>
                  <dd>{renderBuckets(evidence.summary.runtimeCounts)}</dd>
                </div>
                <div>
                  <dt className="mb-1 font-medium text-muted-foreground">Trace Status</dt>
                  <dd>{renderBuckets(evidence.summary.traceStatusCounts)}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Sources</h3>
                <Badge variant="outline">row {evidence.rowId}</Badge>
              </div>
              <div className="mt-3 space-y-3">
                {evidence.sources.length > 0 ? (
                  evidence.sources.map((source) => (
                    <div key={source.id} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{source.operation}</Badge>
                        <span className="text-sm font-medium">{source.runId}</span>
                      </div>
                      <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                        <div>
                          <dt>Occurred</dt>
                          <dd className="font-mono text-foreground">
                            {formatTime(source.occurredAt)}
                          </dd>
                        </div>
                        <div>
                          <dt>Trace</dt>
                          <dd className="font-mono text-foreground">{source.traceId || '-'}</dd>
                        </div>
                        <div>
                          <dt>Adapter</dt>
                          <dd className="font-mono text-foreground">{source.adapterId || '-'}</dd>
                        </div>
                        <div>
                          <dt>Runtime</dt>
                          <dd className="font-mono text-foreground">{source.runtimeId || '-'}</dd>
                        </div>
                        <div>
                          <dt>Profile</dt>
                          <dd className="font-mono text-foreground">{source.profileId || '-'}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt>Source URL</dt>
                          <dd
                            className="truncate font-mono text-foreground"
                            title={source.sourceUrl || ''}
                          >
                            {source.sourceUrl || '-'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No provenance sources were found for this row.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                <h3 className="text-sm font-semibold">Provenance Ledger</h3>
              </div>
              <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                {formatJson(evidence.provenance)}
              </pre>
            </section>
          </div>

          <section className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Observation Traces</h3>
              <Badge variant="outline">{evidence.traces.length}</Badge>
            </div>
            <div className="mt-3 space-y-3">
              {evidence.traces.length > 0 ? (
                evidence.traces.map((trace) => (
                  <div key={trace.traceId} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-sm">{trace.traceId}</span>
                      <Badge variant={trace.error ? 'destructive' : 'secondary'}>
                        {getTraceStatus(trace)}
                      </Badge>
                    </div>
                    {trace.error ? (
                      <div className="mt-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                        {trace.error}
                      </div>
                    ) : null}
                    <div className="mt-3 grid gap-3 lg:grid-cols-3">
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          Summary
                        </div>
                        <pre className="max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                          {formatJson(trace.summary)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          Failure Bundle
                        </div>
                        <pre className="max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                          {formatJson(trace.failureBundle)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          Timeline
                        </div>
                        <pre className="max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                          {formatJson(trace.timeline)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No observation traces were linked to this row.
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
