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

import { createRuyiBrowserFactory } from './browser-pool-integration-ruyi';
import {
  createFingerprintProbeServer,
  type FingerprintProbeSnapshot,
  waitForFingerprintProbe,
  waitForFingerprintProbeMatch,
  writeFingerprintRealReport,
} from './browser-pool-integration-fingerprint-shared';
import { sleep } from './browser-pool-integration-smoke-shared';
import { resolveFirefoxExecutablePath } from './ruyi-runtime-shared';

const shouldRunRealContract =
  process.env.AIRPA_RUN_RUYI_FINGERPRINT_REAL === '1' ||
  process.env.AIRPA_RUN_RUYI_FINGERPRINT_REAL === 'true';
const runRealContract = shouldRunRealContract ? it : it.skip;
const debugRealContract =
  process.env.AIRPA_DEBUG_REAL_CONTRACT === '1' ||
  process.env.AIRPA_DEBUG_REAL_CONTRACT === 'true';

function requireEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function assertFirefoxRuntimeAvailable(): string {
  const firefoxPath = resolveFirefoxExecutablePath();
  if (path.isAbsolute(firefoxPath) && !fs.existsSync(firefoxPath)) {
    throw new Error(
      `Firefox runtime not found: ${firefoxPath}. Install Firefox or pass --airpa-firefox-path=/path/to/firefox.`
    );
  }
  return firefoxPath;
}

