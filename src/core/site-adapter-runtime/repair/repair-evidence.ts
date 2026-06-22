import type { SiteAdapterFieldDiagnostic, SiteAdapterFixture } from '../types';
import {
  evaluateSiteAdapterRepairPath,
  type SiteAdapterRepairScopeDecision,
  type SiteAdapterRepairScopeOptions,
} from './repair-scope';

export interface SiteAdapterRepairEvidenceInput {
  adapterId: string;
  fixtureName: string;
  selectorDiagnostics: SiteAdapterFieldDiagnostic[];
  fixture: Pick<SiteAdapterFixture, 'name' | 'input' | 'snapshot'>;
  expected: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  changedFiles?: string[];
}

export interface SiteAdapterRepairEvidence {
  adapterId: string;
  fixtureName: string;
  selectorDiagnostics: SiteAdapterFieldDiagnostic[];
  fieldDiagnostics: SiteAdapterFieldDiagnostic[];
  fixture: Pick<SiteAdapterFixture, 'name' | 'input' | 'snapshot'>;
  expected: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  changedFiles: string[];
  repairScopeDecisions: SiteAdapterRepairScopeDecision[];
}

const asNonEmptyText = (value: unknown): string => String(value ?? '').trim();

const assertRecord = (value: unknown, fieldName: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Site adapter repair evidence ${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
};

export function buildSiteAdapterRepairEvidence(
  input: SiteAdapterRepairEvidenceInput,
  scopeOptions: SiteAdapterRepairScopeOptions
): SiteAdapterRepairEvidence {
  const adapterId = asNonEmptyText(input.adapterId);
  const fixtureName = asNonEmptyText(input.fixtureName);
  if (!adapterId) {
    throw new Error('Site adapter repair evidence adapterId is required');
  }
  if (!fixtureName) {
    throw new Error('Site adapter repair evidence fixtureName is required');
  }
  if (!Array.isArray(input.selectorDiagnostics) || input.selectorDiagnostics.length === 0) {
    throw new Error('Site adapter repair evidence selectorDiagnostics are required');
  }
  const fixture = assertRecord(input.fixture, 'fixture') as SiteAdapterRepairEvidence['fixture'];
  assertRecord(input.expected, 'expected');
  assertRecord(input.before, 'before');
  if (input.after !== null) {
    assertRecord(input.after, 'after');
  }

  const changedFiles = (input.changedFiles || []).map(asNonEmptyText).filter(Boolean);
  const repairScopeDecisions = changedFiles.map((filePath) =>
    evaluateSiteAdapterRepairPath(filePath, scopeOptions)
  );
  const deniedDecision = repairScopeDecisions.find((decision) => !decision.allowed);
  if (deniedDecision) {
    throw new Error(
      `Site adapter repair evidence changedFiles contains forbidden path: ${deniedDecision.reason} (${deniedDecision.relativePath})`
    );
  }

  return {
    adapterId,
    fixtureName,
    selectorDiagnostics: input.selectorDiagnostics,
    fieldDiagnostics: input.selectorDiagnostics,
    fixture,
    expected: input.expected,
    before: input.before,
    after: input.after,
    changedFiles,
    repairScopeDecisions,
  };
}
