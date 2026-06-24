import type { FailureBundle, RuntimeArtifact } from '../observability/types';

export interface SiteAdapterRepairBundleView {
  traceId: string;
  artifactId: string;
  adapterId: string | null;
  fixtureName: string | null;
  sideEffectLevel: string | null;
  missingFields: string[];
  suggestions: SiteAdapterRepairSuggestion[];
  diagnostics: Array<{
    path: string;
    ok: boolean;
    expected: unknown;
    actual: unknown;
  }>;
  actionTraceCount: number;
  transitionCount: number;
  rawData: Record<string, unknown>;
}

export interface SiteAdapterRepairSuggestion {
  id: string;
  kind: 'selector_repair' | 'expected_update' | 'fixture_refresh';
  target: string;
  summary: string;
  evidencePath?: string;
  expected?: unknown;
  actual?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeDiagnostic(value: unknown): SiteAdapterRepairBundleView['diagnostics'][number] | null {
  const diagnostic = asRecord(value);
  const path = asString(diagnostic.path);
  if (!path) {
    return null;
  }
  return {
    path,
    ok: diagnostic.ok === true,
    expected: diagnostic.expected,
    actual: diagnostic.actual,
  };
}

function diagnosticsFromArtifact(artifact: RuntimeArtifact): SiteAdapterRepairBundleView['diagnostics'] {
  const data = asRecord(artifact.data);
  const repairEvidence = asRecord(data.repairEvidence);
  const diagnostics = asArray(data.diagnostics).length
    ? asArray(data.diagnostics)
    : asArray(repairEvidence.selectorDiagnostics);
  return diagnostics
    .map(normalizeDiagnostic)
    .filter((diagnostic): diagnostic is SiteAdapterRepairBundleView['diagnostics'][number] =>
      Boolean(diagnostic)
    );
}

function createRepairSuggestions(
  view: Pick<SiteAdapterRepairBundleView, 'adapterId' | 'fixtureName' | 'diagnostics'>
): SiteAdapterRepairSuggestion[] {
  const suggestions: SiteAdapterRepairSuggestion[] = view.diagnostics
    .filter((diagnostic) => !diagnostic.ok)
    .map((diagnostic) => ({
      id: `selector:${diagnostic.path}`,
      kind: 'selector_repair',
      target: diagnostic.path,
      summary: `Review extractor selector or parser for "${diagnostic.path}".`,
      evidencePath: diagnostic.path,
      expected: diagnostic.expected,
      actual: diagnostic.actual,
    }));

  if (!view.fixtureName) {
    suggestions.push({
      id: 'fixture:refresh',
      kind: 'fixture_refresh',
      target: view.adapterId || 'site-adapter',
      summary: 'Capture or attach a fixture before applying a repair.',
    });
  }

  if (!suggestions.length && view.diagnostics.length) {
    suggestions.push({
      id: 'expected:review',
      kind: 'expected_update',
      target: view.fixtureName || view.adapterId || 'site-adapter',
      summary: 'Diagnostics pass; review whether expected output needs to be updated.',
    });
  }

  return suggestions;
}

export function createSiteAdapterRepairBundleView(
  failureBundle: FailureBundle
): SiteAdapterRepairBundleView | null {
  const artifact = failureBundle.siteAdapterRepairBundle;
  if (!artifact) {
    return null;
  }

  const data = asRecord(artifact.data);
  const diagnostics = diagnosticsFromArtifact(artifact);
  const missingFields = diagnostics
    .filter((diagnostic) => !diagnostic.ok)
    .map((diagnostic) => diagnostic.path);
  const viewBase = {
    adapterId: asString(data.adapterId),
    fixtureName: asString(data.fixtureName),
    diagnostics,
  };

  return {
    traceId: failureBundle.traceId,
    artifactId: artifact.artifactId,
    adapterId: viewBase.adapterId,
    fixtureName: viewBase.fixtureName,
    sideEffectLevel: asString(data.sideEffectLevel),
    missingFields,
    suggestions: createRepairSuggestions(viewBase),
    diagnostics,
    actionTraceCount: asArray(data.actionTrace).length,
    transitionCount: asArray(data.transitions).length,
    rawData: data,
  };
}
