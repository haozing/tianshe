import type { WebContents } from 'electron';
import { createBlockedNavigationError } from '../core/browser-core/navigation-guard';

const DEFAULT_WEB_CONTENTS_NAVIGATION_TIMEOUT_MS = 30000;

export async function loadWebContentsURL(
  webContents: WebContents,
  url: string,
  options?: {
    timeout?: number;
    waitUntil?: 'load' | 'domcontentloaded';
    onRecoverableAbort?: (targetUrl: string) => void;
  }
): Promise<void> {
  const blockedNavigationError = createBlockedNavigationError(url);
  if (blockedNavigationError) {
    throw blockedNavigationError;
  }

  const timeout = options?.timeout ?? DEFAULT_WEB_CONTENTS_NAVIGATION_TIMEOUT_MS;
  const waitUntil = options?.waitUntil ?? 'domcontentloaded';

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let recoverableAbortReported = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Navigation timeout: ${url}`));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timeoutId);
      webContents.removeListener('did-finish-load', finishHandler);
      webContents.removeListener('dom-ready', domReadyHandler);
      webContents.removeListener('did-fail-load', failHandler);
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const reportRecoverableAbort = (targetUrl: string) => {
      if (recoverableAbortReported) return;
      recoverableAbortReported = true;
      options?.onRecoverableAbort?.(targetUrl);
    };

    const finishHandler = () => {
      if (waitUntil !== 'load') return;
      settleResolve();
    };

    const domReadyHandler = () => {
      if (waitUntil !== 'domcontentloaded') return;
      settleResolve();
    };

    const failHandler = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string
    ) => {
      if (errorCode === -3) {
        reportRecoverableAbort(validatedURL || url);
        return;
      }

      settleReject(new Error(`Navigation failed: ${errorDescription} (code: ${errorCode})`));
    };

    webContents.on('did-fail-load', failHandler);
    webContents.once('did-finish-load', finishHandler);
    webContents.once('dom-ready', domReadyHandler);

    webContents.loadURL(url).catch((error: unknown) => {
      const err = error as { code?: string; errno?: number; message?: string };
      if (err?.code === 'ERR_ABORTED' && err?.errno === -3) {
        reportRecoverableAbort(url);
        return;
      }

      const message = err?.message || String(error);
      settleReject(new Error(`Failed to start navigation: ${message}`));
    });
  });
}
