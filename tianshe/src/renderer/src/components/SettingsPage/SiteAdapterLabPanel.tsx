import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FileInput,
  FlaskConical,
  MousePointer2,
  Play,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription } from '../ui/alert';
import { createPageSnapshotFromHtml } from './siteAdapterLabHtmlImport';
import { createSiteAdapterRepairBundleView } from '../../../../core/site-adapter-lab/repair-bundle-viewer';
import type {
  SiteAdapterFixture,
  SiteAdapterManifest,
} from '../../../../core/site-adapter-runtime';
import type {
  FailureBundle,
  TraceSummary,
  TraceTimeline,
} from '../../../../core/observability/types';
import type { SiteAdapterLabRunnerDiffResult } from '../../../../core/site-adapter-lab/runner-diff';
import type { SiteAdapterRepairBundleView } from '../../../../core/site-adapter-lab/repair-bundle-viewer';
import type { SiteAdapterSelectorWorkbenchResult } from '../../../../core/site-adapter-lab/selector-workbench';
import { siteAdapterRepairStudioFacade } from '../../services/siteAdapterRepairStudioFacade';
import type {
  SiteAdapterRepairStudioModelDiffInput,
  SiteAdapterRepairStudioModelDiffResult,
} from '../../../../main/site-adapter-repair-studio/routes-or-ipc';

type AdapterListItem = { manifest: SiteAdapterManifest };
type RunnerMode = 'fixture' | 'browser' | 'playwright';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(source: string): Record<string, unknown> {
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function getFixtureSnapshotUrl(fixture: SiteAdapterFixture): string {
  const snapshot = fixture.snapshot as { url?: unknown } | null | undefined;
  return typeof snapshot?.url === 'string' ? snapshot.url : '';
}

function runnerStatusLabel(value: string | undefined): string {
  switch (value) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'environment_gap':
      return 'env gap';
    case 'not_configured':
      return 'idle';
    default:
      return 'idle';
  }
}

function runnerStatusVariant(
  value: string | undefined
): 'default' | 'destructive' | 'outline' | 'secondary' {
  switch (value) {
    case 'passed':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'environment_gap':
      return 'secondary';
    default:
      return 'outline';
  }
}

function formatFixtureLoadError(
  adapterId: string,
  fixtureName: string,
  message: string | undefined
): string {
  const details = message ? `后端返回：${message}` : '后端没有返回具体原因。';
  return `无法加载官方样例 ${adapterId}/${fixtureName}。请确认该适配器样例已经接入 Lab 加载器。${details}`;
}

