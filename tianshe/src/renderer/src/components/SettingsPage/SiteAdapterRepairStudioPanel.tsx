import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  FileDiff,
  KeyRound,
  Loader2,
  RefreshCw,
  ServerCog,
  WandSparkles,
} from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { siteAdapterRepairStudioFacade } from '../../services/siteAdapterRepairStudioFacade';
import type {
  SiteAdapterRepairStudioModelDiffResult,
  SiteAdapterRepairStudioProviderConfigSummary,
  SiteAdapterRepairStudioReviewApplyPublishResult,
} from '../../../../main/site-adapter-repair-studio/routes-or-ipc';

type RepairTaskKind = 'read-only' | 'procedure';

const READ_ONLY_TASK_PAYLOAD = {
  kind: 'read-only',
  task: {
    taskId: 'repair-readonly-books',
    adapterId: 'books-to-scrape',
    fixtureName: 'product-page',
    sideEffectLevel: 'read-only',
    missingFields: ['price'],
    selectorDiagnostics: [{ path: 'price', ok: false, message: 'Missing price selector' }],
    fixture: {
      name: 'product-page',
      input: {},
      snapshot: { url: 'https://books.toscrape.com/catalogue/book_1/index.html' },
    },
    expected: { price: '$51.77' },
    before: { price: '' },
    allowedChangeGlobs: [
      'src/site-adapters/<site-id>/extractors/**',
      'src/site-adapters/<site-id>/verifiers/**',
      'src/site-adapters/<site-id>/fixtures/**',
      'src/site-adapters/<site-id>/expected/**',
    ],
    forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
    prompt: {
      objective: 'Repair only the read-only site adapter.',
      constraints: ['Do not modify framework core.', 'Run fixture regression before approval.'],
    },
  },
};

const PROCEDURE_TASK_PAYLOAD = {
  kind: 'procedure',
  task: {
    taskId: 'github-profile:open-profile-settings:open-profile-settings:low',
    adapterId: 'github-profile',
    procedureId: 'open-profile-settings',
    sideEffectLevel: 'low',
    failedStepIds: ['open-profile-settings'],
    allowedChangeGlobs: [
      'src/site-adapters/<site-id>/procedures/**',
      'src/site-adapters/<site-id>/fixtures/**',
      'src/site-adapters/<site-id>/expected/**',
    ],
    forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
    prompt: {
      objective: 'Repair only the declared Site Adapter Procedure.',
      constraints: ['Run target canary before approval.'],
    },
    evidence: {
      adapterId: 'github-profile',
      procedureId: 'open-profile-settings',
      sideEffectLevel: 'low',
      failedStepIds: ['open-profile-settings'],
      actionTrace: [],
      riskGate: {
        requiresTargetCanary: true,
        requiresHumanReview: true,
        requiresDestructiveConfirmation: false,
      },
    },
  },
};

type ReviewGateKey = 'fixtureRegression' | 'targetCanary' | 'humanReview';

const REVIEW_GATE_LABELS: Record<ReviewGateKey, string> = {
  fixtureRegression: 'Fixture regression',
  targetCanary: 'Target canary',
  humanReview: 'Human review',
};

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

function statusVariant(
  status: SiteAdapterRepairStudioModelDiffResult['status'] | undefined
): 'default' | 'outline' | 'secondary' {
  if (status === 'generated') return 'default';
  if (status === 'environment_gap') return 'secondary';
  return 'outline';
}

