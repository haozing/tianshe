import {
  buildNativeClickActionSources,
  buildNativeDragActionSources,
  buildNativeKeyPressActionSources,
  buildNativeMoveActionSources,
  buildNativeScrollActionSources,
  buildNativeTypeActionSources,
  buildTouchDragActionSources,
  buildTouchLongPressActionSources,
  buildTouchTapActionSources,
} from './ruyi-firefox-input-actions';
import type {
  DispatchNativeClickParams,
  DispatchNativeDragParams,
  DispatchNativeKeyPressParams,
  DispatchNativeMoveParams,
  DispatchNativeScrollParams,
  DispatchNativeTypeParams,
  DispatchTouchDragParams,
  DispatchTouchLongPressParams,
  DispatchTouchTapParams,
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

export interface RuyiFirefoxInputControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  withRecoveredActiveContext: WithRecoveredActiveContext;
}

export class RuyiFirefoxInputController {
  constructor(private readonly deps: RuyiFirefoxInputControllerDeps) {}

  async nativeClick(params: DispatchNativeClickParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeClickActionSources(params), timeoutMs);
  }

  async nativeMove(params: DispatchNativeMoveParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeMoveActionSources(params), timeoutMs);
  }

  async nativeDrag(params: DispatchNativeDragParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeDragActionSources(params), timeoutMs);
  }

  async nativeType(params: DispatchNativeTypeParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeTypeActionSources(params), timeoutMs);
  }

  async nativeKeyPress(params: DispatchNativeKeyPressParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeKeyPressActionSources(params), timeoutMs);
  }

  async nativeScroll(params: DispatchNativeScrollParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeScrollActionSources(params), timeoutMs);
  }

  async touchTap(params: DispatchTouchTapParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildTouchTapActionSources(params), timeoutMs);
  }

  async touchLongPress(params: DispatchTouchLongPressParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildTouchLongPressActionSources(params), timeoutMs);
  }

  async touchDrag(params: DispatchTouchDragParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildTouchDragActionSources(params), timeoutMs);
  }

  private async performInputActions(
    actions: Array<Record<string, unknown>>,
    timeoutMs: number
  ): Promise<void> {
    await this.deps.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.deps.sendBiDiCommand(
        'input.performActions',
        {
          context,
          actions,
        },
        timeoutMs
      );
    });
  }
}
