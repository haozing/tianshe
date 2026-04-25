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
}

export async function attachBrowserFailureBundle(
  browser: BrowserFailureCaptureTarget,
  options: BrowserFailureBundleOptions
): Promise<RuntimeArtifact[]> {
  const artifacts: RuntimeArtifact[] = [];
  const maxArtifacts = Math.max(1, options.maxArtifacts ?? 4);

  const snapshotResult = await Promise.allSettled([
    browser.getCurrentUrl().catch(() => ''),
    typeof browser.title === 'function' ? browser.title().catch(() => '') : Promise.resolve(''),
    browser
      .snapshot({
        includeSummary: true,
        includeNetwork: 'smart',
        includeConsole: true,
        elementsFilter: 'interactive',
      })
      .catch(() => null),
  ]);

  const currentUrl = snapshotResult[0].status === 'fulfilled' ? snapshotResult[0].value : '';
  const currentTitle = snapshotResult[1].status === 'fulfilled' ? snapshotResult[1].value : '';
  const snapshot = snapshotResult[2].status === 'fulfilled' ? snapshotResult[2].value : null;

  if (snapshot && artifacts.length < maxArtifacts) {
    artifacts.push(
      await observationService.attachArtifact({
        context: options.context,
        component: options.component,
        type: 'snapshot',
        label: `${options.labelPrefix} snapshot`,
        data: {
          currentUrl,
          currentTitle,
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
          currentUrl,
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
          currentUrl,
          summary: networkSummary,
        },
      })
    );
  }

  if (
    artifacts.length < maxArtifacts &&
    typeof browser.screenshotDetailed === 'function' &&
    !artifacts.some((artifact) => artifact.type === 'snapshot')
  ) {
    try {
      const screenshot = await browser.screenshotDetailed({
        captureMode: 'viewport',
        format: 'jpeg',
        quality: 60,
      });
      artifacts.push(
        await observationService.attachArtifact({
          context: options.context,
          component: options.component,
          type: 'screenshot',
          label: `${options.labelPrefix} screenshot`,
          data: {
            currentUrl,
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