function formatTime(value: number | undefined): string {
  return typeof value === 'number' ? new Date(value).toLocaleTimeString() : '-';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFixture(value: unknown, fixtureName: string) {
  const fixture = asRecord(value);
  return {
    name: asString(fixture.name) || fixtureName,
    input: asRecord(fixture.input),
    snapshot: asRecord(fixture.snapshot),
  };
}

function createLabRepairStudioInput(
  repairBundleView: SiteAdapterRepairBundleView
): SiteAdapterRepairStudioModelDiffInput {
  const repairEvidence = asRecord(repairBundleView.rawData.repairEvidence);
  const adapterId = asString(repairEvidence.adapterId) || repairBundleView.adapterId || '';
  const fixtureName = asString(repairEvidence.fixtureName) || repairBundleView.fixtureName || '';
  const expected = asRecord(repairEvidence.expected);
  const before = asRecord(repairEvidence.before);
  const taskId = ['lab-repair', repairBundleView.traceId, adapterId, fixtureName]
    .filter(Boolean)
    .join(':');

  return {
    kind: 'read-only',
    task: {
      taskId,
      adapterId,
      fixtureName,
      sideEffectLevel: 'read-only',
      missingFields: repairBundleView.missingFields,
      selectorDiagnostics: repairBundleView.diagnostics,
      fixture: asFixture(repairEvidence.fixture, fixtureName),
      expected,
      before,
      allowedChangeGlobs: [
        'site-adapters/<site-id>/extractors/**',
        'site-adapters/<site-id>/verifiers/**',
        'site-adapters/<site-id>/fixtures/**',
        'site-adapters/<site-id>/expected/**',
        'src/site-adapters/<site-id>/extractors/**',
        'src/site-adapters/<site-id>/verifiers/**',
        'src/site-adapters/<site-id>/fixtures/**',
        'src/site-adapters/<site-id>/expected/**',
      ],
      forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
      prompt: {
        objective: 'Generate a scoped read-only Site Adapter repair diff from Lab evidence.',
        constraints: [
          'Only change files under the adapter repair allowlist.',
          'Preserve fixture regression behavior.',
          'Do not modify framework core, main process, shared types, or secrets.',
        ],
      },
    },
  };
}

export function SiteAdapterLabPanel() {
  const htmlFileInputRef = useRef<HTMLInputElement | null>(null);
  const [adapters, setAdapters] = useState<AdapterListItem[]>([]);
  const [adapterId, setAdapterId] = useState('books-to-scrape');
  const [fixtureName, setFixtureName] = useState('product-page');
  const [fixture, setFixture] = useState<SiteAdapterFixture | null>(null);
  const [expectedText, setExpectedText] = useState('{}');
  const [selector, setSelector] = useState('.price_color');
  const [selectorResult, setSelectorResult] = useState<SiteAdapterSelectorWorkbenchResult | null>(
    null
  );
  const [runnerResult, setRunnerResult] = useState<SiteAdapterLabRunnerDiffResult | null>(null);
  const [runnerMode, setRunnerMode] = useState<RunnerMode>('fixture');
  const [targetUrl, setTargetUrl] = useState('');
  const [browserProfileId, setBrowserProfileId] = useState('');
  const [browserRuntimeId, setBrowserRuntimeId] = useState('');
  const [traceId, setTraceId] = useState('');
  const [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);
  const [traceTimeline, setTraceTimeline] = useState<TraceTimeline | null>(null);
  const [failureBundle, setFailureBundle] = useState<FailureBundle | null>(null);
  const [repairBundleView, setRepairBundleView] = useState<SiteAdapterRepairBundleView | null>(
    null
  );
  const [repairStudioResult, setRepairStudioResult] =
    useState<SiteAdapterRepairStudioModelDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedAdapter = useMemo(
    () => adapters.find((adapter) => adapter.manifest.id === adapterId)?.manifest,
    [adapterId, adapters]
  );

  const fixtureOptions = selectedAdapter?.fixtures?.length
    ? selectedAdapter.fixtures
    : [fixtureName];
  const canSaveExpected = Boolean(selectedAdapter?.expected?.includes(fixtureName));

  async function loadAdapters() {
    const response = await window.electronAPI.siteAdapterLab.listAdapters();
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to list adapters');
    }
    setAdapters(response.data);
    if (response.data[0]?.manifest.id && !adapterId) {
      setAdapterId(response.data[0].manifest.id);
    }
  }

  async function loadFixture(nextAdapterId = adapterId, nextFixtureName = fixtureName) {
    const response = await window.electronAPI.siteAdapterLab.loadFixture({
      adapterId: nextAdapterId,
      fixtureName: nextFixtureName,
    });
    if (!response.success || !response.data) {
      throw new Error(formatFixtureLoadError(nextAdapterId, nextFixtureName, response.error));
    }
    setFixture(response.data.fixture);
    setExpectedText(formatJson(response.data.expected));
    setTargetUrl(getFixtureSnapshotUrl(response.data.fixture));
    setSelectorResult(null);
    setRunnerResult(null);
  }

  async function runSelector() {
    if (!fixture) return;
    const response = await window.electronAPI.siteAdapterLab.validateSelector({
      snapshot: fixture.snapshot as never,
      selector,
      limit: 20,
    });
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to validate selector');
    }
    setSelectorResult(response.data);
  }

  async function runFixture() {
    if (!fixture) return;
    const runtimeOptions = {
      enabled: true,
      ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}),
      ...(browserProfileId.trim() ? { profileId: browserProfileId.trim() } : {}),
      ...(browserRuntimeId.trim() ? { runtimeId: browserRuntimeId.trim() } : {}),
      timeoutMs: 30_000,
    };
    const browserRunner = runnerMode === 'browser' ? runtimeOptions : undefined;
    const playwrightLabRunner = runnerMode === 'playwright' ? runtimeOptions : undefined;
    const response = await window.electronAPI.siteAdapterLab.runFixture({
      adapterId,
      fixture,
      expected: parseJsonObject(expectedText),
      ...(browserRunner ? { browserRunner } : {}),
      ...(playwrightLabRunner ? { playwrightLabRunner } : {}),
    });
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to run fixture');
    }
    setRunnerResult(response.data);
  }

  async function saveExpected() {
    if (!fixture) return;
    const response = await window.electronAPI.siteAdapterLab.saveExpected({
      adapterId,
      fixtureName,
      fixture,
      expected: parseJsonObject(expectedText),
    });
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to save expected');
    }
    setRunnerResult(response.data.runner);
  }

  async function loadTraceEvidence() {
    const normalizedTraceId = traceId.trim();
    const [summaryResponse, timelineResponse, failureResponse] = await Promise.all([
      window.electronAPI.observation.getTraceSummary(normalizedTraceId),
      window.electronAPI.observation.getTraceTimeline(normalizedTraceId, 50),
      window.electronAPI.observation.getFailureBundle(normalizedTraceId),
    ]);
    if (!summaryResponse.success || !summaryResponse.data) {
      throw new Error(summaryResponse.error || 'Failed to load trace summary');
    }
    if (!timelineResponse.success || !timelineResponse.data) {
      throw new Error(timelineResponse.error || 'Failed to load trace timeline');
    }
    if (!failureResponse.success || !failureResponse.data) {
      throw new Error(failureResponse.error || 'Failed to load failure bundle');
    }
    const failure = failureResponse.data as FailureBundle;
    const view = createSiteAdapterRepairBundleView(failure);
    setTraceSummary(summaryResponse.data as TraceSummary);
    setTraceTimeline(timelineResponse.data as TraceTimeline);
    setFailureBundle(failure);
    setRepairBundleView(view);
    setRepairStudioResult(null);
  }

  async function generateRepairStudioDiff() {
    if (!repairBundleView) {
      throw new Error('Load a repair bundle before generating a Repair Studio diff');
    }
    const result = await siteAdapterRepairStudioFacade.generateModelDiff(
      createLabRepairStudioInput(repairBundleView)
    );
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to generate Repair Studio diff');
    }
    setRepairStudioResult(result.data);
  }

  async function importHtmlFixture(file: File | null) {
    if (!file) return;
    const html = await file.text();
    const importedName = file.name.replace(/\.[^.]+$/, '') || 'imported-html';
    const snapshot = createPageSnapshotFromHtml(html, `file://${file.name}`);
    const response = await window.electronAPI.siteAdapterLab.captureFixture({
      name: importedName,
      snapshot,
      input: { runner: 'imported-html' },
    });
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to import HTML fixture');
    }
    setFixture(response.data.fixture);
    setFixtureName(response.data.fixture.name);
    setTargetUrl(getFixtureSnapshotUrl(response.data.fixture));
    setExpectedText('{}');
    setSelectorResult(null);
    setRunnerResult(null);
    if (htmlFileInputRef.current) {
      htmlFileInputRef.current.value = '';
    }
  }

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    withBusy(async () => {
      await loadAdapters();
      await loadFixture('books-to-scrape', 'product-page');
    });
  }, []);

  return (
    <div className="flex h-full min-h-[620px] flex-col gap-3">
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="h-4 w-4" />
          站点适配器调试
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          用官方样例或导入的 HTML 快照验证选择器、预期字段和运行器差异；fixture
          模式不会访问真实站点。
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[190px] flex-1 lg:max-w-[260px]">
            <Select
              value={adapterId}
              onValueChange={(value) =>
                withBusy(async () => {
                  setAdapterId(value);
                  const manifest = adapters.find(
                    (adapter) => adapter.manifest.id === value
                  )?.manifest;
                  const nextFixture = manifest?.fixtures?.[0] || 'product-page';
                  setFixtureName(nextFixture);
                  await loadFixture(value, nextFixture);
                })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {adapters.map((adapter) => (
                  <SelectItem key={adapter.manifest.id} value={adapter.manifest.id}>
                    {adapter.manifest.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[160px] flex-1 lg:max-w-[220px]">
            <Select
              value={fixtureName}
              onValueChange={(value) =>
                withBusy(async () => {
                  setFixtureName(value);
                  await loadFixture(adapterId, value);
                })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fixtureOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Input
            className="h-9 min-w-[190px] flex-[2_1_260px]"
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
          />

          <Button
            className="h-9 gap-2"
            variant="outline"
            disabled={busy || !fixture}
            onClick={() => withBusy(runSelector)}
          >
            <MousePointer2 className="h-4 w-4" />
            Selector
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[140px] flex-1 lg:max-w-[170px]">
            <Select
              value={runnerMode}
              onValueChange={(value) => setRunnerMode(value as RunnerMode)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixture">Fixture</SelectItem>
                <SelectItem value="browser">Browser</SelectItem>
                <SelectItem value="playwright">Playwright</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Input
            className="h-9 min-w-[240px] flex-[3_1_360px]"
            value={targetUrl}
            disabled={runnerMode === 'fixture'}
            onChange={(event) => setTargetUrl(event.target.value)}
            placeholder="Target URL"
          />

          <Input
            className="h-9 min-w-[140px] flex-1 lg:max-w-[180px]"
            value={browserProfileId}
            disabled={runnerMode === 'fixture'}
            onChange={(event) => setBrowserProfileId(event.target.value)}
            placeholder="profileId"
          />

          <Input
            className="h-9 min-w-[140px] flex-1 lg:max-w-[180px]"
            value={browserRuntimeId}
            disabled={runnerMode === 'fixture'}
            onChange={(event) => setBrowserRuntimeId(event.target.value)}
            placeholder="runtimeId"
          />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              ref={htmlFileInputRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(event) =>
                withBusy(() => importHtmlFixture(event.currentTarget.files?.[0] || null))
              }
            />

            <Button
              className="h-9 gap-2"
              variant="outline"
              disabled={busy}
              onClick={() => htmlFileInputRef.current?.click()}
            >
              <FileInput className="h-4 w-4" />
              Import HTML
            </Button>

            <Button
              className="h-9 gap-2"
              disabled={busy || !fixture}
              onClick={() => withBusy(runFixture)}
            >
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run
            </Button>

            <Button
              className="h-9 gap-2"
              variant="outline"
              disabled={busy || !fixture || !canSaveExpected}
              onClick={() => withBusy(saveExpected)}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[0.9fr_1.1fr_1fr]">
        <section className="flex min-h-0 flex-col rounded-md border bg-white">
          <div className="flex h-10 items-center justify-between border-b px-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MousePointer2 className="h-4 w-4" />
              Selector Hits
            </div>
            <Badge variant="secondary">{selectorResult?.count ?? 0}</Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="space-y-2">
              {(selectorResult?.hits || []).map((hit) => (
                <div key={`${hit.index}-${hit.selector}`} className="rounded-md border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{hit.selector || hit.tag}</span>
                    <span className="text-xs text-muted-foreground">{hit.tag}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{hit.textPreview}</div>
                </div>
              ))}
              {selectorResult?.fallbackSelectors.length ? (
                <div className="rounded-md border p-2 text-sm">
                  <div className="font-medium">Fallback selectors</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {selectorResult.fallbackSelectors.map((fallback) => (
                      <Badge key={fallback} variant="outline" className="font-mono text-[11px]">
                        {fallback}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-md border bg-white">
          <div className="flex h-10 items-center justify-between border-b px-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FlaskConical className="h-4 w-4" />
              Expected
            </div>
            {runnerResult ? (
              <Badge variant={runnerResult.fixtureRunner.ok ? 'default' : 'destructive'}>
                {runnerResult.fixtureRunner.ok ? 'pass' : 'fail'}
              </Badge>
            ) : null}
          </div>
          <textarea
            className="min-h-0 flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs outline-none"
            spellCheck={false}
            value={expectedText}
            onChange={(event) => setExpectedText(event.target.value)}
          />
        </section>

        <section className="flex min-h-0 flex-col rounded-md border bg-white">
          <div className="flex h-10 items-center justify-between border-b px-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Runner Diff
            </div>
            <Badge variant="outline">{runnerResult?.runnerComparison.driftStatus || 'idle'}</Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="space-y-2">
              {runnerResult ? (
                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  {[
                    ['Fixture', runnerResult.runnerComparison.runners.fixture],
                    ['Browser', runnerResult.runnerComparison.runners.browserSnapshot],
                    ['Playwright', runnerResult.runnerComparison.runners.playwrightLab],
                  ].map(([label, runner]) => (
                    <div key={label as string} className="rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{label as string}</span>
                        <Badge
                          variant={runnerStatusVariant((runner as { status?: string }).status)}
                        >
                          {runnerStatusLabel((runner as { status?: string }).status)}
                        </Badge>
                      </div>
                      {(runner as { message?: string }).message ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {(runner as { message?: string }).message}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {(runnerResult?.expectedDiff || []).map((diagnostic) => (
                <div key={diagnostic.path} className="rounded-md border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{diagnostic.path}</span>
                    <Badge variant={diagnostic.ok ? 'default' : 'destructive'}>
                      {diagnostic.ok ? 'ok' : 'diff'}
                    </Badge>
                  </div>
                  {!diagnostic.ok ? (
                    <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                      {formatJson({ expected: diagnostic.expected, actual: diagnostic.actual })}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="flex min-h-[260px] flex-col rounded-md border bg-white">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4" />
            Trace Evidence
          </div>
          <div className="flex min-w-[280px] flex-1 items-center justify-end gap-2">
            <Input
              className="h-9 max-w-[420px]"
              value={traceId}
              onChange={(event) => setTraceId(event.target.value)}
              placeholder="traceId"
            />
            <Button
              className="h-9 gap-2"
              variant="outline"
              disabled={busy || !traceId.trim()}
              onClick={() => withBusy(loadTraceEvidence)}
            >
              <Search className="h-4 w-4" />
              Open
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {traceSummary || traceTimeline || failureBundle ? (
            <div className="grid gap-3 xl:grid-cols-[280px_1fr_1fr]">
              <div className="space-y-2 text-sm">
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-medium">{traceSummary?.finalStatus || '-'}</span>
                    <Badge variant="secondary">{traceSummary?.eventCount ?? 0} events</Badge>
                  </div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">Capability</div>
                  <div className="break-all font-medium">
                    {traceSummary?.entities.capability ||
                      failureBundle?.failedEvent?.capability ||
                      '-'}
                  </div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">Dataset</div>
                  <div className="break-all font-mono text-xs">
                    {traceSummary?.entities.datasetId ||
                      failureBundle?.failedEvent?.datasetId ||
                      '-'}
                  </div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">Trace</div>
                  <div className="break-all font-mono text-xs">
                    {traceSummary?.traceId || failureBundle?.traceId || traceId.trim()}
                  </div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">Artifacts</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(failureBundle?.artifactRefs || traceSummary?.recentArtifacts || []).length ? (
                      (failureBundle?.artifactRefs || traceSummary?.recentArtifacts || []).map(
                        (artifact) => (
                          <Badge key={artifact.artifactId} variant="outline">
                            {artifact.type}
                          </Badge>
                        )
                      )
                    ) : (
                      <Badge variant="secondary">none</Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="rounded-md border p-2 text-sm">
                  <div className="font-medium">Timeline</div>
                  <div className="mt-2 space-y-2">
                    {(traceTimeline?.events || []).slice(-8).map((event) => (
                      <div key={event.eventId} className="rounded border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{event.event}</span>
                          <Badge variant={event.outcome === 'failed' ? 'destructive' : 'outline'}>
                            {event.outcome || event.level}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatTime(event.timestamp)} · {event.component}
                        </div>
                        {event.message ? (
                          <div className="mt-1 text-xs text-muted-foreground">{event.message}</div>
                        ) : null}
                      </div>
                    ))}
                    {!traceTimeline?.events.length ? (
                      <div className="text-sm text-muted-foreground">No timeline events.</div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {repairBundleView ? (
                  <>
                    <div className="grid gap-2 text-sm sm:grid-cols-2">
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">Adapter</div>
                        <div className="font-medium">{repairBundleView.adapterId || '-'}</div>
                      </div>
                      <div className="rounded-md border p-2">
                        <div className="text-xs text-muted-foreground">Fixture</div>
                        <div className="font-medium">{repairBundleView.fixtureName || '-'}</div>
                      </div>
                    </div>
                    <div className="rounded-md border p-2 text-sm">
                      <div className="text-xs text-muted-foreground">Missing fields</div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {repairBundleView.missingFields.length ? (
                          repairBundleView.missingFields.map((field) => (
                            <Badge key={field} variant="destructive">
                              {field}
                            </Badge>
                          ))
                        ) : (
                          <Badge variant="secondary">none</Badge>
                        )}
                      </div>
                    </div>
                    {repairBundleView.diagnostics.map((diagnostic) => (
                      <div key={diagnostic.path} className="rounded-md border p-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{diagnostic.path}</span>
                          <Badge variant={diagnostic.ok ? 'default' : 'destructive'}>
                            {diagnostic.ok ? 'ok' : 'missing'}
                          </Badge>
                        </div>
                        {!diagnostic.ok ? (
                          <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                            {formatJson({
                              expected: diagnostic.expected,
                              actual: diagnostic.actual,
                            })}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                    <div className="rounded-md border p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">Repair suggestions</span>
                        <Badge variant="secondary">{repairBundleView.suggestions.length}</Badge>
                      </div>
                      <div className="mt-2 space-y-2">
                        {repairBundleView.suggestions.map((suggestion) => (
                          <div key={suggestion.id} className="rounded border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{suggestion.target}</span>
                              <Badge variant="outline">{suggestion.kind}</Badge>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {suggestion.summary}
                            </div>
                            {suggestion.evidencePath ? (
                              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                {suggestion.evidencePath}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-md border p-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">Repair Studio handoff</span>
                        <Button
                          className="gap-2"
                          disabled={busy}
                          size="sm"
                          variant="outline"
                          onClick={() => withBusy(generateRepairStudioDiff)}
                        >
                          <Sparkles className="h-4 w-4" />
                          Generate diff
                        </Button>
                      </div>
                      {repairStudioResult?.status === 'environment_gap' ? (
                        <Alert className="mt-2">
                          <AlertDescription>
                            {repairStudioResult.message} {repairStudioResult.remediation}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      {repairStudioResult?.status === 'generated' ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{repairStudioResult.result.providerId}</Badge>
                            <Badge variant="outline">{repairStudioResult.result.model}</Badge>
                            <Badge variant="secondary">
                              {repairStudioResult.result.latencyMs}ms
                            </Badge>
                          </div>
                          <div className="rounded border bg-muted/40 p-2">
                            {repairStudioResult.result.modelDiff.summary}
                          </div>
                          <div className="space-y-2">
                            {repairStudioResult.result.modelDiff.changes.map((change) => (
                              <div key={change.path} className="rounded border p-2">
                                <div className="font-mono text-xs">{change.path}</div>
                                <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-100">
                                  {change.after}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Failure bundle</span>
                      <Badge variant="secondary">
                        {(failureBundle?.recentEvents || []).length} events
                      </Badge>
                    </div>
                    {failureBundle?.error ? (
                      <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
                        {formatJson(failureBundle.error)}
                      </pre>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No trace loaded.</div>
          )}
        </div>
      </section>
    </div>
  );
}
