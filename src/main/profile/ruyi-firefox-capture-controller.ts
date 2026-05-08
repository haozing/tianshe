import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserPdfResult } from '../../types/browser-interface';
import type {
  DispatchPdfSaveParams,
  DispatchScreenshotParams,
} from './ruyi-firefox-client.types';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

type WithRecoveredActiveContext = <TResult>(
  timeoutMs: number,
  operation: (context: string) => Promise<TResult>
) => Promise<TResult>;

export interface RuyiFirefoxCaptureControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  withRecoveredActiveContext: WithRecoveredActiveContext;
}

export class RuyiFirefoxCaptureController {
  constructor(private readonly deps: RuyiFirefoxCaptureControllerDeps) {}

  async captureScreenshot(
    params: DispatchScreenshotParams,
    timeoutMs: number
  ): Promise<{ data: string; sourceFormat: 'png'; captureMode: 'viewport' | 'full_page' }> {
    const captureMode = params?.captureMode === 'full_page' ? 'full_page' : 'viewport';
    const result = await this.deps.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.deps.sendBiDiCommand<{ data?: string }>(
        'browsingContext.captureScreenshot',
        {
          context,
          origin: captureMode === 'full_page' ? 'document' : 'viewport',
        },
        timeoutMs
      )
    );

    return {
      data: String(result.data || ''),
      sourceFormat: 'png',
      captureMode,
    };
  }

  async savePdf(
    params: DispatchPdfSaveParams | undefined,
    timeoutMs: number
  ): Promise<BrowserPdfResult> {
    const options = params?.options;
    const pageRanges =
      typeof options?.pageRanges === 'string' && options.pageRanges.trim().length > 0
        ? options.pageRanges
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : undefined;
    const result = await this.deps.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.deps.sendBiDiCommand<{ data?: string }>(
        'browsingContext.print',
        {
          context,
          background: options?.printBackground === true,
          orientation: options?.landscape === true ? 'landscape' : 'portrait',
          ...(pageRanges && pageRanges.length > 0 ? { pageRanges } : {}),
        },
        timeoutMs
      )
    );

    const data = String(result.data || '');
    if (!data) {
      throw new Error('Firefox BiDi returned an empty PDF payload');
    }

    if (typeof options?.path === 'string' && options.path.trim().length > 0) {
      const resolvedPath = path.resolve(options.path);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, Buffer.from(data, 'base64'));
      return {
        data,
        path: resolvedPath,
      };
    }

    return { data };
  }
}
