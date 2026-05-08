import type { BrowserTabInfo } from '../../types/browser-interface';
import { parseScriptResult } from './ruyi-firefox-client-utils';
import type {
  BrowsingContextInfo,
  DispatchCreateTabParams,
  DispatchTabControlParams,
  ScriptCommandResult,
} from './ruyi-firefox-client.types';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

export interface RuyiFirefoxTabControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  getCurrentActiveContextId: () => string | null;
  setActiveContextId: (contextId: string, timeoutMs: number) => Promise<void>;
  recoverActiveContextId: (timeoutMs: number) => Promise<void>;
}

export class RuyiFirefoxTabController {
  constructor(private readonly deps: RuyiFirefoxTabControllerDeps) {}

  async listTabs(timeoutMs: number): Promise<BrowserTabInfo[]> {
    const tree = await this.deps.sendBiDiCommand<{ contexts?: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 },
      timeoutMs
    );
    const contexts = Array.isArray(tree.contexts) ? tree.contexts : [];
    return await Promise.all(contexts.map((context) => this.toTabInfo(context, timeoutMs)));
  }

  async createTab(
    params: DispatchCreateTabParams | undefined,
    timeoutMs: number
  ): Promise<BrowserTabInfo> {
    const created = await this.deps.sendBiDiCommand<{ context?: string }>(
      'browsingContext.create',
      {
        type: 'tab',
        background: params?.active === false,
      },
      timeoutMs
    );
    const contextId = String(created.context || '').trim();
    if (!contextId) {
      throw new Error('Failed to create Firefox browsing context');
    }

    if (params?.active !== false) {
      await this.deps.setActiveContextId(contextId, timeoutMs);
    }

    if (params?.url) {
      await this.deps.sendBiDiCommand(
        'browsingContext.navigate',
        {
          context: contextId,
          url: params.url,
          wait: 'complete',
        },
        timeoutMs
      );
    }

    return await this.toTabInfo({ context: contextId, url: params?.url }, timeoutMs);
  }

  async activateTab(
    params: DispatchTabControlParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const contextId = String(params?.id || '').trim();
    if (!contextId) {
      throw new Error('tab id is required');
    }
    await this.deps.sendBiDiCommand(
      'browsingContext.activate',
      {
        context: contextId,
      },
      timeoutMs
    );
    await this.deps.setActiveContextId(contextId, timeoutMs);
  }

  async closeTab(params: DispatchTabControlParams | undefined, timeoutMs: number): Promise<void> {
    const contextId = String(params?.id || '').trim();
    if (!contextId) {
      throw new Error('tab id is required');
    }
    await this.deps.sendBiDiCommand(
      'browsingContext.close',
      {
        context: contextId,
      },
      timeoutMs
    );
    if (this.deps.getCurrentActiveContextId() === contextId) {
      await this.deps.recoverActiveContextId(timeoutMs);
    }
  }

  private async toTabInfo(
    context: BrowsingContextInfo,
    timeoutMs: number
  ): Promise<BrowserTabInfo> {
    const contextId = String(context.context || '').trim();
    if (!contextId) {
      throw new Error('Invalid Firefox browsing context info');
    }
    const url =
      typeof context.url === 'string' && context.url.trim().length > 0
        ? context.url
        : await this.readContextUrl(contextId, timeoutMs);
    const title = await this.readContextTitle(contextId, timeoutMs).catch(() => undefined);
    return {
      id: contextId,
      url,
      title,
      active: contextId === this.deps.getCurrentActiveContextId(),
      parentId:
        typeof context.originalOpener === 'string' && context.originalOpener.trim().length > 0
          ? context.originalOpener
          : undefined,
    };
  }

  private async readContextTitle(contextId: string, timeoutMs: number): Promise<string> {
    const result = await this.deps.sendBiDiCommand<ScriptCommandResult>(
      'script.evaluate',
      {
        expression: 'document.title',
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      timeoutMs
    );
    return String(parseScriptResult<string>(result) || '');
  }

  private async readContextUrl(contextId: string, timeoutMs: number): Promise<string> {
    const result = await this.deps.sendBiDiCommand<ScriptCommandResult>(
      'script.evaluate',
      {
        expression: 'window.location.href',
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      timeoutMs
    );
    return String(parseScriptResult<string>(result) || '');
  }
}
