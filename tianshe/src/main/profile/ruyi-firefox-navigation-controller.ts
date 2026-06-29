import { parseScriptResult, serializeLocalValue } from './ruyi-firefox-client-utils';
import type {
  DispatchEvaluateWithArgsParams,
  DispatchGotoParams,
  ScriptCommandResult,
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

export interface RuyiFirefoxNavigationControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  withRecoveredActiveContext: WithRecoveredActiveContext;
}

export class RuyiFirefoxNavigationController {
  constructor(private readonly deps: RuyiFirefoxNavigationControllerDeps) {}

  async goto(params: DispatchGotoParams, timeoutMs: number): Promise<{ url: string }> {
    const url = String(params?.url || '').trim();
    if (!url) {
      throw new Error('url is required');
    }

    const waitUntil = String(params?.waitUntil || 'load').toLowerCase();
    const wait =
      waitUntil === 'domcontentloaded'
        ? 'interactive'
        : waitUntil === 'networkidle0' || waitUntil === 'networkidle2'
          ? 'complete'
          : 'complete';
    const effectiveTimeoutMs = Math.max(1000, params?.timeout ?? timeoutMs);

    await this.deps.withRecoveredActiveContext(effectiveTimeoutMs, async (context) => {
      await this.deps.sendBiDiCommand(
        'browsingContext.navigate',
        {
          context,
          url,
          wait,
        },
        effectiveTimeoutMs
      );
    });
    return { url };
  }

  async traverseHistory(delta: number, timeoutMs: number): Promise<void> {
    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.deps.sendBiDiCommand(
        'browsingContext.traverseHistory',
        {
          context,
          delta,
        },
        timeoutMs
      );
    });
  }

  async reload(timeoutMs: number): Promise<void> {
    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.deps.sendBiDiCommand(
        'browsingContext.reload',
        {
          context,
          wait: 'complete',
        },
        timeoutMs
      );
    });
  }

  async evaluateExpression<TResult>(script: string, timeoutMs: number): Promise<TResult> {
    const result = await this.deps.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.deps.sendBiDiCommand<ScriptCommandResult>(
        'script.evaluate',
        {
          expression: script,
          target: {
            context,
          },
          awaitPromise: true,
          resultOwnership: 'root',
        },
        timeoutMs
      )
    );

    return parseScriptResult<TResult>(result);
  }

  async evaluateWithArgs<TResult>(
    params: DispatchEvaluateWithArgsParams,
    timeoutMs: number
  ): Promise<TResult> {
    const functionSource = String(params?.functionSource || '').trim();
    if (!functionSource) {
      throw new Error('functionSource is required');
    }

    const result = await this.deps.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.deps.sendBiDiCommand<ScriptCommandResult>(
        'script.callFunction',
        {
          functionDeclaration: functionSource,
          target: {
            context,
          },
          arguments: Array.isArray(params?.args)
            ? params.args.map((item) => serializeLocalValue(item))
            : [],
          awaitPromise: true,
          resultOwnership: 'root',
        },
        timeoutMs
      )
    );

    return parseScriptResult<TResult>(result);
  }
}
