import path from 'node:path';
import type { SiteAdapterManifest, SiteAdapterModule } from '../types';

export type SiteAdapterRepairScopeReason =
  | 'allowed'
  | 'empty_path'
  | 'outside_workspace'
  | 'forbidden_file'
  | 'denied_framework_path'
  | 'outside_site_adapter_root'
  | 'outside_repair_subpath';

export interface SiteAdapterRepairScopeOptions {
  workspaceRoot: string;
  allowedAdapterRootPattern?: RegExp;
  allowedRepairSubpaths?: readonly string[];
  deniedRoots?: readonly string[];
  forbiddenFiles?: readonly string[];
}

export interface SiteAdapterRepairScopeDecision {
  allowed: boolean;
  reason: SiteAdapterRepairScopeReason;
  absolutePath: string;
  relativePath: string;
}

export interface SiteAdapterRepairScopeMatrixCandidate {
  candidatePath: string;
  expectedAllowed: boolean;
  expectedReason?: SiteAdapterRepairScopeReason;
  decision: SiteAdapterRepairScopeDecision;
  ok: boolean;
}

export interface SiteAdapterRepairScopeMatrixRow {
  adapterId: string;
  roots: string[];
  allowedSubpaths: string[];
  forbiddenFiles: string[];
  candidates: SiteAdapterRepairScopeMatrixCandidate[];
  ok: boolean;
}

export interface SiteAdapterRepairScopeMatrix {
  ok: boolean;
  rows: SiteAdapterRepairScopeMatrixRow[];
}

export const DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN =
  /^(?:examples[\\/]+web-site-adapter-[^\\/]+|site-adapters[\\/]+[^\\/]+|src[\\/]+site-adapters[\\/]+[^\\/]+)/;

export const DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS = [
  'extractors',
  'verifiers',
  'fixtures',
  'expected',
] as const;

export const DEFAULT_SITE_ADAPTER_REPAIR_DENIED_ROOTS = [
  'src/main',
  'src/core/site-adapter-runtime',
] as const;

const normalizeForComparison = (value: string): string => path.normalize(value).toLowerCase();

const isWithinPath = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const toPortableRelativePath = (relativePath: string): string =>
  relativePath.split(path.sep).join('/');

const toPortablePath = (value: string): string => value.split(/[\\/]+/).filter(Boolean).join('/');

const getPathSegments = (relativePath: string): string[] =>
  toPortableRelativePath(relativePath)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

