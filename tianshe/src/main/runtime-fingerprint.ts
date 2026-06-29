import path from 'node:path';
import {
  getMainBuildFreshness,
  type MainBuildFreshnessStatus,
} from './main-build-freshness';
import { readGitCommit, readMainBuildStamp } from './main-build-stamp';
import {
  getRendererBuildFreshness,
  type RendererBuildFreshnessStatus,
} from './renderer-build-freshness';
import { getMcpSdkInitializeShimStatus } from './mcp-sdk-initialize-shim';

export interface RuntimeFingerprint {
  processStartTime: string;
  mainDistUpdatedAt: string | null;
  rendererDistUpdatedAt: string | null;
  mainBuildStamp: {
    schema: string;
    success: true;
    builtAt: string;
    gitCommit: string | null;
    entryPoint: string;
    entryPointUpdatedAt: string;
    generatedBy: string | null;
  } | null;
  mcpRuntimeFreshness: {
    overall: 'fresh' | 'stale' | 'missing_dist_artifacts' | 'missing_source_tree';
    main: {
      ok: boolean;
      reason: MainBuildFreshnessStatus['reason'];
      lagMs: number | null;
    };
  };
  buildFreshness: {
    overall: 'fresh' | 'stale' | 'missing_dist_artifacts' | 'missing_source_tree';
    main: {
      ok: boolean;
      reason: MainBuildFreshnessStatus['reason'];
      lagMs: number | null;
    };
    renderer: {
      ok: boolean;
      reason: RendererBuildFreshnessStatus['reason'];
      lagMs: number | null;
    };
  };
  gitCommit: string | null;
  mcpSdk: {
    version: string | null;
    initializeShimMode: string;
    degraded: boolean;
    fingerprintInjected: boolean;
    initializeShimReason: string | null;
  };
}

const ROOT_DIR = path.resolve(__dirname, '../..');
const PROCESS_START_TIME = new Date(Date.now() - process.uptime() * 1000).toISOString();
const GIT_COMMIT = readGitCommit(ROOT_DIR);
const PROCESS_MAIN_BUILD_STAMP = readMainBuildStamp(ROOT_DIR);

function resolveOverallFreshness(
  main: MainBuildFreshnessStatus
): RuntimeFingerprint['mcpRuntimeFreshness']['overall'] {
  if (main.reason === 'missing_source_tree') {
    return 'missing_source_tree';
  }

  if (main.reason === 'missing_dist_artifacts') {
    return 'missing_dist_artifacts';
  }

  return main.ok ? 'fresh' : 'stale';
}

function resolveRepoBuildFreshness(
  main: MainBuildFreshnessStatus,
  renderer: RendererBuildFreshnessStatus
): RuntimeFingerprint['buildFreshness']['overall'] {
  if (
    main.reason === 'missing_dist_artifacts' ||
    renderer.reason === 'missing_dist_artifacts'
  ) {
    return 'missing_dist_artifacts';
  }

  if (
    main.reason === 'missing_source_tree' &&
    renderer.reason === 'missing_source_tree'
  ) {
    return 'missing_source_tree';
  }

  if (main.ok && renderer.ok) {
    return 'fresh';
  }

  return 'stale';
}

export const getRuntimeFingerprint = (): RuntimeFingerprint => {
  const main = getMainBuildFreshness(ROOT_DIR);
  const renderer = getRendererBuildFreshness(ROOT_DIR);
  const mcpRuntimeOverall = resolveOverallFreshness(main);
  const overall = resolveRepoBuildFreshness(main, renderer);
  const sdkShim = getMcpSdkInitializeShimStatus();

  return {
    processStartTime: PROCESS_START_TIME,
    mainDistUpdatedAt: PROCESS_MAIN_BUILD_STAMP?.entryPointUpdatedAt || main.dist?.updatedAt || null,
    rendererDistUpdatedAt: renderer.dist?.updatedAt || null,
    mainBuildStamp: PROCESS_MAIN_BUILD_STAMP ? { ...PROCESS_MAIN_BUILD_STAMP } : null,
    mcpRuntimeFreshness: {
      overall: mcpRuntimeOverall,
      main: {
        ok: main.ok,
        reason: main.reason,
        lagMs: main.lagMs,
      },
    },
    buildFreshness: {
      overall,
      main: {
        ok: main.ok,
        reason: main.reason,
        lagMs: main.lagMs,
      },
      renderer: {
        ok: renderer.ok,
        reason: renderer.reason,
        lagMs: renderer.lagMs,
      },
    },
    gitCommit: GIT_COMMIT,
    mcpSdk: {
      version: sdkShim.sdkVersion,
      initializeShimMode: sdkShim.mode,
      degraded: sdkShim.degraded,
      fingerprintInjected: sdkShim.fingerprintInjected,
      initializeShimReason: sdkShim.reason,
    },
  };
};
