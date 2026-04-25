import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';

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
import { resolveChromeExecutablePath } from './chrome-runtime-shared';
import { sleep, waitForCondition } from './browser-pool-integration-smoke-shared';

const shouldRunRealContract =
  process.env.AIRPA_RUN_EXTENSION_REAL_CONTRACT === '1' ||
  process.env.AIRPA_RUN_EXTENSION_REAL_CONTRACT === 'true';
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

async function writeReport(reportPath: string, report: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildComparableContract(report: Record<string, any>) {
  return {
    version: 'shared-real-contract-v1',
    commonCapabilities: report.commonCapabilities,
    pageTitle: report.pageTitle,
    networkIdleText: report.networkIdleText,
    currentUrlPath: report.currentUrlPath,
    titleText: report.titleText,
    emulatedUserAgent: report.emulatedUserAgent,
    emulatedViewportWidth: report.emulatedViewportWidth,
    emulatedViewportHeight: report.emulatedViewportHeight,
    emulationClearedUserAgent: report.emulationClearedUserAgent,
    cookieFilterDomainMatchedCount: report.cookieFilterDomainMatchedCount,
    cookieFilterPathMatchedNames: report.cookieFilterPathMatchedNames,
    windowOpenPolicyPath: report.windowOpenPolicyPath,
    windowOpenPolicySearch: report.windowOpenPolicySearch,
    windowOpenPolicyTitle: report.windowOpenPolicyTitle,
    backNavigationSearch: report.backNavigationSearch,
    forwardNavigationSearch: report.forwardNavigationSearch,
    reloadNavigationType: report.reloadNavigationType,
    evaluateContract: report.evaluateContract,
    evaluateWithArgsContract: report.evaluateWithArgsContract,
    cookieValue: report.cookieValue,
    cookiesCleared: report.cookiesCleared,
    inputValue: report.inputValue,
    selectedValue: report.selectedValue,
    fetchResultText: report.fetchResultText,
    responseStatus: report.responseStatus,
    responsePath: report.responsePath,
    networkEntriesObserved: report.networkEntriesObserved,
    consoleEventObserved: report.consoleEventObserved,
    screenshotCaptured: report.screenshotCaptured,
    snapshotElementCountPositive: report.snapshotElementCountPositive,
    snapshotContainsTitle: report.snapshotContainsTitle,
    postShowHideTitle: report.postShowHideTitle,
  };
}

function logStep(step: string): void {
  if (debugRealContract) {
    console.log(`[extension-real-contract] ${step}`);
  }
}

describe('createExtensionBrowserFactory shared real contract', () => {
  runRealContract(
    'keeps shared real-browser capabilities aligned with the common contract',
    async () => {
      if (process.platform !== 'win32') {
        throw new Error('Extension real contract requires Windows because it launches bundled chrome.exe.');
      }

      const chromePath = resolveChromeExecutablePath();
      if (!fs.existsSync(chromePath)) {
        throw new Error(`Bundled Chrome runtime not found: ${chromePath}`);
      }

      const reportPath = requireEnv('AIRPA_REAL_CONTRACT_REPORT_PATH');
      const baseUrl = requireEnv('AIRPA_REAL_CONTRACT_BASE_URL');
      const networkIdleUrl = requireEnv('AIRPA_REAL_CONTRACT_NETWORK_IDLE_URL');
      const title = requireEnv('AIRPA_REAL_CONTRACT_TITLE');
      const pingMessage = requireEnv('AIRPA_REAL_CONTRACT_PING_MESSAGE');

      const report: Record<string, any> = {
        engine: 'extension',
        scenario: 'shared-real-contract-v1',
        startedAt: new Date().toISOString(),
        reportPath,
        baseUrl,
        networkIdleUrl,
        pageTitle: title,
        commonCapabilities: {},
        errors: [],
      };

      const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-extension-real-contract-'));
      const originalExtraLaunchArgs = [...AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs];
      electronState.userDataDir = path.join(tempRoot, 'user-data-root');
      AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
        0,
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
        '--start-minimized'
      );

      const factory = createExtensionBrowserFactory();
      const sessionId = `extension-real-contract-${Date.now()}`;
      const fingerprint = getDefaultFingerprint();
      let closeBrowser: (() => Promise<void>) | null = null;

      try {
        const created = await factory({
          id: sessionId,
          partition: `persist:${sessionId}`,
          engine: 'extension',
          fingerprint: {
            ...fingerprint,
            identity: {
              ...fingerprint.identity,
              region: {
                ...fingerprint.identity.region,
                timezone: 'Asia/Hong_Kong',
              },
            },
            source: {
              mode: 'generated',
              fileFormat: 'txt',
            },
          },
          proxy: null,
          quota: 1,
          idleTimeoutMs: 60_000,
          lockTimeoutMs: 60_000,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        });

        closeBrowser = () => created.browser.closeInternal();
        logStep('browser created');
        expect(created.browser.describeRuntime()).toMatchObject({
          engine: 'extension',
        });

        report.commonCapabilities = {
          'network.capture': created.browser.hasCapability('network.capture'),
          'console.capture': created.browser.hasCapability('console.capture'),
          'screenshot.detailed': created.browser.hasCapability('screenshot.detailed'),
          'window.showHide': created.browser.hasCapability('window.showHide'),
          'input.native': created.browser.hasCapability('input.native'),
          'text.dom': created.browser.hasCapability('text.dom'),
          'emulation.identity': created.browser.hasCapability('emulation.identity'),
          'emulation.viewport': created.browser.hasCapability('emulation.viewport'),
        };
        expect(report.commonCapabilities).toEqual({
          'network.capture': true,
          'console.capture': true,
          'screenshot.detailed': true,
          'window.showHide': true,
          'input.native': true,
          'text.dom': true,
          'emulation.identity': true,
          'emulation.viewport': true,
        });

        created.browser.startConsoleCapture({ level: 'all' });
        await created.browser.startNetworkCapture({
          clearExisting: true,
          captureBody: true,
          maxEntries: 128,
          urlFilter: '/api/ping',
        });
        logStep('capture started');

        await created.browser.goto(networkIdleUrl, {
          timeout: 30_000,
          waitUntil: 'networkidle0',
        });
        await waitForCondition(async () => {
          const text = await created.browser.getText('#network-idle-result');
          return text === 'slow response after 700ms';
        }, 10_000, 'network idle result');
        report.networkIdleText = await created.browser.getText('#network-idle-result');
        logStep(`network idle text: ${report.networkIdleText}`);

        await created.browser.goto(baseUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await created.browser.waitForSelector('#title', {
          timeout: 30_000,
          state: 'visible',
        });
        logStep('navigated to base page');

        report.currentUrlPath = new URL(await created.browser.getCurrentUrl()).pathname;
        report.titleText = await created.browser.getText('#title');
        expect(await created.browser.title()).toBe(title);
        expect(report.titleText).toBe(title);
        logStep('title verified');

        const baselineUserAgent = await created.browser.getUserAgent();
        const baselineViewport = await created.browser.evaluate<{
          width: number;
          height: number;
        }>('({ width: window.innerWidth, height: window.innerHeight })');
        await created.browser.setEmulationIdentity({
          userAgent: 'AirpaSharedRealContract/1.0',
        });
        await created.browser.setViewportEmulation({
          width: 913,
          height: 677,
          devicePixelRatio: 1.25,
          hasTouch: true,
        });
        await waitForCondition(async () => {
          return (
            (await created.browser.evaluate<string>('navigator.userAgent')) ===
            'AirpaSharedRealContract/1.0'
          );
        }, 5_000, 'extension emulated user agent');
        report.emulatedUserAgent = await created.browser.getUserAgent();
        report.emulatedNavigatorUserAgent = await created.browser.evaluate<string>(
          'navigator.userAgent'
        );
        {
          const emulatedViewport = await created.browser.evaluate<{
            width: number;
            height: number;
          }>('({ width: window.innerWidth, height: window.innerHeight })');
          report.emulatedViewportWidth = emulatedViewport.width;
          report.emulatedViewportHeight = emulatedViewport.height;
        }
        await created.browser.clearEmulation();
        await waitForCondition(async () => {
          return (
            (await created.browser.evaluate<string>('navigator.userAgent')) === baselineUserAgent
          );
        }, 5_000, 'extension emulation clear user agent');
        {
          const clearedViewport = await created.browser.evaluate<{
            width: number;
            height: number;
          }>('({ width: window.innerWidth, height: window.innerHeight })');
          report.emulationClearedViewport =
            clearedViewport.width === baselineViewport.width &&
            clearedViewport.height === baselineViewport.height;
        }
        report.emulationClearedUserAgent =
          (await created.browser.evaluate<string>('navigator.userAgent')) === baselineUserAgent;
        logStep('emulation contract verified for extension runtime');

        created.browser.setWindowOpenPolicy({ default: 'same-window' });
        await sleep(300);
        await created.browser.click('#same-window-link');
        await waitForCondition(async () => {
          const currentUrl = new URL(await created.browser.getCurrentUrl());
          return (
            currentUrl.pathname === '/child' && currentUrl.search === '?from=same-window'
          );
        }, 10_000, 'window open policy navigation');
        {
          const currentUrl = new URL(await created.browser.getCurrentUrl());
          report.windowOpenPolicyPath = currentUrl.pathname;
          report.windowOpenPolicySearch = currentUrl.search;
        }
        report.windowOpenPolicyTitle = await created.browser.getText('#child-title');
        created.browser.clearWindowOpenPolicy();
        await created.browser.goto(baseUrl, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await waitForCondition(async () => {
          try {
            return (await created.browser.getText('#title')) === title;
          } catch {
            return false;
          }
        }, 30_000, 'return to base page after same-window policy');
        logStep(
          `window open policy: path=${report.windowOpenPolicyPath}, search=${report.windowOpenPolicySearch}`
        );

        report.evaluateContract = await created.browser.evaluate(`
          (() => ({
            title: document.title,
            pathname: location.pathname,
            promptResult: document.querySelector('#prompt-result')?.textContent || ''
          }))()
        `);
        report.evaluateWithArgsContract = await created.browser.evaluateWithArgs(
          (label, delta) => ({
            label,
            sum: Number(delta) + 2,
            title: document.title,
            pathname: location.pathname,
          }),
          'shared-eval',
          5
        );
        logStep('evaluate contracts verified');

        await created.browser.type('#name', '', { clear: true });
        await created.browser.click('#name');
        await created.browser.native.type('shared real contract', { delay: 40 });
        await waitForCondition(async () => {
          const value = await created.browser.evaluate<string>(
            "document.querySelector('#name').value"
          );
          return value === 'shared real contract';
        }, 10_000, 'typed input value');
        report.inputValue = await created.browser.evaluate<string>(
          "document.querySelector('#name').value"
        );
        logStep(`input value: ${report.inputValue}`);

        await created.browser.select('#choice', 'beta');
        report.selectedValue = await created.browser.evaluate<string>(
          "document.querySelector('#choice').value"
        );
        logStep(`selected value: ${report.selectedValue}`);

        await created.browser.click('#fetch');
        logStep('fetch clicked');
        const responseEntry = await created.browser.waitForResponse('/api/ping', 30_000);
        report.responseStatus = responseEntry.status;
        report.responsePath = new URL(responseEntry.url).pathname;
        await waitForCondition(async () => {
          const text = await created.browser.getText('#result');
          return text === pingMessage;
        }, 10_000, 'fetch result text');
        report.fetchResultText = await created.browser.getText('#result');
        logStep(`fetch result: ${report.fetchResultText}`);
        await waitForCondition(
          async () =>
            created.browser
              .getConsoleMessages()
              .some((message) => message.message.includes('smoke-button-clicked')),
          10_000,
          'console capture event'
        );
        report.consoleEventObserved = true;
        report.networkEntriesObserved = created.browser.getNetworkEntries().some((entry) => {
          try {
            return new URL(entry.url).pathname === '/api/ping';
          } catch {
            return false;
          }
        });
        logStep('network and console verified');

        await created.browser.clearCookies();
        await created.browser.setCookie({
          name: 'airpa_contract',
          value: 'shared-cookie',
          path: '/',
        });
        report.cookieValue =
          (await created.browser.getCookies({ name: 'airpa_contract' })).find(
            (cookie) => cookie.name === 'airpa_contract'
          )?.value ?? null;
        await created.browser.clearCookies();
        report.cookiesCleared =
          (await created.browser.getCookies({ name: 'airpa_contract' })).length === 0;
        await created.browser.setCookie({
          name: 'airpa_root',
          value: 'root-cookie',
          path: '/',
        });
        await created.browser.setCookie({
          name: 'airpa_child',
          value: 'child-cookie',
          path: '/child',
        });
        {
          const hostname = new URL(await created.browser.getCurrentUrl()).hostname;
          report.cookieFilterDomainMatchedCount = (
            await created.browser.getCookies({ domain: hostname })
          ).filter((cookie) => cookie.name.startsWith('airpa_')).length;
          report.cookieFilterPathMatchedNames = (
            await created.browser.getCookies({ path: '/child' })
          )
            .filter((cookie) => cookie.name.startsWith('airpa_'))
            .map((cookie) => cookie.name)
            .sort();
        }
        await created.browser.clearCookies();
        logStep(`cookie contract: value=${report.cookieValue}, cleared=${report.cookiesCleared}`);

        await created.browser.goto(`${baseUrl}?view=one`, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await waitForCondition(async () => {
          try {
            return (await created.browser.getText('#title')) === title;
          } catch {
            return false;
          }
        }, 30_000, 'query navigation one title');
        await created.browser.goto(`${baseUrl}?view=two`, {
          timeout: 30_000,
          waitUntil: 'load',
        });
        await waitForCondition(async () => {
          try {
            return (await created.browser.getText('#title')) === title;
          } catch {
            return false;
          }
        }, 30_000, 'query navigation two title');
        await created.browser.back();
        await waitForCondition(async () => {
          return new URL(await created.browser.getCurrentUrl()).search === '?view=one';
        }, 10_000, 'back navigation search');
        report.backNavigationSearch = new URL(await created.browser.getCurrentUrl()).search;
        await created.browser.forward();
        await waitForCondition(async () => {
          return new URL(await created.browser.getCurrentUrl()).search === '?view=two';
        }, 10_000, 'forward navigation search');
        report.forwardNavigationSearch = new URL(await created.browser.getCurrentUrl()).search;
        await created.browser.reload();
        await waitForCondition(async () => {
          try {
            return (await created.browser.getText('#title')) === title;
          } catch {
            return false;
          }
        }, 30_000, 'reload title');
        report.reloadNavigationType = await created.browser.evaluate<string>(
          "performance.getEntriesByType('navigation')[0]?.type || ''"
        );
        logStep(
          `navigation contract: back=${report.backNavigationSearch}, forward=${report.forwardNavigationSearch}, reload=${report.reloadNavigationType}`
        );

        const screenshot = await created.browser.screenshotDetailed({
          captureMode: 'full_page',
          format: 'png',
        });
        report.screenshotCaptured =
          screenshot.mimeType === 'image/png' && screenshot.data.length > 0;
        logStep(`screenshot captured: ${report.screenshotCaptured}`);

        const snapshot = await created.browser.snapshot({
          includeSummary: true,
          includeConsole: true,
          includeNetwork: 'smart',
        });
        report.snapshotElementCountPositive = snapshot.elements.length > 0;
        report.snapshotContainsTitle = snapshot.elements.some(
          (element) => element.text === title || element.name === title
        );
        logStep('snapshot verified');

        await created.browser.hide();
        logStep('browser hidden');
        await sleep(250);
        await created.browser.show();
        logStep('browser shown');
        await sleep(250);
        report.postShowHideTitle = await created.browser.getText('#title');
        logStep(`post show/hide title: ${report.postShowHideTitle}`);

        report.comparableContract = buildComparableContract(report);
        report.finishedAt = new Date().toISOString();
        report.ok = true;
        await writeReport(reportPath, report);
      } catch (error) {
        report.finishedAt = new Date().toISOString();
        report.ok = false;
        report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
        await writeReport(reportPath, report);
        throw error;
      } finally {
        if (closeBrowser) {
          await closeBrowser().catch(() => undefined);
        }
        AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.splice(
          0,
          AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs.length,
          ...originalExtraLaunchArgs
        );
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