export function evaluateSiteAdapterRepairPath(
  candidatePath: string,
  options: SiteAdapterRepairScopeOptions
): SiteAdapterRepairScopeDecision {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const rawCandidate = String(candidatePath || '').trim();
  const absolutePath = rawCandidate ? path.resolve(workspaceRoot, rawCandidate) : workspaceRoot;
  const relativePath = toPortableRelativePath(path.relative(workspaceRoot, absolutePath));

  if (!rawCandidate) {
    return {
      allowed: false,
      reason: 'empty_path',
      absolutePath,
      relativePath,
    };
  }

  if (!isWithinPath(absolutePath, workspaceRoot)) {
    return {
      allowed: false,
      reason: 'outside_workspace',
      absolutePath,
      relativePath,
    };
  }

  const deniedRoots = options.deniedRoots ?? DEFAULT_SITE_ADAPTER_REPAIR_DENIED_ROOTS;
  const normalizedCandidate = normalizeForComparison(absolutePath);
  const deniedRoot = deniedRoots.find((root) => {
    const deniedAbsolute = path.resolve(workspaceRoot, root);
    return isWithinPath(normalizedCandidate, normalizeForComparison(deniedAbsolute));
  });
  if (deniedRoot) {
    return {
      allowed: false,
      reason: 'denied_framework_path',
      absolutePath,
      relativePath,
    };
  }

  const forbiddenFile = options.forbiddenFiles?.find((entry) => {
    const forbiddenAbsolute = path.resolve(workspaceRoot, entry);
    return isWithinPath(normalizedCandidate, normalizeForComparison(forbiddenAbsolute));
  });
  if (forbiddenFile) {
    return {
      allowed: false,
      reason: 'forbidden_file',
      absolutePath,
      relativePath,
    };
  }

  const adapterRootPattern =
    options.allowedAdapterRootPattern ?? DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN;
  if (!adapterRootPattern.test(relativePath)) {
    return {
      allowed: false,
      reason: 'outside_site_adapter_root',
      absolutePath,
      relativePath,
    };
  }

  const segments = getPathSegments(relativePath);
  const allowedSubpaths = options.allowedRepairSubpaths ?? DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS;
  const hasAllowedSubpath = allowedSubpaths.some((subpath) => segments.includes(subpath));
  if (!hasAllowedSubpath) {
    return {
      allowed: false,
      reason: 'outside_repair_subpath',
      absolutePath,
      relativePath,
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    absolutePath,
    relativePath,
  };
}

export function assertSiteAdapterRepairPath(
  candidatePath: string,
  options: SiteAdapterRepairScopeOptions
): SiteAdapterRepairScopeDecision {
  const decision = evaluateSiteAdapterRepairPath(candidatePath, options);
  if (!decision.allowed) {
    throw new Error(`Site adapter repair path is not allowed: ${decision.reason} (${decision.relativePath})`);
  }
  return decision;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getManifestRepairRoots(manifest: SiteAdapterManifest): string[] {
  const roots = manifest.repairScope?.roots?.length
    ? manifest.repairScope.roots
    : [`src/site-adapters/${manifest.id}`, `site-adapters/${manifest.id}`];
  return roots.map(toPortablePath);
}

function createAdapterRootPattern(roots: readonly string[]): RegExp {
  const source = roots.map((root) => escapeRegExp(toPortablePath(root))).join('|');
  return new RegExp(`^(?:${source})(?:/|$)`);
}

export function createSiteAdapterRepairScopeOptionsFromManifest(
  manifest: SiteAdapterManifest,
  workspaceRoot: string
): SiteAdapterRepairScopeOptions {
  const roots = getManifestRepairRoots(manifest);
  return {
    workspaceRoot,
    allowedAdapterRootPattern: createAdapterRootPattern(roots),
    allowedRepairSubpaths:
      manifest.repairScope?.allowedSubpaths?.length
        ? manifest.repairScope.allowedSubpaths
        : DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS,
    forbiddenFiles: manifest.repairScope?.forbiddenFiles || [],
  };
}

export function createSiteAdapterRepairScopeMatrix(
  adapters: readonly SiteAdapterModule[],
  options: { workspaceRoot: string }
): SiteAdapterRepairScopeMatrix {
  const rows = adapters.map((adapter) => {
    const roots = getManifestRepairRoots(adapter.manifest);
    const allowedSubpaths = [
      ...(adapter.manifest.repairScope?.allowedSubpaths?.length
        ? adapter.manifest.repairScope.allowedSubpaths
        : DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS),
    ];
    const forbiddenFiles = [...(adapter.manifest.repairScope?.forbiddenFiles || [])].map(
      toPortablePath
    );
    const scopeOptions = createSiteAdapterRepairScopeOptionsFromManifest(
      adapter.manifest,
      options.workspaceRoot
    );
    const rootCandidates = roots.flatMap((root) => [
      ...allowedSubpaths.map((subpath) => ({
        candidatePath: `${root}/${subpath}/__repair_scope_probe__.ts`,
        expectedAllowed: true,
        expectedReason: 'allowed' as const,
      })),
      {
        candidatePath: `${root}/README.md`,
        expectedAllowed: false,
        expectedReason: 'outside_repair_subpath' as const,
      },
    ]);
    const forbiddenCandidates = forbiddenFiles.map((candidatePath) => ({
      candidatePath,
      expectedAllowed: false,
      expectedReason: 'forbidden_file' as const,
    }));
    const globalDenyCandidates = [
      {
        candidatePath: 'src/core/site-adapter-runtime/read-only-runner.ts',
        expectedAllowed: false,
        expectedReason: 'denied_framework_path' as const,
      },
      {
        candidatePath: '../outside-repo/extractors/product.ts',
        expectedAllowed: false,
        expectedReason: 'outside_workspace' as const,
      },
    ];
    const candidates = [...rootCandidates, ...forbiddenCandidates, ...globalDenyCandidates].map(
      (candidate) => {
        const decision = evaluateSiteAdapterRepairPath(candidate.candidatePath, scopeOptions);
        const ok =
          decision.allowed === candidate.expectedAllowed &&
          (!candidate.expectedReason || decision.reason === candidate.expectedReason);
        return {
          ...candidate,
          decision,
          ok,
        };
      }
    );
    return {
      adapterId: adapter.manifest.id,
      roots,
      allowedSubpaths,
      forbiddenFiles,
      candidates,
      ok: candidates.every((candidate) => candidate.ok),
    };
  });

  return {
    ok: rows.every((row) => row.ok),
    rows,
  };
}
