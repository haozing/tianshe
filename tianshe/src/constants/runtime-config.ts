/**
 * Runtime configuration SSOT for ai-dev architecture.
 *
 * Rule: runtime code must not read process.env directly.
 * AIRPA_RUNTIME_CONFIG is evaluated once at module load; use createRuntimeConfig
 * in tests or explicit startup probes that need alternate argv inputs.
 */

export type RuntimeMode = 'development' | 'production' | 'test';
export type OcrAdapterMode = 'worker' | 'inprocess';
export type RepairStudioModelProviderKind = 'openai' | 'openai-compatible';

type RuntimeConfigProcessLike = {
  argv?: unknown;
  versions?: Partial<NodeJS.ProcessVersions>;
  type?: unknown;
  resourcesPath?: unknown;
  env?: NodeJS.ProcessEnv;
};

const getRuntimeProcess = (): RuntimeConfigProcessLike | null => {
  return typeof process !== 'undefined' ? process : null;
};

const getRuntimeArgv = (runtimeProcess: RuntimeConfigProcessLike | null): string[] => {
  return Array.isArray(runtimeProcess?.argv) ? runtimeProcess.argv.filter(isString) : [];
};

const isString = (value: unknown): value is string => typeof value === 'string';

const withRuntimeArgv = (
  runtimeProcess: RuntimeConfigProcessLike | null,
  argv?: readonly string[]
): RuntimeConfigProcessLike | null => {
  if (!argv) {
    return runtimeProcess;
  }

  return {
    argv: [...argv],
    versions: runtimeProcess?.versions,
    type: runtimeProcess?.type,
    resourcesPath: runtimeProcess?.resourcesPath,
    env: runtimeProcess?.env,
  };
};

