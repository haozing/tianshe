import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../../core/browser-pool/types';
import {
  getDefaultFingerprint,
  mergeFingerprintConfig,
} from '../../constants/fingerprint-defaults';

const electronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    isPackaged: false,
  },
}));

import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';
import { createExtensionBrowserFactory } from './browser-pool-integration-extension';
import {
  createFingerprintProbeServer,
  type FingerprintProbeSnapshot,
  waitForFingerprintProbe,
  waitForFingerprintProbeMatch,
  writeFingerprintRealReport,
} from './browser-pool-integration-fingerprint-shared';
import { sleep } from './browser-pool-integration-smoke-shared';
import { resolveChromeExecutablePath } from './chrome-runtime-shared';

const shouldRunRealContract =
  process.env.AIRPA_RUN_EXTENSION_FINGERPRINT_REAL === '1' ||
  process.env.AIRPA_RUN_EXTENSION_FINGERPRINT_REAL === 'true';
const runRealContract = shouldRunRealContract ? it : it.skip;
const debugRealContract =
  process.env.AIRPA_DEBUG_REAL_CONTRACT === '1' || process.env.AIRPA_DEBUG_REAL_CONTRACT === 'true';

function requireEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function logStep(step: string): void {
  if (debugRealContract) {
    console.log(`[extension-fingerprint-real] ${step}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameComparable(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordExpectation(validationErrors: string[], label: string, assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    validationErrors.push(`${label}: ${formatError(error)}`);
  }
}

async function recordStep<T>(
  validationErrors: string[],
  label: string,
  step: () => Promise<T>
): Promise<T | null> {
  try {
    return await step();
  } catch (error) {
    validationErrors.push(`${label}: ${formatError(error)}`);
    return null;
  }
}

function buildFingerprint() {
  return mergeFingerprintConfig(getDefaultFingerprint('extension'), {
    identity: {
      region: {
        timezone: 'Asia/Hong_Kong',
        primaryLanguage: 'en-GB',
        languages: ['en-GB', 'en'],
      },
      hardware: {
        browserFamily: 'chromium',
        browserVersion: '141.0.0.0',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        platform: 'Win32',
        hardwareConcurrency: 10,
        deviceMemory: 16,
      },
      display: {
        width: 1440,
        height: 900,
        availWidth: 1440,
        availHeight: 860,
        colorDepth: 24,
      },
      automationSignals: {
        webdriver: 0,
      },
      graphics: {
        webgl: {
          maskedVendor: 'Google Inc. (Intel)',
          maskedRenderer:
            'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
          glslVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
          unmaskedVendor: 'Google Inc. (Intel)',
          unmaskedRenderer:
            'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        },
      },
    },
    source: {
      mode: 'generated',
      fileFormat: 'txt',
    },
  });
}

function createSession(id: string, fingerprint: SessionConfig['fingerprint']): SessionConfig {
  return {
    id,
    partition: `persist:${id}`,
    engine: 'extension',
    fingerprint,
    proxy: null,
    quota: 1,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}

function comparableStartup(snapshot: FingerprintProbeSnapshot) {
  return {
    userAgent: snapshot.userAgent,
    platform: snapshot.platform,
    language: snapshot.language,
    languages: snapshot.languages.slice(0, 2),
    timezone: snapshot.timezone,
    hardwareConcurrency: snapshot.hardwareConcurrency,
    deviceMemory: snapshot.deviceMemory,
    screen: {
      width: snapshot.screen.width,
      height: snapshot.screen.height,
      availWidth: snapshot.screen.availWidth,
      availHeight: snapshot.screen.availHeight,
      colorDepth: snapshot.screen.colorDepth,
    },
    maxTouchPoints: snapshot.maxTouchPoints,
    webdriver: snapshot.webdriver === true,
    webgl: {
      maskedVendor: snapshot.webgl?.maskedVendor ?? null,
      maskedRenderer: snapshot.webgl?.maskedRenderer ?? null,
    },
  };
}

function expectedStartup() {
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'en-GB',
    languages: ['en-GB', 'en'],
    timezone: 'Asia/Hong_Kong',
    hardwareConcurrency: 10,
    deviceMemory: 16,
    screen: {
      width: 1440,
      height: 900,
      availWidth: 1440,
      availHeight: 860,
      colorDepth: 24,
    },
    maxTouchPoints: 0,
    webdriver: false,
    webgl: {
      maskedVendor: 'Google Inc. (Intel)',
      maskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  };
}

function recordIdentityObservation(
  snapshot: FingerprintProbeSnapshot,
  expected: { userAgent: string; locale: string; timezone: string }
) {
  return {
    observed: {
      userAgent: snapshot.userAgent,
      locale: snapshot.locale,
      timezone: snapshot.timezone,
    },
    matched: {
      userAgent: snapshot.userAgent === expected.userAgent,
      locale: snapshot.locale === expected.locale,
      timezone: snapshot.timezone === expected.timezone,
    },
  };
}

function recordViewportObservation(
  snapshot: FingerprintProbeSnapshot,
  expected: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    maxTouchPoints: number;
  }
) {
  const devicePixelRatio = Number(snapshot.viewport.devicePixelRatio.toFixed(2));
  return {
    observed: {
      innerWidth: snapshot.viewport.innerWidth,
      innerHeight: snapshot.viewport.innerHeight,
      devicePixelRatio,
      maxTouchPoints: snapshot.maxTouchPoints,
    },
    matched: {
      innerWidth: snapshot.viewport.innerWidth === expected.innerWidth,
      innerHeight: snapshot.viewport.innerHeight === expected.innerHeight,
      devicePixelRatio: Math.abs(devicePixelRatio - expected.devicePixelRatio) < 0.01,
      maxTouchPoints: snapshot.maxTouchPoints === expected.maxTouchPoints,
    },
  };
}

describe('createExtensionBrowserFactory fingerprint robustness', () => {
  runRealContract(
    'keeps startup fingerprint truth stable and records runtime emulation observations separately',
    async () => {
      if (process.platform !== 'win32') {
        throw new Error('Extension fingerprint real contract requires Windows.');
      }

      const chromePath = resolveChromeExecutablePath();
      if (!fs.existsSync(chromePath)) {
        throw new Error(`Bundled Chrome runtime not found: ${chromePath}`);
      }

      const reportPath = requireEnv('AIRPA_FINGERPRINT_REAL_REPORT_PATH');
      const report: Record<string, unknown> = {
        engine: 'extension',
        scenario: 'fingerprint-robustness-v1',
        startedAt: new Date().toISOString(),
        reportPath,
        errors: [],
      };

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-extension-fingerprint-'));
      const probeServer = await createFingerprintProbeServer({
        title: 'Extension Fingerprint Probe',
      });
      const originalExtraLaunchArgs = [...AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs];
      AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
        0,
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
        '--start-minimized'
      );
      electronState.userDataDir = path.join(tempRoot, 'user-data-root');
      electronState.appPath = tempRoot;

      const factory = createExtensionBrowserFactory();
      const startupExpectation = expectedStartup();
      const startupFingerprint = buildFingerprint();
      const validationErrors: string[] = [];
      const activeInvocationErrors: string[] = [];
      const runtimeExpectation = {
        identity: {
          userAgent: 'AirpaFingerprintRuntime/extension-1.0',
          locale: 'ja-JP',
          timezone: 'Asia/Tokyo',
        },
        viewport: {
          innerWidth: 913,
          innerHeight: 677,
          devicePixelRatio: 1.5,
          maxTouchPoints: 1,
        },
      };
      report.validationErrors = validationErrors;
      report.activeInvocationErrors = activeInvocationErrors;

      let closeGenerated: (() => Promise<void>) | null = null;
      let closeFileMode: (() => Promise<void>) | null = null;

      try {
        const generated = await factory(
          createSession(`extension-fingerprint-generated-${Date.now()}`, startupFingerprint)
        );
        closeGenerated = () => generated.browser.closeInternal();
        expect(generated.browser.describeRuntime()).toMatchObject({
          engine: 'extension',
        });
        expect(generated.browser.hasCapability('emulation.identity')).toBe(true);
        expect(generated.browser.hasCapability('emulation.viewport')).toBe(true);
        logStep('generated browser created');

        await generated.browser.goto(probeServer.probeUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await generated.browser.waitForSelector('#probe-title', {
          timeout: 30_000,
          state: 'visible',
        });
        const generatedStartupProbe = await waitForFingerprintProbe(
          generated.browser,
          'extension generated startup probe'
        );
        const generatedStartupComparable = comparableStartup(generatedStartupProbe);
        report.generatedStartupProbe = generatedStartupProbe;
        recordExpectation(validationErrors, 'generated startup truth', () => {
          expect(generatedStartupComparable).toEqual(startupExpectation);
        });
        logStep('generated startup truth verified');

        await generated.browser.goto(probeServer.variantUrl('one'), {
          timeout: 30_000,
          waitUntil: 'load',
        });
        const viewOneProbe = await waitForFingerprintProbe(generated.browser, 'extension view one');
        expect(new URL(viewOneProbe.href).search).toBe('?view=one');
        recordExpectation(validationErrors, 'view=one startup stability', () => {
          expect(comparableStartup(viewOneProbe)).toEqual(startupExpectation);
        });

        await generated.browser.goto(probeServer.variantUrl('two'), {
          timeout: 30_000,
          waitUntil: 'load',
        });
        const viewTwoProbe = await waitForFingerprintProbe(generated.browser, 'extension view two');
        expect(new URL(viewTwoProbe.href).search).toBe('?view=two');
        recordExpectation(validationErrors, 'view=two startup stability', () => {
          expect(comparableStartup(viewTwoProbe)).toEqual(startupExpectation);
        });

        await generated.browser.back();
        const backProbe = await waitForFingerprintProbeMatch(
          generated.browser,
          'extension back navigation',
          (snapshot) => snapshot.search === '?view=one'
        );
        recordExpectation(validationErrors, 'back navigation startup stability', () => {
          expect(comparableStartup(backProbe)).toEqual(startupExpectation);
        });

        await generated.browser.forward();
        const forwardProbe = await waitForFingerprintProbeMatch(
          generated.browser,
          'extension forward navigation',
          (snapshot) => snapshot.search === '?view=two'
        );
        recordExpectation(validationErrors, 'forward navigation startup stability', () => {
          expect(comparableStartup(forwardProbe)).toEqual(startupExpectation);
        });

        await generated.browser.reload();
        const reloadProbe = await waitForFingerprintProbe(generated.browser, 'extension reload');
        recordExpectation(validationErrors, 'reload startup stability', () => {
          expect(comparableStartup(reloadProbe)).toEqual(startupExpectation);
        });

        await generated.browser.hide();
        await sleep(250);
        await generated.browser.show();
        await sleep(250);
        const showHideProbe = await waitForFingerprintProbe(
          generated.browser,
          'extension show hide'
        );
        recordExpectation(validationErrors, 'show/hide startup stability', () => {
          expect(comparableStartup(showHideProbe)).toEqual(startupExpectation);
        });
        report.navigationStability = {
          one: viewOneProbe,
          two: viewTwoProbe,
          back: backProbe,
          forward: forwardProbe,
          reload: reloadProbe,
          showHide: showHideProbe,
        };
        logStep('navigation stability verified');

        const identityObservation = await recordStep(
          activeInvocationErrors,
          'active invocation identity',
          async () => {
            await generated.browser.setEmulationIdentity({
              userAgent: runtimeExpectation.identity.userAgent,
              locale: runtimeExpectation.identity.locale,
              timezoneId: runtimeExpectation.identity.timezone,
            });
            await sleep(350);
            const snapshot = await waitForFingerprintProbe(
              generated.browser,
              'extension active identity observation'
            );
            return recordIdentityObservation(snapshot, runtimeExpectation.identity);
          }
        );

        const viewportObservation = await recordStep(
          activeInvocationErrors,
          'active invocation viewport',
          async () => {
            await generated.browser.setViewportEmulation({
              width: runtimeExpectation.viewport.innerWidth,
              height: runtimeExpectation.viewport.innerHeight,
              devicePixelRatio: runtimeExpectation.viewport.devicePixelRatio,
              hasTouch: true,
            });
            await sleep(350);
            const snapshot = await waitForFingerprintProbe(
              generated.browser,
              'extension active viewport observation'
            );
            return recordViewportObservation(snapshot, runtimeExpectation.viewport);
          }
        );

        report.activeInvocation = {
          identity: identityObservation,
          viewport: viewportObservation,
        };

        const runtimeProbe = await recordStep(
          activeInvocationErrors,
          'runtime observation snapshot',
          async () => {
            await generated.browser.setEmulationIdentity({
              timezoneId: runtimeExpectation.identity.timezone,
            });
            await generated.browser.setViewportEmulation({
              width: runtimeExpectation.viewport.innerWidth,
              height: runtimeExpectation.viewport.innerHeight,
            });
            await sleep(250);
            return waitForFingerprintProbe(generated.browser, 'extension runtime snapshot');
          }
        );
        report.runtimeProbe = runtimeProbe;

        const clearedProbe = await recordStep(
          activeInvocationErrors,
          'clear emulation',
          async () => {
            await generated.browser.clearEmulation();
            return waitForFingerprintProbeMatch(
              generated.browser,
              'extension clear emulation',
              (snapshot) => sameComparable(comparableStartup(snapshot), generatedStartupComparable)
            );
          }
        );
        report.clearedProbe = clearedProbe;
        if (clearedProbe) {
          report.clearedMatchedObservedBaseline = sameComparable(
            comparableStartup(clearedProbe),
            generatedStartupComparable
          );
        }
        logStep('runtime isolation verified');

        await closeGenerated();
        closeGenerated = null;

        const fileModeFingerprint = mergeFingerprintConfig(startupFingerprint, {
          source: {
            mode: 'file',
            filePath: path.join(tempRoot, 'profile-file', 'ignored.ruyi.txt'),
            fileFormat: 'txt',
          },
        });

        const fileMode = await factory(
          createSession(`extension-fingerprint-file-${Date.now()}`, fileModeFingerprint)
        );
        closeFileMode = () => fileMode.browser.closeInternal();
        logStep('legacy file-source browser created');

        await fileMode.browser.goto(probeServer.probeUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await fileMode.browser.waitForSelector('#probe-title', {
          timeout: 30_000,
          state: 'visible',
        });
        const fileModeProbe = await waitForFingerprintProbe(
          fileMode.browser,
          'extension legacy file-source startup probe'
        );
        const fileModeComparable = comparableStartup(fileModeProbe);
        report.fileModeProbe = fileModeProbe;
        recordExpectation(validationErrors, 'legacy file-source startup truth', () => {
          expect(fileModeComparable).toEqual(startupExpectation);
        });
        report.generatedVsFileMatched = sameComparable(
          fileModeComparable,
          generatedStartupComparable
        );
        if (report.generatedVsFileMatched !== true) {
          validationErrors.push(
            'generated/legacy-file parity: actual generated and legacy-source probes diverged'
          );
        }
        logStep('generated/legacy-file parity verified');

        report.finishedAt = new Date().toISOString();
        report.ok = validationErrors.length === 0;
        await writeFingerprintRealReport(reportPath, report);
        if (validationErrors.length > 0) {
          throw new Error(validationErrors.join('\n'));
        }
      } catch (error) {
        report.finishedAt = new Date().toISOString();
        report.ok = false;
        (report.errors as string[]).push(
          error instanceof Error ? error.stack || error.message : String(error)
        );
        await writeFingerprintRealReport(reportPath, report);
        throw error;
      } finally {
        if (closeGenerated) {
          await closeGenerated().catch(() => undefined);
        }
        if (closeFileMode) {
          await closeFileMode().catch(() => undefined);
        }
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
          0,
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
          ...originalExtraLaunchArgs
        );
        await probeServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    180_000
  );
});
