import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
import type { SessionConfig } from '../../core/browser-pool/types';
import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';
import { ExtensionBrowser } from '../../core/browser-extension';
import {
  buildChromeLaunchArgs,
  buildManagedExtensionLaunchArgs,
  buildNativeChromeProxyArgs,
  getExtensionControlRuntimeDir,
  getExtensionUserDataDir,
  getFingerprintPreflightIssues,
  parseExtraChromeLaunchArgs,
  resolveChromeExecutablePath,
  type ManagedLaunchExtension,
  validateChromeRuntime,
} from './chrome-runtime-shared';
import type { PreparedRuyiLaunch } from './ruyi-launch-config-shared';
import { prepareRuyiLaunch } from './ruyi-launch-config-shared';
import { ExtensionControlRelay } from './extension-control-relay';
import { renderControlExtensionBundle } from './extension-control-extension-bundle';

type ExtensionFactoryOptions = {
  resolveManagedExtensions?: (profileId: string) => Promise<ManagedLaunchExtension[]>;
};

type ChildExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ExtensionLaunchArgsOptions = {
  session: SessionConfig;
  userDataDir: string;
  managedExtensionArgs: string[];
  ruyiArg: string;
};

const REQUIRED_NATIVE_FINGERPRINT_ARGS = [
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgl',
] as const;

export function buildExtensionLaunchArgs(options: ExtensionLaunchArgsOptions): string[] {
  const { session, userDataDir, managedExtensionArgs, ruyiArg } = options;
  const noSandboxArgs = AIRPA_RUNTIME_CONFIG.extension.allowNoSandbox ? ['--no-sandbox'] : [];
  return buildChromeLaunchArgs(parseExtraChromeLaunchArgs(), managedExtensionArgs, [
    ...REQUIRED_NATIVE_FINGERPRINT_ARGS,
    ...noSandboxArgs,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    `--user-data-dir=${userDataDir}`,
    ruyiArg,
    ...buildNativeChromeProxyArgs(session),
    'about:blank',
  ]);
}

function writeControlExtensionBundle(
  runtimeDir: string,
  bundle: Record<string, string>
): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(bundle)) {
    const targetPath = path.join(runtimeDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
  }
}

function waitForChildExit(child: ChildProcess): Promise<ChildExitResult> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({
        code: child.exitCode,
        signal: child.signalCode as NodeJS.Signals | null,
      });
      return;
    }
    child.once('exit', (code, signal) =>
      resolve({
        code,
        signal: signal as NodeJS.Signals | null,
      })
    );
  });
}

function captureProcessStreamPreview(
  stream: NodeJS.ReadableStream | null | undefined,
  limit: number = 8192
): () => string {
  let output = '';
  const readable = stream as (NodeJS.ReadableStream & { setEncoding?: (encoding: string) => void }) | null | undefined;
  if (readable?.setEncoding) {
    readable.setEncoding('utf8');
  }
  readable?.on?.('data', (chunk) => {
    const next = output + String(chunk || '');
    output = next.length > limit ? next.slice(next.length - limit) : next;
  });
  return () => output.trim();
}

export function buildExtensionStartupErrorMessage(options: {
  sessionId: string;
  preparedRuyi: PreparedRuyiLaunch;
  exit: ChildExitResult;
  stderr: string;
}): string {
  const { sessionId, preparedRuyi, exit, stderr } = options;
  const exitDescription =
    exit.code !== null
      ? `code=${exit.code}`
      : exit.signal
        ? `signal=${exit.signal}`
        : 'code=null';
  const compactStderr = stderr.replace(/\s+/g, ' ').trim();
  const likelyRuyiFailure =
    compactStderr.length > 0 &&
    /(?:--ruyi|ruyi).*(?:unknown|unsupported|invalid|unrecognized)|(?:unknown|unsupported|invalid|unrecognized).*(?:--ruyi|ruyi)/i.test(
      compactStderr
    );
  const messageParts = [
    `[ExtensionFactory] Chrome exited before extension control was ready for session ${sessionId} (${exitDescription}).`,
    `ruyi=${preparedRuyi.source}`,
    `file=${preparedRuyi.filePath}`,
  ];

  if (compactStderr) {
    messageParts.push(`stderr=${compactStderr}`);
  }
  if (likelyRuyiFailure) {
    messageParts.push('Likely cause: bundled Chrome rejected --ruyi or failed to parse the ruyi payload.');
  }

  return messageParts.join(' ');
}

