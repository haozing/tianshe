import type {
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
} from '../../types/browser-interface';
import { isUnsupportedBiDiCommandError } from './ruyi-firefox-client-utils';
import { sleep } from './ruyi-firefox-launch-helpers';
import type {
  DispatchEmulationIdentityParams,
  DispatchEmulationViewportParams,
  DispatchEvaluateWithArgsParams,
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

type EvaluateExpression = <TResult>(expression: string, timeoutMs: number) => Promise<TResult>;

type EvaluateWithArgs = <TResult>(
  params: DispatchEvaluateWithArgsParams,
  timeoutMs: number
) => Promise<TResult>;

type ViewportEmulationBaseline = {
  contextId: string;
  innerWidth: number;
  innerHeight: number;
} | null;

type ViewportMetrics = {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
};

export interface RuyiFirefoxEmulationControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  withRecoveredActiveContext: WithRecoveredActiveContext;
  evaluateExpression: EvaluateExpression;
  evaluateWithArgs: EvaluateWithArgs;
  getViewportEmulationBaseline: () => ViewportEmulationBaseline;
  setViewportEmulationBaseline: (baseline: ViewportEmulationBaseline) => void;
}

export class RuyiFirefoxEmulationController {
  constructor(private readonly deps: RuyiFirefoxEmulationControllerDeps) {}