function logStep(step: string): void {
  if (debugRealContract) {
    console.log(`[ruyi-fingerprint-real] ${step}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameComparable(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordExpectation(
  validationErrors: string[],
  label: string,
  assertion: () => void
): void {
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
  return mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
    identity: {
      region: {
        timezone: 'Asia/Hong_Kong',
        primaryLanguage: 'en-GB',
        languages: ['en-GB', 'en'],
      },
      hardware: {
        browserFamily: 'firefox',
        browserVersion: '151.0',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
        hardwareConcurrency: 6,
        fontSystem: 'windows',
      },
      display: {
        width: 1366,
        height: 768,
        availWidth: 1366,
        availHeight: 728,
        colorDepth: 24,
      },
      automationSignals: {
        webdriver: 0,
      },
      graphics: {
        webgl: {
          maskedVendor: 'Google Inc. (AMD)',
          maskedRenderer:
            'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
          version: 'WebGL 1.0',
          glslVersion: 'WebGL GLSL ES 1.0',
          unmaskedVendor: 'Google Inc. (AMD)',
          unmaskedRenderer:
            'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
          maxTextureSize: 16384,
          maxCubeMapTextureSize: 16384,
          maxTextureImageUnits: 16,
          maxVertexAttribs: 16,
          aliasedPointSizeMax: 255,
          maxViewportDim: 16384,
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
    engine: 'ruyi',
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
    language: snapshot.language,
    languages: snapshot.languages.slice(0, 2),
    timezone: snapshot.timezone,
    hardwareConcurrency: snapshot.hardwareConcurrency,
    screen: {
      width: snapshot.screen.width,
      height: snapshot.screen.height,
    },
    webdriver: snapshot.webdriver === true,
    webgl: {
      maskedVendor: snapshot.webgl?.maskedVendor ?? null,
      maskedRenderer: snapshot.webgl?.maskedRenderer ?? null,
      version: snapshot.webgl?.version ?? null,
    },
  };
}

function expectedStartup() {
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
    language: 'en-GB',
    languages: ['en-GB', 'en'],
    timezone: 'Asia/Hong_Kong',
    hardwareConcurrency: 6,
    screen: {
      width: 1366,
      height: 768,
    },
    webdriver: false,
    webgl: {
      maskedVendor: 'Google Inc. (AMD)',
      maskedRenderer:
        'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
      version: 'WebGL 1.0',
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

describe('createRuyiBrowserFactory fingerprint robustness', () => {
  runRealContract(
    'keeps startup fingerprint truth stable and records runtime emulation observations separately',
    async () => {
      const firefoxPath = assertFirefoxRuntimeAvailable();
      expect(firefoxPath.length).toBeGreaterThan(0);

      const reportPath = requireEnv('AIRPA_FINGERPRINT_REAL_REPORT_PATH');
      const report: Record<string, unknown> = {
        engine: 'ruyi',
        scenario: 'fingerprint-robustness-v1',
        startedAt: new Date().toISOString(),
        reportPath,
        errors: [],
      };

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-fingerprint-'));
      const probeServer = await createFingerprintProbeServer({
        title: 'Ruyi Fingerprint Probe',
      });
      electronState.userDataDir = path.join(tempRoot, 'user-data-root');
      electronState.appPath = tempRoot;

      const factory = createRuyiBrowserFactory();
      const startupFingerprint = buildFingerprint();
      const startupExpectation = expectedStartup();
      const validationErrors: string[] = [];
      const activeInvocationErrors: string[] = [];
      const runtimeExpectation = {
        identity: {
          userAgent: 'AirpaFingerprintRuntime/ruyi-1.0',
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
          createSession(`ruyi-fingerprint-generated-${Date.now()}`, startupFingerprint)
        );
        closeGenerated = () => generated.browser.closeInternal();
        expect(generated.browser.describeRuntime()).toMatchObject({
          engine: 'ruyi',
        });
        expect(generated.browser.hasCapability('emulation.identity')).toBe(true);
        expect(generated.browser.hasCapability('emulation.viewport')).toBe(true);
        await generated.browser.show();
        await sleep(600);
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
          'ruyi generated startup probe'
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
        const viewOneProbe = await waitForFingerprintProbe(generated.browser, 'ruyi view one');
        expect(new URL(viewOneProbe.href).search).toBe('?view=one');
        recordExpectation(validationErrors, 'view=one startup stability', () => {
          expect(comparableStartup(viewOneProbe)).toEqual(startupExpectation);
        });

        await generated.browser.goto(probeServer.variantUrl('two'), {
          timeout: 30_000,
          waitUntil: 'load',
        });
        const viewTwoProbe = await waitForFingerprintProbe(generated.browser, 'ruyi view two');
        expect(new URL(viewTwoProbe.href).search).toBe('?view=two');
        recordExpectation(validationErrors, 'view=two startup stability', () => {
          expect(comparableStartup(viewTwoProbe)).toEqual(startupExpectation);
        });

        await generated.browser.back();
        const backProbe = await waitForFingerprintProbeMatch(
          generated.browser,
          'ruyi back navigation',
          (snapshot) => snapshot.search === '?view=one'
        );
        recordExpectation(validationErrors, 'back navigation startup stability', () => {
          expect(comparableStartup(backProbe)).toEqual(startupExpectation);
        });

        await generated.browser.forward();
        const forwardProbe = await waitForFingerprintProbeMatch(
          generated.browser,
          'ruyi forward navigation',
          (snapshot) => snapshot.search === '?view=two'
        );
        recordExpectation(validationErrors, 'forward navigation startup stability', () => {
          expect(comparableStartup(forwardProbe)).toEqual(startupExpectation);
        });

        await generated.browser.reload();
        const reloadProbe = await waitForFingerprintProbe(generated.browser, 'ruyi reload');
        recordExpectation(validationErrors, 'reload startup stability', () => {
          expect(comparableStartup(reloadProbe)).toEqual(startupExpectation);
        });

        await generated.browser.hide();
        await sleep(250);
        await generated.browser.show();
        await sleep(400);
        const showHideProbe = await waitForFingerprintProbe(generated.browser, 'ruyi show hide');
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
              'ruyi active identity observation'
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
              'ruyi active viewport observation'
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
            return waitForFingerprintProbe(generated.browser, 'ruyi runtime snapshot');
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
              'ruyi clear emulation',
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
            filePath: path.join(tempRoot, 'profile-file', 'ignored.fpfile.txt'),
            fileFormat: 'txt',
          },
        });

        const fileMode = await factory(
          createSession(`ruyi-fingerprint-file-${Date.now()}`, fileModeFingerprint)
        );
        closeFileMode = () => fileMode.browser.closeInternal();
        await fileMode.browser.show();
        await sleep(600);
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
          'ruyi legacy file-source startup probe'
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
        await probeServer.close().catch(() => undefined);
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    180_000
  );
});