async function killChromeProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
    });
    return;
  }

  child.kill('SIGTERM');
  const exited = await Promise.race([
    waitForChildExit(child).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
  }
}

export function createExtensionBrowserFactory(options?: ExtensionFactoryOptions): BrowserFactory {
  return async (session: SessionConfig) => {
    const strictFingerprintGate = AIRPA_RUNTIME_CONFIG.extension.fingerprintStrict;
    const preflightIssues = getFingerprintPreflightIssues(session);
    if (preflightIssues.length > 0) {
      const message = `[ExtensionFactory] fingerprint preflight issues for session ${session.id}: ${preflightIssues.join(', ')}`;
      if (strictFingerprintGate) {
        throw new Error(message);
      }
      console.warn(message);
    }

    const chromePath = resolveChromeExecutablePath();
    await validateChromeRuntime(chromePath);

    const browserId = randomUUID();
    const relay = new ExtensionControlRelay({ browserId });
    await relay.start();

    const runtimeDir = getExtensionControlRuntimeDir(session.id, browserId);
    const userDataDir = getExtensionUserDataDir(session.id);
    fs.mkdirSync(userDataDir, { recursive: true });

    const managedExtensions = options?.resolveManagedExtensions
      ? await options.resolveManagedExtensions(session.id)
      : [];
    const preparedRuyi = prepareRuyiLaunch(session);

    writeControlExtensionBundle(
      runtimeDir,
      renderControlExtensionBundle({
        runtimeConfig: {
          ...relay.getLaunchConfig(),
          proxy: session.proxy ?? null,
        },
      })
    );

    const launchExtensions: ManagedLaunchExtension[] = [
      {
        extensionId: '__airpa_internal_control__',
        extractDir: runtimeDir,
        installMode: 'required',
      },
      ...managedExtensions,
    ];

    const managedExtensionArgs = buildManagedExtensionLaunchArgs(launchExtensions);
    const launchArgs = buildExtensionLaunchArgs({
      session,
      userDataDir,
      managedExtensionArgs,
      ruyiArg: preparedRuyi.arg,
    });
    console.log(
      `[ExtensionFactory] session=${session.id} ruyi=${preparedRuyi.source} file=${preparedRuyi.filePath}`
    );

    const chromeProcess = spawn(chromePath, launchArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
    const readStderrPreview = captureProcessStreamPreview(chromeProcess.stderr);

    let disposed = false;
    const cleanup = async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await killChromeProcess(chromeProcess).catch(() => undefined);
      await relay.stop().catch(() => undefined);
      await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    };

    chromeProcess.once('exit', () => {
      void relay.stop().catch(() => undefined);
      void fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    });

    try {
      const initialClientState = await Promise.race([
        relay.waitForClient(20000),
        waitForChildExit(chromeProcess).then((exit) => {
          throw new Error(
            buildExtensionStartupErrorMessage({
              sessionId: session.id,
              preparedRuyi,
              exit,
              stderr: readStderrPreview(),
            })
          );
        }),
        new Promise<never>((_, reject) => {
          chromeProcess.once('error', reject);
        }),
      ]);

      const browser = new ExtensionBrowser({
        relay,
        closeInternal: cleanup,
        initialClientState,
        browserProcessId: chromeProcess.pid ?? null,
      });

      return {
        browser,
        engine: 'extension',
      };
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  };
}

