/**
 * Runtime configuration SSOT for ai-dev architecture.
 *
 * Rule: runtime code must not read process.env directly.
 */

export type RuntimeMode = 'development' | 'production' | 'test';
export type OcrAdapterMode = 'worker' | 'inprocess';

const getRuntimeProcess = (): NodeJS.Process | null => {
  return typeof process !== 'undefined' ? process : null;
};

const readProcessArgValue = (flagName: string): string => {
  const runtimeProcess = getRuntimeProcess();
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

const readProcessArgInteger = (flagName: string): number | null => {
  const raw = readProcessArgValue(flagName);
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
};

const readProcessArgBoolean = (flagName: string): boolean | null => {
  const runtimeProcess = getRuntimeProcess();
  const args = Array.isArray(runtimeProcess?.argv) ? runtimeProcess.argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      continue;
    }

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

const getUserDataDirOverride = (): string => readProcessArgValue('--airpa-user-data-dir');
const getAsarExtractBaseDirOverride = (): string =>
  readProcessArgValue('--airpa-asar-extract-base-dir');
const getFirefoxExecutablePathOverride = (): string =>
  readProcessArgValue('--airpa-firefox-path');
const getHttpPortOverride = (): number | null => readProcessArgInteger('--airpa-http-port');
const getHttpEnabledOverride = (): boolean | null => readProcessArgBoolean('--airpa-enable-http');
const getMcpEnabledOverride = (): boolean | null => readProcessArgBoolean('--airpa-enable-mcp');
const getAllowNoSandbox = (): boolean =>
  readProcessArgBoolean('--tianshe-allow-no-sandbox') ??
  readProcessArgBoolean('--airpa-allow-no-sandbox') ??
  false;

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
}

const detectRuntimeMode = (): RuntimeMode => {
  const runtimeProcess = getRuntimeProcess();
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
  if (typeof resourcesPath === 'string' && resourcesPath.includes('app.asar')) {
    return 'production';
  }

  return 'development';
};

const runtimeMode = detectRuntimeMode();

export const AIRPA_RUNTIME_CONFIG: AirpaRuntimeConfig = {
  app: {
    mode: runtimeMode,
    devServerPort: 5273,
    debugProdMenu: false,
  },
  e2e: {
    cdpPort: null,
  },
  paths: {
    userDataDirOverride: getUserDataDirOverride(),
    asarExtractBaseDirOverride: getAsarExtractBaseDirOverride(),
    firefoxExecutablePathOverride: getFirefoxExecutablePathOverride(),
  },
  http: {
    port: getHttpPortOverride() ?? 39090,
    enableHttpOverride: getHttpEnabledOverride(),
    enableMcpOverride: getMcpEnabledOverride(),
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
    allowNoSandbox: getAllowNoSandbox(),
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
};

export const isDevelopmentMode = (): boolean => AIRPA_RUNTIME_CONFIG.app.mode === 'development';
export const isProductionMode = (): boolean => AIRPA_RUNTIME_CONFIG.app.mode === 'production';

export const resolveUserDataDir = (fallbackDir: string): string => {
  const override = getUserDataDirOverride();
  return override.length > 0 ? override : fallbackDir;
};

export const resolveAsarExtractBaseDir = (): string | null => {
  const override = getAsarExtractBaseDirOverride();
  return override.length > 0 ? override : null;
};

export const resolveFirefoxExecutablePathOverride = (): string | null => {
  const override = getFirefoxExecutablePathOverride();
  return override.length > 0 ? override : null;
};
