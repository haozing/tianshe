import type { BrowserToolName } from '../tool-definitions';
import {
  parseClickAtParams,
  parseDragToParams,
  parseHoverAtParams,
  parseNativeKeyParams,
  parseNativeTypeParams,
  parseScrollAtParams,
} from '../tool-contracts';
import {
  checkBrowserDependency,
  formatBrowserFeatureNotAvailable,
  getBrowserCoordinateFeatures,
  withBrowserAction,
} from './shared';
import { createOperationFailedError } from './mcp-surface-errors';
import type { ToolHandler } from './types';
import type { ToolCallResult, ToolHandlerDependencies } from './types';
import { createErrorResult } from './utils';

export async function handleBrowserClickAt(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseClickAtParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('normalized coordinate clicks');
  }

  try {
    await browser.initializeCoordinateSystem();
    const viewportPoint = browser.normalizedToViewport({
      x: params.x,
      y: params.y,
      space: 'normalized',
    });
    await browser.native.click(Math.round(viewportPoint.x), Math.round(viewportPoint.y), {
      button: params.button,
      clickCount: params.clickCount as 1 | 2 | 3 | undefined,
    });

    return withBrowserAction('browser_click_at', {
      summary: `Clicked normalized coordinates (${params.x}, ${params.y}).`,
      data: {
        x: params.x,
        y: params.y,
        button: params.button || 'left',
        clickCount: params.clickCount ?? 1,
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Normalized click', error));
  }
}

export async function handleBrowserScrollAt(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseScrollAtParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('normalized coordinate scrolling');
  }

  try {
    if (params.smooth) {
      const steps = 5;
      const deltaPerStep = params.deltaY / steps;
      for (let i = 0; i < steps; i += 1) {
        await browser.scrollAtNormalized(
          { x: params.x, y: params.y, space: 'normalized' },
          params.deltaX || 0,
          deltaPerStep
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } else {
      await browser.scrollAtNormalized(
        { x: params.x, y: params.y, space: 'normalized' },
        params.deltaX || 0,
        params.deltaY
      );
    }

    return withBrowserAction('browser_scroll_at', {
      summary: `Scrolled at normalized coordinates (${params.x}, ${params.y}).`,
      data: {
        x: params.x,
        y: params.y,
        deltaX: params.deltaX || 0,
        deltaY: params.deltaY,
        smooth: params.smooth === true,
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Normalized scroll', error));
  }
}

export async function handleBrowserDragTo(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseDragToParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('normalized coordinate drag');
  }

  try {
    await browser.dragNormalized(
      { x: params.fromX, y: params.fromY, space: 'normalized' },
      { x: params.toX, y: params.toY, space: 'normalized' },
      { steps: params.steps }
    );

    return withBrowserAction('browser_drag_to', {
      summary: `Dragged from (${params.fromX}, ${params.fromY}) to (${params.toX}, ${params.toY}).`,
      data: {
        fromX: params.fromX,
        fromY: params.fromY,
        toX: params.toX,
        toY: params.toY,
        steps: params.steps ?? 10,
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Normalized drag', error));
  }
}

export async function handleBrowserHoverAt(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseHoverAtParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('normalized coordinate hover');
  }

  try {
    await browser.moveToNormalized({ x: params.x, y: params.y, space: 'normalized' });
    return withBrowserAction('browser_hover_at', {
      summary: `Hovered at normalized coordinates (${params.x}, ${params.y}).`,
      data: {
        x: params.x,
        y: params.y,
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Normalized hover', error));
  }
}

export async function handleBrowserNativeType(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseNativeTypeParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('native keyboard typing');
  }

  try {
    await browser.native.type(params.text, { delay: params.delay });
    return withBrowserAction('browser_native_type', {
      summary: `Typed ${params.text.length} character(s) with native keyboard input.`,
      data: {
        textLength: params.text.length,
        delay: params.delay ?? 50,
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Native typing', error));
  }
}

export async function handleBrowserNativeKey(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseNativeKeyParams(args);

  const browser = getBrowserCoordinateFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('native key press');
  }

  try {
    await browser.native.keyPress(params.key, params.modifiers);
    const keyDesc = params.modifiers?.length
      ? `${params.modifiers.join('+')}+${params.key}`
      : params.key;
    return withBrowserAction('browser_native_key', {
      summary: `Pressed ${keyDesc}.`,
      data: {
        key: params.key,
        modifiers: params.modifiers || [],
      },
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Native key press', error));
  }
}

export const coordinateHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_click_at: handleBrowserClickAt,
  browser_scroll_at: handleBrowserScrollAt,
  browser_drag_to: handleBrowserDragTo,
  browser_hover_at: handleBrowserHoverAt,
  browser_native_type: handleBrowserNativeType,
  browser_native_key: handleBrowserNativeKey,
};
