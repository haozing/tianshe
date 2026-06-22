export type SiteAdapterSideEffectLevel = 'read-only';

export interface SiteAdapterManifest {
  id: string;
  name: string;
  version: string;
  site: string;
  sideEffectLevel: SiteAdapterSideEffectLevel;
  extractors: Array<{
    id: string;
    outputFields: string[];
  }>;
  verifiers?: Array<{
    id: string;
    description?: string;
  }>;
}

export interface SiteAdapterFixture {
  name: string;
  snapshot: unknown;
  input?: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface SiteAdapterExtractorContext {
  fixtureName: string;
  snapshot: unknown;
  input: Record<string, unknown>;
}

export interface SiteAdapterExtractor {
  id: string;
  extract(context: SiteAdapterExtractorContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface SiteAdapterVerifierContext {
  fixtureName: string;
  result: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface SiteAdapterVerifierResult {
  ok: boolean;
  diagnostics?: SiteAdapterFieldDiagnostic[];
  message?: string;
}

export interface SiteAdapterVerifier {
  id: string;
  verify(context: SiteAdapterVerifierContext): Promise<SiteAdapterVerifierResult> | SiteAdapterVerifierResult;
}

export interface SiteAdapterModule {
  manifest: SiteAdapterManifest;
  extractors: SiteAdapterExtractor[];
  verifiers?: SiteAdapterVerifier[];
}

export interface SiteAdapterFieldDiagnostic {
  path: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface SiteAdapterFixtureRunResult {
  adapterId: string;
  fixtureName: string;
  ok: boolean;
  result: Record<string, unknown>;
  diagnostics: SiteAdapterFieldDiagnostic[];
  verifierResults: SiteAdapterVerifierResult[];
  artifactRefs: string[];
}
