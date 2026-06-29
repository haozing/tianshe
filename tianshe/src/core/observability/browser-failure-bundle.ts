import type { BrowserInterface } from '../../types/browser-interface';
import type { RuntimeArtifact } from './types';
import { observationService } from './observation-service';
import type { TraceContext } from './types';

type BrowserFailureCaptureTarget = Pick<
  BrowserInterface,
  'getCurrentUrl' | 'snapshot' | 'getNetworkSummary' | 'getConsoleMessages' | 'title' | 'screenshotDetailed'
>;

export interface BrowserFailureBundleOptions {
  context: TraceContext;
  component: string;
  labelPrefix: string;
  maxArtifacts?: number;
  timeoutMs?: number;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000;

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function attachBrowserFailureBundle(
  browser: BrowserFailureCaptureTarget,
  options: BrowserFailureBundleOptions
): Promise<RuntimeArtifact[]> {
  const artifacts: RuntimeArtifact[] = [];
  const maxArtifacts = Math.max(1, options.maxArtifacts ?? 4);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

  const [currentUrl, currentTitle, snapshot] = await Promise.all([
    settleWithTimeout(browser.getCurrentUrl(), timeoutMs),
    typeof browser.title === 'function'
      ? settleWithTimeout(browser.title(), timeoutMs)
      : Promise.resolve(''),
    settleWithTimeout(
      browser.snapshot({
        includeSummary: true,
        includeNetwork: 'smart',
        includeConsole: true,
        elementsFilter: 'interactive',
      }),
      timeoutMs
    ),
  ]);

  if (snapshot && artifacts.length < maxArtifacts) {
    artifacts.push(
      await observationService.attachArtifact({
        context: options.context,
        component: options.component,
        type: 'snapshot',
        label: `${options.labelPrefix} snapshot`,
        data: {
          currentUrl: currentUrl ?? '',
          currentTitle: currentTitle ?? '',
          snapshot,
        },
      })
    );
  }

  const consoleTail =
    typeof browser.getConsoleMessages === 'function'
      ? browser.getConsoleMessages().slice(-20)
      : [];
  if (consoleTail.length > 0 && artifacts.length < maxArtifacts) {
    artifacts.push(
      await observationService.attachArtifact({
        context: options.context,
        component: options.component,
        type: 'console_tail',
        label: `${options.labelPrefix} console tail`,
        data: {
          currentUrl: currentUrl ?? '',
          messages: consoleTail,
        },
      })
    );
  }

  const networkSummary =
    typeof browser.getNetworkSummary === 'function' ? browser.getNetworkSummary() : undefined;
  if (networkSummary && artifacts.length < maxArtifacts) {
    artifacts.push(
      await observationService.attachArtifact({
        context: options.context,
        component: options.component,
        type: 'network_summary',
        label: `${options.labelPrefix} network summary`,
        data: {
          currentUrl: currentUrl ?? '',
          summary: networkSummary,
        },
      })
    );
  }

  if (
    artifacts.length < maxArtifacts &&
    typeof browser.screenshotDetailed === 'function'
  ) {
    try {
      const screenshot = await settleWithTimeout(
        browser.screenshotDetailed({
          captureMode: 'viewport',
          format: 'jpeg',
          quality: 60,
        }),
        timeoutMs
      );
      if (!screenshot) {
        return artifacts;
      }
      artifacts.push(
        await observationService.attachArtifact({
          context: options.context,
          component: options.component,
          type: 'screenshot',
          label: `${options.labelPrefix} screenshot`,
          data: {
            currentUrl: currentUrl ?? '',
            screenshot: {
              mimeType: screenshot.mimeType,
              format: screenshot.format,
              captureMode: screenshot.captureMode,
              captureMethod: screenshot.captureMethod,
              fallbackUsed: screenshot.fallbackUsed,
              degraded: screenshot.degraded,
              base64: screenshot.data,
            },
          },
        })
      );
    } catch {
      // Best-effort failure bundle only.
    }
  }

  return artifacts;
}