  async setEmulationIdentity(
    params: DispatchEmulationIdentityParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const options = params?.options ?? {};
    const has = (name: keyof BrowserEmulationIdentityOptions) =>
      Object.prototype.hasOwnProperty.call(options, name);

    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      if (has('userAgent')) {
        await this.deps.sendBiDiCommand(
          'emulation.setUserAgentOverride',
          {
            userAgent: options.userAgent ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('locale')) {
        await this.deps.sendBiDiCommand(
          'emulation.setLocaleOverride',
          {
            locale: options.locale ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('timezoneId')) {
        await this.deps.sendBiDiCommand(
          'emulation.setTimezoneOverride',
          {
            timezone: options.timezoneId ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('touch')) {
        await this.setTouchOverrideIfSupported(options.touch ? 1 : null, context, timeoutMs);
      }
      if (has('geolocation')) {
        await this.deps.sendBiDiCommand(
          'emulation.setGeolocationOverride',
          {
            coordinates: options.geolocation
              ? {
                  latitude: options.geolocation.latitude,
                  longitude: options.geolocation.longitude,
                  accuracy: options.geolocation.accuracy ?? 1,
                }
              : null,
            contexts: [context],
          },
          timeoutMs
        );
      }
    });
  }

  async setViewportEmulation(
    params: DispatchEmulationViewportParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const options = params?.options;
    if (!options) {
      throw new Error('viewport options are required');
    }

    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.ensureViewportEmulationBaseline(context, timeoutMs);
      await this.applyViewportEmulation(context, options, timeoutMs);

      if (typeof options.hasTouch === 'boolean') {
        await this.setTouchOverrideIfSupported(
          options.hasTouch ? 1 : null,
          context,
          timeoutMs
        );
      }
    });
  }

  async clearEmulation(timeoutMs: number): Promise<void> {
    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      try {
        await this.deps.sendBiDiCommand(
          'browsingContext.setViewport',
          {
            context,
            viewport: null,
            devicePixelRatio: null,
          },
          timeoutMs
        );
      } catch (error) {
        if (!this.shouldFallbackViewportEmulation(error)) {
          throw error;
        }
        const baseline = this.deps.getViewportEmulationBaseline();
        if (baseline && baseline.contextId === context) {
          await this.applyViewportResizeFallback(
            context,
            {
              width: baseline.innerWidth,
              height: baseline.innerHeight,
            },
            timeoutMs
          );
        }
      }
      await this.deps.sendBiDiCommand(
        'emulation.setUserAgentOverride',
        {
          userAgent: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.deps.sendBiDiCommand(
        'emulation.setLocaleOverride',
        {
          locale: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.deps.sendBiDiCommand(
        'emulation.setTimezoneOverride',
        {
          timezone: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.setTouchOverrideIfSupported(null, context, timeoutMs);
      await this.deps.sendBiDiCommand(
        'emulation.setGeolocationOverride',
        {
          coordinates: null,
          contexts: [context],
        },
        timeoutMs
      );
    });
  }

  private async applyViewportEmulation(
    context: string,
    options: BrowserEmulationViewportOptions,
    timeoutMs: number
  ): Promise<void> {
    try {
      await this.deps.sendBiDiCommand(
        'browsingContext.setViewport',
        {
          context,
          viewport: {
            width: Math.max(1, Math.round(options.width)),
            height: Math.max(1, Math.round(options.height)),
          },
          ...(typeof options.devicePixelRatio === 'number'
            ? { devicePixelRatio: options.devicePixelRatio }
            : {}),
        },
        timeoutMs
      );
    } catch (error) {
      if (!this.shouldFallbackViewportEmulation(error)) {
        throw error;
      }
      await this.applyViewportResizeFallback(
        context,
        {
          width: Math.max(1, Math.round(options.width)),
          height: Math.max(1, Math.round(options.height)),
        },
        timeoutMs
      );
    }
  }

  private async setTouchOverrideIfSupported(
    maxTouchPoints: number | null,
    context: string,
    timeoutMs: number
  ): Promise<void> {
    try {
      await this.deps.sendBiDiCommand(
        'emulation.setTouchOverride',
        {
          maxTouchPoints,
          contexts: [context],
        },
        timeoutMs
      );
    } catch (error) {
      if (!isUnsupportedBiDiCommandError(error)) {
        throw error;
      }
    }
  }

  private shouldFallbackViewportEmulation(error: unknown): boolean {
    if (isUnsupportedBiDiCommandError(error)) {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('BiDi command timed out: browsingContext.setViewport');
  }

  private async ensureViewportEmulationBaseline(
    contextId: string,
    timeoutMs: number
  ): Promise<void> {
    if (this.deps.getViewportEmulationBaseline()?.contextId === contextId) {
      return;
    }
    const viewport = await this.readViewportMetrics(timeoutMs);
    this.deps.setViewportEmulationBaseline({
      contextId,
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight,
    });
  }

  private async readViewportMetrics(timeoutMs: number): Promise<ViewportMetrics> {
    return await this.deps.evaluateExpression<ViewportMetrics>(
      '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight })',
      timeoutMs
    );
  }

  private async applyViewportResizeFallback(
    contextId: string,
    viewport: { width: number; height: number },
    timeoutMs: number
  ): Promise<void> {
    const clientWindowFallbackError = await this.applyViewportClientWindowFallback(
      viewport,
      timeoutMs
    ).catch((error) => (error instanceof Error ? error : new Error(String(error))));
    if (!clientWindowFallbackError) {
      return;
    }

    await this.deps.evaluateWithArgs(
      {
        functionSource: `async (targetWidth, targetHeight) => {
          const desiredWidth = Math.max(1, Math.round(Number(targetWidth) || 0));
          const desiredHeight = Math.max(1, Math.round(Number(targetHeight) || 0));
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const read = () => ({
            innerWidth: Number(window.innerWidth || 0),
            innerHeight: Number(window.innerHeight || 0),
            outerWidth: Number(window.outerWidth || 0),
            outerHeight: Number(window.outerHeight || 0),
          });

          let snapshot = read();
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const frameWidth = Math.max(0, snapshot.outerWidth - snapshot.innerWidth);
            const frameHeight = Math.max(0, snapshot.outerHeight - snapshot.innerHeight);
            try {
              window.resizeTo(desiredWidth + frameWidth, desiredHeight + frameHeight);
            } catch {}
            try {
              window.focus();
            } catch {}
            await sleep(120);
            snapshot = read();
            if (snapshot.innerWidth === desiredWidth && snapshot.innerHeight === desiredHeight) {
              break;
            }
          }

          return snapshot;
        }`,
        args: [viewport.width, viewport.height],
      },
      timeoutMs
    );

    const after = await this.readViewportMetrics(timeoutMs);
    if (after.innerWidth !== viewport.width || after.innerHeight !== viewport.height) {
      throw new Error(
        `Viewport resize fallback failed for context ${contextId}: expected ${viewport.width}x${viewport.height}, actual ${after.innerWidth}x${after.innerHeight}; clientWindowFallback=${clientWindowFallbackError.message}`
      );
    }
  }

  private async applyViewportClientWindowFallback(
    viewport: { width: number; height: number },
    timeoutMs: number
  ): Promise<void> {
    const windows = await this.deps.sendBiDiCommand<{
      clientWindows?: Array<{
        active?: boolean;
        clientWindow?: string;
        width?: number;
        height?: number;
      }>;
    }>('browser.getClientWindows', {}, timeoutMs);

    const clientWindowInfo =
      windows.clientWindows?.find((window) => window.active === true) ??
      windows.clientWindows?.[0];
    const clientWindow = String(clientWindowInfo?.clientWindow || '').trim();
    if (!clientWindow) {
      throw new Error('No Firefox client window available for viewport fallback');
    }

    let currentWindowWidth = Math.max(
      1,
      Math.round(Number(clientWindowInfo?.width || 0)) || 1
    );
    let currentWindowHeight = Math.max(
      1,
      Math.round(Number(clientWindowInfo?.height || 0)) || 1
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const currentViewport = await this.readViewportMetrics(timeoutMs);
      const frameWidth = Math.max(0, currentWindowWidth - currentViewport.innerWidth);
      const frameHeight = Math.max(0, currentWindowHeight - currentViewport.innerHeight);
      const targetWindowWidth = Math.max(1, Math.round(viewport.width + frameWidth));
      const targetWindowHeight = Math.max(1, Math.round(viewport.height + frameHeight));

      const result = await this.deps.sendBiDiCommand<{
        width?: number;
        height?: number;
      }>(
        'browser.setClientWindowState',
        {
          clientWindow,
          state: 'normal',
          width: targetWindowWidth,
          height: targetWindowHeight,
        },
        timeoutMs
      );

      currentWindowWidth = Math.max(
        1,
        Math.round(Number(result.width ?? targetWindowWidth)) || targetWindowWidth
      );
      currentWindowHeight = Math.max(
        1,
        Math.round(Number(result.height ?? targetWindowHeight)) || targetWindowHeight
      );

      await sleep(200);

      const nextViewport = await this.readViewportMetrics(timeoutMs);
      if (nextViewport.innerWidth === viewport.width && nextViewport.innerHeight === viewport.height) {
        return;
      }
    }

    const lastViewport = await this.readViewportMetrics(timeoutMs);
    throw new Error(
      `browser.setClientWindowState could not reach viewport ${viewport.width}x${viewport.height}, actual ${lastViewport.innerWidth}x${lastViewport.innerHeight}`
    );
  }
}