const readProcessArgValue = (
  flagName: string,
  runtimeProcess: RuntimeConfigProcessLike | null
): string => {
  const args = Array.isArray(runtimeProcess?.argv) ? runtimeProcess.argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      continue;
    }

    if (arg === flagName) {
      const next = args[index + 1];
      return typeof next === 'string' ? next.trim() : '';
    }

    const prefix = `${flagName}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }

  return '';
};

const readProcessArgInteger = (
  flagName: string,
  runtimeProcess: RuntimeConfigProcessLike | null
): number | null => {
  const raw = readProcessArgValue(flagName, runtimeProcess);
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
};

const readProcessArgBoolean = (
  flagName: string,
  runtimeProcess: RuntimeConfigProcessLike | null
): boolean | null => {
  const args = getRuntimeArgv(runtimeProcess);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flagName) {
      return true;
    }

    const prefix = `${flagName}=`;
    if (!arg.startsWith(prefix)) {
      continue;
    }

    const rawValue = arg.slice(prefix.length).trim().toLowerCase();
    if (rawValue === 'true' || rawValue === '1' || rawValue === 'yes' || rawValue === 'on') {
      return true;
    }
    if (rawValue === 'false' || rawValue === '0' || rawValue === 'no' || rawValue === 'off') {
      return false;
    }
    return null;
  }

  return null;
};

const getUserDataDirOverride = (runtimeProcess: RuntimeConfigProcessLike | null): string =>
  readProcessArgValue('--airpa-user-data-dir', runtimeProcess);
const getAsarExtractBaseDirOverride = (runtimeProcess: RuntimeConfigProcessLike | null): string =>
  readProcessArgValue('--airpa-asar-extract-base-dir', runtimeProcess);
const getFirefoxExecutablePathOverride = (runtimeProcess: RuntimeConfigProcessLike | null): string =>
  readProcessArgValue('--airpa-firefox-path', runtimeProcess);
const getCloakBrowserExecutablePathOverride = (
  runtimeProcess: RuntimeConfigProcessLike | null
): string =>
  readProcessArgValue('--airpa-cloakbrowser-path', runtimeProcess) ||
  readProcessArgValue('--airpa-cloak-browser-path', runtimeProcess);
const getChromeExecutablePathOverride = (
  runtimeProcess: RuntimeConfigProcessLike | null,
  env: NodeJS.ProcessEnv | undefined
): string =>
  readConfigString(
    '--airpa-chrome-path',
    ['AIRPA_CHROME_PATH', 'TIANSHE_CHROME_PATH'],
    runtimeProcess,
    env
  );
const getHttpPortOverride = (runtimeProcess: RuntimeConfigProcessLike | null): number | null =>
  readProcessArgInteger('--airpa-http-port', runtimeProcess);
const getHttpEnabledOverride = (runtimeProcess: RuntimeConfigProcessLike | null): boolean | null =>
  readProcessArgBoolean('--airpa-enable-http', runtimeProcess);
const getMcpEnabledOverride = (runtimeProcess: RuntimeConfigProcessLike | null): boolean | null =>
  readProcessArgBoolean('--airpa-enable-mcp', runtimeProcess);
const getE2eCdpPortOverride = (runtimeProcess: RuntimeConfigProcessLike | null): number | null =>
  readProcessArgInteger('--airpa-e2e-cdp-port', runtimeProcess);
const getAllowNoSandbox = (runtimeProcess: RuntimeConfigProcessLike | null): boolean =>
  readProcessArgBoolean('--tianshe-allow-no-sandbox', runtimeProcess) ??
  readProcessArgBoolean('--airpa-allow-no-sandbox', runtimeProcess) ??
  false;

const readEnvValue = (env: NodeJS.ProcessEnv | undefined, names: readonly string[]): string => {
  if (!env) {
    return '';
  }

  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
};

const getRuntimeEnv = (
  explicitEnv: NodeJS.ProcessEnv | undefined,
  runtimeProcess: RuntimeConfigProcessLike | null
): NodeJS.ProcessEnv | undefined => explicitEnv || runtimeProcess?.env;

const readConfigString = (
  flagName: string,
  envNames: readonly string[],
  runtimeProcess: RuntimeConfigProcessLike | null,
  env: NodeJS.ProcessEnv | undefined
): string => readProcessArgValue(flagName, runtimeProcess) || readEnvValue(env, envNames);

const readConfigInteger = (
  flagName: string,
  envNames: readonly string[],
  runtimeProcess: RuntimeConfigProcessLike | null,
  env: NodeJS.ProcessEnv | undefined,
  max: number
): number | null => {
  const raw = readConfigString(flagName, envNames, runtimeProcess, env);
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value <= max ? value : null;
};

const normalizeRepairStudioModelProvider = (
  value: string
): RepairStudioModelProviderKind | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-compatible') {
    return normalized;
  }
  return null;
};

export interface RepairStudioModelProviderConfig {
  provider: RepairStudioModelProviderKind | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_REPAIR_STUDIO_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REPAIR_STUDIO_MODEL_TIMEOUT_MS = 60_000;

const getRepairStudioModelProviderConfig = (
  runtimeProcess: RuntimeConfigProcessLike | null,
  env: NodeJS.ProcessEnv | undefined
): RepairStudioModelProviderConfig => {
  const provider = normalizeRepairStudioModelProvider(
    readConfigString(
      '--tianshe-repair-model-provider',
      ['TIANSHE_REPAIR_MODEL_PROVIDER'],
      runtimeProcess,
      env
    )
  );
  const apiKeyEnvNames =
    provider === 'openai'
      ? ['TIANSHE_REPAIR_MODEL_API_KEY', 'OPENAI_API_KEY']
      : ['TIANSHE_REPAIR_MODEL_API_KEY'];

  return {
    provider,
    baseUrl:
      readConfigString(
        '--tianshe-repair-model-base-url',
        ['TIANSHE_REPAIR_MODEL_BASE_URL'],
        runtimeProcess,
        env
      ) || (provider === 'openai' ? DEFAULT_REPAIR_STUDIO_OPENAI_BASE_URL : ''),
    apiKey: readConfigString(
      '--tianshe-repair-model-api-key',
      apiKeyEnvNames,
      runtimeProcess,
      env
    ),
    model: readConfigString(
      '--tianshe-repair-model',
      ['TIANSHE_REPAIR_MODEL', 'TIANSHE_REPAIR_MODEL_NAME'],
      runtimeProcess,
      env
    ),
    timeoutMs:
      readConfigInteger(
        '--tianshe-repair-model-timeout-ms',
        ['TIANSHE_REPAIR_MODEL_TIMEOUT_MS'],
        runtimeProcess,
        env,
        600_000
      ) ?? DEFAULT_REPAIR_STUDIO_MODEL_TIMEOUT_MS,
  };
};

export interface AirpaRuntimeConfig {
  app: {
    mode: RuntimeMode;
    devServerPort: number;
    debugProdMenu: boolean;
  };
  e2e: {
    cdpPort: number | null;
  };
  paths: {
    userDataDirOverride: string;
    asarExtractBaseDirOverride: string;
    firefoxExecutablePathOverride: string;
    cloakBrowserExecutablePathOverride: string;
    chromeExecutablePathOverride: string;
    localAppDataDir: string;
  };
  http: {
    port: number;
    enableHttpOverride: boolean | null;
    enableMcpOverride: boolean | null;
    mcpProtocolCompatibilityMode: 'sdk-compatible' | 'strict';
    mcpMaxQueueSize: number;
    mcpInvokeTimeoutMs: number;
    orchestrationMaxQueueSize: number;
    orchestrationInvokeTimeoutMs: number;
    orchestrationIdempotencyTtlMs: number;
    orchestrationAlertInvokeTimeoutWarnCount: number;
    orchestrationAlertInvokeTimeoutCriticalCount: number;
    orchestrationAlertQueueOverflowWarnCount: number;
    orchestrationAlertQueueOverflowCriticalCount: number;
    orchestrationAlertBrowserAcquireFailureWarnCount: number;
    orchestrationAlertBrowserAcquireFailureCriticalCount: number;
    orchestrationAlertBrowserAcquireTimeoutWarnCount: number;
    orchestrationAlertBrowserAcquireTimeoutCriticalCount: number;
    orchestrationAlertTotalPendingWarn: number;
    orchestrationAlertTotalPendingCritical: number;
    orchestrationAlertStaleSessionsWarn: number;
    orchestrationAlertStaleSessionsCritical: number;
  };
  webview: {
    debugStealthHeaders: boolean;
    debugDevtools: boolean;
  };
  extension: {
    fingerprintStrict: boolean;
    extraLaunchArgs: string[];
    allowNoSandbox: boolean;
    expectedChromeVersion: string;
    expectedChromeVersionPrefix: string;
    expectedChromeSha256: string;
  };
  ocr: {
    adapter: OcrAdapterMode;
    dumpDir: string;
  };
  cv: {
    workerDebug: boolean;
    workerDebugVerbose: boolean;
  };
  logger: {
    env: RuntimeMode;
  };
  repairStudio: {
    modelProvider: RepairStudioModelProviderConfig;
  };
}

const detectRuntimeMode = (runtimeProcess: RuntimeConfigProcessLike | null): RuntimeMode => {
  const hasNodeProcess = !!runtimeProcess?.versions?.node;
  if (!hasNodeProcess) {
    return 'production';
  }

  if (!runtimeProcess.versions?.electron) {
    return 'test';
  }

  if (runtimeProcess.type === 'renderer') {
    if (typeof location !== 'undefined') {
      return location.protocol === 'file:' ? 'production' : 'development';
    }
    return 'development';
  }

  if (typeof require === 'function') {
    try {
      const electron = require('electron') as { app?: { isPackaged?: boolean } };
      if (electron?.app && typeof electron.app.isPackaged === 'boolean') {
        return electron.app.isPackaged ? 'production' : 'development';
      }
    } catch {
      // ignore
    }
  }

  const resourcesPath = (runtimeProcess as unknown as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    if (resourcesPath.includes('app.asar')) {
      return 'production';
    }

    if (typeof require === 'function') {
      try {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        if (fs.existsSync(path.join(resourcesPath, 'app.asar'))) {
          return 'production';
        }
      } catch {
        // ignore: renderer-like contexts may not expose node builtins.
      }
    }
  }

  return 'development';
};

export const createRuntimeConfig = (
  argv?: readonly string[],
  env?: NodeJS.ProcessEnv,
  runtimeProcess: RuntimeConfigProcessLike | null = getRuntimeProcess()
): AirpaRuntimeConfig => {
  const configProcess = withRuntimeArgv(runtimeProcess, argv);
  const runtimeEnv = getRuntimeEnv(env, configProcess);
  const runtimeMode = detectRuntimeMode(configProcess);

  return {
    app: {
      mode: runtimeMode,
      devServerPort: 5273,
      debugProdMenu: false,
    },
    e2e: {
      cdpPort: getE2eCdpPortOverride(configProcess),
    },
    paths: {
      userDataDirOverride: getUserDataDirOverride(configProcess),
      asarExtractBaseDirOverride: getAsarExtractBaseDirOverride(configProcess),
      firefoxExecutablePathOverride: getFirefoxExecutablePathOverride(configProcess),
      cloakBrowserExecutablePathOverride: getCloakBrowserExecutablePathOverride(configProcess),
      chromeExecutablePathOverride: getChromeExecutablePathOverride(configProcess, runtimeEnv),
      localAppDataDir: readEnvValue(runtimeEnv, ['LOCALAPPDATA']),
    },
    http: {
      port: getHttpPortOverride(configProcess) ?? 39090,
      enableHttpOverride: getHttpEnabledOverride(configProcess),
      enableMcpOverride: getMcpEnabledOverride(configProcess),
      mcpProtocolCompatibilityMode: 'sdk-compatible',
      mcpMaxQueueSize: 64,
      mcpInvokeTimeoutMs: 120000,
      orchestrationMaxQueueSize: 128,
      orchestrationInvokeTimeoutMs: 180000,
      orchestrationIdempotencyTtlMs: 300000,
      orchestrationAlertInvokeTimeoutWarnCount: 20,
      orchestrationAlertInvokeTimeoutCriticalCount: 50,
      orchestrationAlertQueueOverflowWarnCount: 10,
      orchestrationAlertQueueOverflowCriticalCount: 30,
      orchestrationAlertBrowserAcquireFailureWarnCount: 10,
      orchestrationAlertBrowserAcquireFailureCriticalCount: 30,
      orchestrationAlertBrowserAcquireTimeoutWarnCount: 10,
      orchestrationAlertBrowserAcquireTimeoutCriticalCount: 30,
      orchestrationAlertTotalPendingWarn: 100,
      orchestrationAlertTotalPendingCritical: 300,
      orchestrationAlertStaleSessionsWarn: 1,
      orchestrationAlertStaleSessionsCritical: 5,
    },
    webview: {
      debugStealthHeaders: false,
      debugDevtools: false,
    },
    extension: {
      fingerprintStrict: false,
      extraLaunchArgs: [],
      allowNoSandbox: getAllowNoSandbox(configProcess),
      expectedChromeVersion: '',
      expectedChromeVersionPrefix: '',
      expectedChromeSha256: '',
    },
    ocr: {
      adapter: 'worker',
      dumpDir: '',
    },
    cv: {
      workerDebug: false,
      workerDebugVerbose: false,
    },
    logger: {
      env: runtimeMode,
    },
    repairStudio: {
      modelProvider: getRepairStudioModelProviderConfig(configProcess, runtimeEnv),
    },
  };
};

export const AIRPA_RUNTIME_CONFIG: AirpaRuntimeConfig = createRuntimeConfig();

export const isDevelopmentMode = (): boolean => AIRPA_RUNTIME_CONFIG.app.mode === 'development';
export const isProductionMode = (): boolean => AIRPA_RUNTIME_CONFIG.app.mode === 'production';

export const resolveUserDataDir = (
  fallbackDir: string,
  runtimeConfig: AirpaRuntimeConfig = AIRPA_RUNTIME_CONFIG
): string => {
  const override = runtimeConfig.paths.userDataDirOverride;
  return override.length > 0 ? override : fallbackDir;
};

export const resolveAsarExtractBaseDir = (
  runtimeConfig: AirpaRuntimeConfig = AIRPA_RUNTIME_CONFIG
): string | null => {
  const override = runtimeConfig.paths.asarExtractBaseDirOverride;
  return override.length > 0 ? override : null;
};

export const resolveFirefoxExecutablePathOverride = (
  runtimeConfig: AirpaRuntimeConfig = AIRPA_RUNTIME_CONFIG
): string | null => {
  const override = runtimeConfig.paths.firefoxExecutablePathOverride;
  return override.length > 0 ? override : null;
};

export const resolveCloakBrowserExecutablePathOverride = (
  runtimeConfig: AirpaRuntimeConfig = AIRPA_RUNTIME_CONFIG
): string | null => {
  const override = runtimeConfig.paths.cloakBrowserExecutablePathOverride;
  return override.length > 0 ? override : null;
};

export const resolveChromeExecutablePathOverride = (
  runtimeConfig: AirpaRuntimeConfig = AIRPA_RUNTIME_CONFIG
): string | null => {
  const override = runtimeConfig.paths.chromeExecutablePathOverride;
  return override.length > 0 ? override : null;
};
