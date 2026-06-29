import {
  buildBidiUrlPatterns,
  serializeBidiHeaders,
  serializeBidiStringValue,
} from './ruyi-firefox-client-utils';
import type {
  DispatchInterceptContinueParams,
  DispatchInterceptEnableParams,
  DispatchInterceptFailParams,
  DispatchInterceptFulfillParams,
} from './ruyi-firefox-client.types';
import type { BrowserInterceptPattern } from '../../types/browser-interface';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

type WithRecoveredActiveContext = <TResult>(
  timeoutMs: number,
  operation: (context: string) => Promise<TResult>
) => Promise<TResult>;

export interface RuyiFirefoxNetworkControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  withRecoveredActiveContext: WithRecoveredActiveContext;
  activeInterceptIds: Set<string>;
  setInterceptPatterns: (patterns: BrowserInterceptPattern[]) => void;
  disableRequestInterception: (timeoutMs: number) => Promise<void>;
}

export class RuyiFirefoxNetworkController {
  constructor(private readonly deps: RuyiFirefoxNetworkControllerDeps) {}

  async enableRequestInterception(
    params: DispatchInterceptEnableParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.deps.disableRequestInterception(timeoutMs).catch(() => undefined);
    const patterns = Array.isArray(params?.options?.patterns) ? params.options?.patterns ?? [] : [];
    // Only literal pathname filters can be expressed safely with BiDi urlPatterns while
    // preserving current local matcher semantics. When a pattern needs substring/regex-style
    // handling, we keep interception broad and continue non-matching requests locally.
    const urlPatterns = buildBidiUrlPatterns(patterns);
    const result = await this.deps.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.deps.sendBiDiCommand<{ intercept?: string }>(
        'network.addIntercept',
        {
          phases: ['beforeRequestSent'],
          contexts: [context],
          ...(urlPatterns ? { urlPatterns } : {}),
        },
        timeoutMs
      )
    );
    const interceptId = String(result.intercept || '').trim();
    if (!interceptId) {
      throw new Error('Failed to create Firefox network intercept');
    }
    this.deps.activeInterceptIds.add(interceptId);
    this.deps.setInterceptPatterns(patterns);
  }

  async disableRequestInterception(timeoutMs: number): Promise<void> {
    const interceptIds = [...this.deps.activeInterceptIds];
    this.deps.activeInterceptIds.clear();
    this.deps.setInterceptPatterns([]);
    await Promise.all(
      interceptIds.map((interceptId) =>
        this.deps.sendBiDiCommand(
          'network.removeIntercept',
          {
            intercept: interceptId,
          },
          timeoutMs
        )
      )
    );
  }

  async continueInterceptedRequest(
    params: DispatchInterceptContinueParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.deps.sendBiDiCommand(
      'network.continueRequest',
      {
        request: requestId,
        ...(params?.overrides?.url ? { url: params.overrides.url } : {}),
        ...(params?.overrides?.method ? { method: params.overrides.method } : {}),
        ...(params?.overrides?.headers
          ? { headers: serializeBidiHeaders(params.overrides.headers) }
          : {}),
        ...(params?.overrides?.postData
          ? { body: serializeBidiStringValue(params.overrides.postData) }
          : {}),
      },
      timeoutMs
    );
  }

  async fulfillInterceptedRequest(
    params: DispatchInterceptFulfillParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.deps.sendBiDiCommand(
      'network.provideResponse',
      {
        request: requestId,
        statusCode: params?.response?.status ?? 200,
        ...(params?.response?.headers
          ? { headers: serializeBidiHeaders(params.response.headers) }
          : {}),
        ...(typeof params?.response?.body === 'string'
          ? { body: serializeBidiStringValue(params.response.body) }
          : {}),
      },
      timeoutMs
    );
  }

  async failInterceptedRequest(
    params: DispatchInterceptFailParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.deps.sendBiDiCommand(
      'network.failRequest',
      {
        request: requestId,
      },
      timeoutMs
    );
  }
}