export function SiteAdapterRepairStudioPanel() {
  const [taskKind, setTaskKind] = useState<RepairTaskKind>('read-only');
  const [payloadText, setPayloadText] = useState(formatJson(READ_ONLY_TASK_PAYLOAD));
  const [result, setResult] = useState<SiteAdapterRepairStudioModelDiffResult | null>(null);
  const [publishResult, setPublishResult] =
    useState<SiteAdapterRepairStudioReviewApplyPublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerSummary, setProviderSummary] =
    useState<SiteAdapterRepairStudioProviderConfigSummary | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('openai');
  const [credentialDraft, setCredentialDraft] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: '60000',
  });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [reviewGates, setReviewGates] = useState<Record<ReviewGateKey, boolean>>({
    fixtureRegression: false,
    targetCanary: false,
    humanReview: false,
  });
  const [busy, setBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);

  const changeCount = useMemo(() => {
    if (result?.status !== 'generated') return 0;
    return result.result.modelDiff.changes.length;
  }, [result]);

  const selectedTemplate = useMemo(() => {
    return (
      providerSummary?.templates.find((template) => template.id === selectedTemplateId) ||
      providerSummary?.templates[0] ||
      null
    );
  }, [providerSummary, selectedTemplateId]);

  const generatedChanges = result?.status === 'generated' ? result.result.modelDiff.changes : [];
  const providerConfigured = providerSummary?.configured === true;
  const providerGateMessage = providerConfigured
    ? null
    : providerSummary
      ? '先配置模型 Provider 后才能生成修复 diff。填写 Base URL、Model 和 API Key 后点击 Save Key。'
      : providerError
        ? '模型 Provider 配置读取失败，修复右侧错误后刷新。'
        : '正在读取模型 Provider 配置。';
  const publishReady =
    result?.status === 'generated' &&
    reviewGates.fixtureRegression &&
    reviewGates.targetCanary &&
    reviewGates.humanReview;
  const blockedReviewGates = (Object.keys(reviewGates) as ReviewGateKey[]).filter(
    (gate) => !reviewGates[gate]
  );

  async function refreshProviderSummary() {
    setProviderError(null);
    try {
      const response = await siteAdapterRepairStudioFacade.getProviderConfigSummary();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load provider config summary');
      }
      const summary = response.data;
      setProviderSummary(summary);
      const nextTemplateId = summary.activeTemplateId || summary.templates[0]?.id;
      if (nextTemplateId) {
        setSelectedTemplateId(nextTemplateId);
      }
      const nextTemplate =
        summary.templates.find((template) => template.id === nextTemplateId) ||
        summary.templates[0];
      setCredentialDraft((current) => ({
        ...current,
        baseUrl: current.baseUrl || nextTemplate?.defaultBaseUrl || '',
        timeoutMs: current.timeoutMs || String(summary.timeoutMs || 60000),
      }));
    } catch (caught) {
      setProviderSummary(null);
      setProviderError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void refreshProviderSummary();
  }, []);

  function selectTaskKind(nextKind: string) {
    const normalized = nextKind as RepairTaskKind;
    setTaskKind(normalized);
    setPayloadText(
      formatJson(normalized === 'procedure' ? PROCEDURE_TASK_PAYLOAD : READ_ONLY_TASK_PAYLOAD)
    );
    setResult(null);
    setPublishResult(null);
    setError(null);
    setReviewGates({
      fixtureRegression: false,
      targetCanary: false,
      humanReview: false,
    });
  }

  function setReviewGate(gate: ReviewGateKey, checked: boolean) {
    setPublishResult(null);
    setReviewGates((current) => ({
      ...current,
      [gate]: checked,
    }));
  }

  async function saveProviderCredential() {
    if (!selectedTemplate) {
      return;
    }
    setCredentialBusy(true);
    setProviderError(null);
    try {
      const response = await siteAdapterRepairStudioFacade.saveProviderCredential({
        provider: selectedTemplate.provider,
        baseUrl: credentialDraft.baseUrl || selectedTemplate.defaultBaseUrl,
        model: credentialDraft.model,
        apiKey: credentialDraft.apiKey,
        timeoutMs: Number.parseInt(credentialDraft.timeoutMs, 10) || 60000,
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to save provider credential');
      }
      setProviderSummary(response.data);
      setCredentialDraft((current) => ({ ...current, apiKey: '' }));
    } catch (caught) {
      setProviderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCredentialBusy(false);
    }
  }

  async function clearProviderCredential() {
    setCredentialBusy(true);
    setProviderError(null);
    try {
      const response = await siteAdapterRepairStudioFacade.clearProviderCredential();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to clear provider credential');
      }
      setProviderSummary(response.data);
      setCredentialDraft((current) => ({ ...current, apiKey: '' }));
    } catch (caught) {
      setProviderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCredentialBusy(false);
    }
  }

  async function generateModelDiff() {
    if (!providerConfigured) {
      setError('请先配置模型 Provider 后再生成修复 diff。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = parseJsonObject(payloadText);
      const response = await siteAdapterRepairStudioFacade.generateModelDiff(input as never);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to generate repair model diff');
      }
      setResult(response.data);
      setPublishResult(null);
      setReviewGates({
        fixtureRegression: false,
        targetCanary: false,
        humanReview: false,
      });
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reviewApplyPublish(dryRun: boolean) {
    if (result?.status !== 'generated') {
      return;
    }
    setPublishBusy(true);
    setError(null);
    try {
      const input = parseJsonObject(payloadText);
      const response = await siteAdapterRepairStudioFacade.reviewApplyPublish({
        ...input,
        modelDiff: result.result.modelDiff,
        reviewGates,
        approvedBy: 'renderer-review',
        dryRun,
      } as never);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to review and publish repair');
      }
      setPublishResult(response.data);
    } catch (caught) {
      setPublishResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPublishBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4" aria-hidden="true" />
          站点规则修复
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          根据失败 trace 或样例差异生成受限修复
          diff；只有模型配置、回归验证和人工确认都完成后才允许发布。
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-md border bg-white p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4" aria-hidden="true" />
              <h3 className="text-sm font-semibold">修复任务</h3>
              <Badge variant={statusVariant(result?.status)}>{result?.status || 'idle'}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Select value={taskKind} onValueChange={selectTaskKind}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read-only">只读采集任务</SelectItem>
                  <SelectItem value="procedure">操作流程任务</SelectItem>
                </SelectContent>
              </Select>
              <Button
                className="h-8"
                disabled={busy || !providerConfigured}
                onClick={generateModelDiff}
                size="sm"
                type="button"
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <WandSparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                生成 diff
              </Button>
            </div>
          </div>

          {providerGateMessage ? (
            <Alert className="mb-3">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{providerGateMessage}</AlertDescription>
            </Alert>
          ) : null}

          <textarea
            className="min-h-[360px] w-full resize-y rounded-md border bg-slate-950 p-3 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
          />
        </div>

        <div className="space-y-3">
          <div className="rounded-md border bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ServerCog className="h-4 w-4" aria-hidden="true" />
                <h3 className="text-sm font-semibold">模型 Provider</h3>
                <Badge variant={providerSummary?.configured ? 'default' : 'secondary'}>
                  {providerSummary?.configured ? '已就绪' : '待配置'}
                </Badge>
              </div>
              <Button
                className="h-8"
                onClick={refreshProviderSummary}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                Refresh
              </Button>
            </div>

            {providerError ? (
              <Alert variant="destructive">
                <AlertDescription>{providerError}</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3 text-sm">
                <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(providerSummary?.templates || []).map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Provider</div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.provider || selectedTemplate?.provider || 'missing'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Model</div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.modelConfigured ? 'configured' : 'missing'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      API key
                    </div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.apiKeyConfigured ? 'configured' : 'missing'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Source</div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.credentialSource || 'missing'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Key version</div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.storedCredential.keyVersion ?? 'none'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Timeout</div>
                    <div className="mt-1 font-medium">
                      {providerSummary?.timeoutMs ? `${providerSummary.timeoutMs}ms` : 'default'}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Input
                    aria-label="Provider base URL"
                    className="h-8"
                    placeholder={selectedTemplate?.defaultBaseUrl || 'https://api.example.test/v1'}
                    value={credentialDraft.baseUrl}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        baseUrl: event.target.value,
                      }))
                    }
                  />
                  <Input
                    aria-label="Provider model"
                    className="h-8"
                    placeholder="model"
                    value={credentialDraft.model}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                  <Input
                    aria-label="Provider API key"
                    className="h-8"
                    placeholder="API key"
                    type="password"
                    value={credentialDraft.apiKey}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        apiKey: event.target.value,
                      }))
                    }
                  />
                  <Input
                    aria-label="Provider timeout"
                    className="h-8"
                    inputMode="numeric"
                    value={credentialDraft.timeoutMs}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        timeoutMs: event.target.value,
                      }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-8"
                      disabled={credentialBusy || !selectedTemplate}
                      onClick={() => saveProviderCredential()}
                      size="sm"
                      type="button"
                    >
                      {credentialBusy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                      )}
                      {providerSummary?.storedCredential.configured ? 'Rotate Key' : 'Save Key'}
                    </Button>
                    <Button
                      className="h-8"
                      disabled={credentialBusy || !providerSummary?.storedCredential.configured}
                      onClick={() => clearProviderCredential()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Clear Key
                    </Button>
                  </div>
                </div>

                {selectedTemplate ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{selectedTemplate.env.provider}</Badge>
                      <Badge variant="outline">{selectedTemplate.env.baseUrl}</Badge>
                      {selectedTemplate.env.model.map((envName) => (
                        <Badge key={envName} variant="outline">
                          {envName}
                        </Badge>
                      ))}
                      {selectedTemplate.env.apiKey.map((envName) => (
                        <Badge key={envName} variant="outline">
                          {envName}
                        </Badge>
                      ))}
                    </div>
                    {providerSummary?.missingEnv.length ? (
                      <div className="flex flex-wrap gap-1">
                        {providerSummary.missingEnv.map((envName) => (
                          <Badge key={envName} variant="secondary">
                            {envName}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="rounded-md border bg-white p-3">
            <div className="mb-2 flex items-center gap-2">
              <FileDiff className="h-4 w-4" aria-hidden="true" />
              <h3 className="text-sm font-semibold">Model Diff</h3>
              <Badge variant="outline">{changeCount} changes</Badge>
            </div>
            {result?.status === 'generated' ? (
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>{result.result.providerId}</span>
                  <span>{result.result.model}</span>
                  <span>{result.result.taskKind}</span>
                  <span>{result.result.latencyMs}ms</span>
                </div>
                <p className="text-sm">{result.result.modelDiff.summary}</p>
                <div className="space-y-2">
                  {result.result.modelDiff.changes.map((change) => (
                    <div key={change.path} className="rounded-md border bg-muted/30 p-2">
                      <div className="mb-1 font-mono text-xs">{change.path}</div>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px] text-slate-100">
                        {change.after}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : result?.status === 'environment_gap' ? (
              <Alert>
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                  <div className="font-medium">{result.message}</div>
                  <div className="mt-1 text-xs">{result.remediation}</div>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                选择修复任务并生成模型 diff。
              </div>
            )}
          </div>

          <div className="rounded-md border bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">发布门禁</h3>
              <Badge variant={publishReady ? 'default' : 'secondary'}>
                {publishReady ? 'publish ready' : 'blocked'}
              </Badge>
            </div>

            <div className="space-y-2">
              {(Object.keys(REVIEW_GATE_LABELS) as ReviewGateKey[]).map((gate) => (
                <label
                  key={gate}
                  className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2 text-sm"
                >
                  <span>{REVIEW_GATE_LABELS[gate]}</span>
                  <Checkbox
                    checked={reviewGates[gate]}
                    disabled={result?.status !== 'generated'}
                    onCheckedChange={(checked) => setReviewGate(gate, checked)}
                  />
                </label>
              ))}
            </div>

            {generatedChanges.length ? (
              <div className="mt-3 space-y-1">
                {generatedChanges.map((change) => (
                  <div
                    key={change.path}
                    className="truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs"
                  >
                    {change.path}
                  </div>
                ))}
              </div>
            ) : null}

            {result?.status === 'generated' && blockedReviewGates.length ? (
              <div className="mt-3 flex flex-wrap gap-1">
                {blockedReviewGates.map((gate) => (
                  <Badge key={gate} variant="secondary">
                    {REVIEW_GATE_LABELS[gate]}
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="h-8"
                  disabled={result?.status !== 'generated' || publishBusy}
                  onClick={() => reviewApplyPublish(true)}
                  size="sm"
                  type="button"
                >
                  {publishBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  Review Preview
                </Button>
                <Button
                  className="h-8"
                  disabled={!publishReady || publishBusy}
                  onClick={() => reviewApplyPublish(false)}
                  size="sm"
                  type="button"
                >
                  {publishBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  Apply & Publish
                </Button>
              </div>
              {publishResult ? (
                <Badge
                  variant={
                    publishResult.status === 'publish_ready' || publishResult.status === 'applied'
                      ? 'default'
                      : 'secondary'
                  }
                >
                  {publishResult.status}
                </Badge>
              ) : null}
            </div>

            {publishResult ? (
              <div className="mt-3 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Apply</div>
                    <div className="mt-1 font-medium">
                      {publishResult.applyResult.dryRun ? 'dry run' : 'written'}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Publish</div>
                    <div className="mt-1 font-medium">
                      {publishResult.publishRecord.publishAllowed ? 'allowed' : 'blocked'}
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  {publishResult.applyResult.changedFiles.map((filePath) => (
                    <div
                      key={filePath}
                      className="truncate rounded bg-muted/40 px-2 py-1 font-mono"
                    >
                      {filePath}
                    </div>
                  ))}
                </div>
                {publishResult.publishRecord.blockedReasons.length ? (
                  <div className="flex flex-wrap gap-1">
                    {publishResult.publishRecord.blockedReasons.map((reason) => (
                      <Badge key={reason} variant="secondary">
                        {reason}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    </section>
  );
}
