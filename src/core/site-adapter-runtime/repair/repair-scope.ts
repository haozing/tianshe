import path from 'node:path';

export type SiteAdapterRepairScopeReason =
  | 'allowed'
  | 'empty_path'
  | 'outside_workspace'
  | 'denied_framework_path'
  | 'outside_site_adapter_root'
  | 'outside_repair_subpath';

export interface SiteAdapterRepairScopeOptions {
  workspaceRoot: string;
  allowedAdapterRootPattern?: RegExp;
  allowedRepairSubpaths?: readonly string[];
  deniedRoots?: readonly string[];
}

export interface SiteAdapterRepairScopeDecision {
  allowed: boolean;
  reason: SiteAdapterRepairScopeReason;
  absolutePath: string;
  relativePath: string;
}

export const DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN = /^examples[\\/]+web-site-adapter-[^\\/]+/;

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
