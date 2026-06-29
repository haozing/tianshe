import { getActiveContextTrackerInstallerFunction } from './ruyi-firefox-client-page-scripts';
import type { BrowsingContextInfo } from './ruyi-firefox-client.types';

export const ACTIVE_CONTEXT_TRACKER_CHANNEL = '__airpa_ruyi_active_context__';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

export interface RuyiFirefoxActiveContextTrackerDeps {
  sendBiDiCommand: SendBiDiCommand;
}

export class RuyiFirefoxActiveContextTracker {
  private preloadScriptId: string | null = null;

  constructor(private readonly deps: RuyiFirefoxActiveContextTrackerDeps) {}

  async install(timeoutMs: number): Promise<void> {
    if (this.preloadScriptId) {
      return;
    }

    const preload = await this.deps.sendBiDiCommand<{ script?: string }>(
      'script.addPreloadScript',
      {
        functionDeclaration: getActiveContextTrackerInstallerFunction(),
        arguments: [createBiDiChannelArgument(ACTIVE_CONTEXT_TRACKER_CHANNEL)],
      },
      timeoutMs
    );
    this.preloadScriptId =
      typeof preload.script === 'string' && preload.script.trim() ? preload.script.trim() : null;

    await this.installIntoExistingContexts(timeoutMs);
  }

  async clear(timeoutMs: number): Promise<void> {
    if (!this.preloadScriptId) {
      return;
    }
    await this.deps
      .sendBiDiCommand('script.removePreloadScript', { script: this.preloadScriptId }, timeoutMs)
      .catch(() => undefined);
    this.preloadScriptId = null;
  }

  private async installIntoExistingContexts(timeoutMs: number): Promise<void> {
    const tree = await this.deps.sendBiDiCommand<{ contexts?: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 },
      timeoutMs
    );
    const contextIds = Array.isArray(tree.contexts)
      ? tree.contexts
          .map((context) => String(context.context || '').trim())
          .filter((contextId) => contextId.length > 0)
      : [];

    await Promise.all(
      contextIds.map((contextId) =>
        this.deps
          .sendBiDiCommand(
            'script.callFunction',
            {
              functionDeclaration: getActiveContextTrackerInstallerFunction(),
              target: { context: contextId },
              awaitPromise: false,
              resultOwnership: 'none',
              arguments: [createBiDiChannelArgument(ACTIVE_CONTEXT_TRACKER_CHANNEL)],
            },
            timeoutMs
          )
          .catch(() => undefined)
      )
    );
  }
}

function createBiDiChannelArgument(channel: string): Record<string, unknown> {
  return {
    type: 'channel',
    value: {
      channel,
    },
  };
}
