import { decorateSnapshotElementsWithRefs } from '../../../../browser-automation/element-ref';
import { createInteractionNotReadyError } from './action-verification';
import { asNonEmptyString } from './target-resolution';
import type { BrowserInterface, ToolHandlerDependencies } from './types';

export type SnapshotCaptureOptions = {
  elementsFilter?: 'all' | 'interactive';
  maxElements?: number;
};

export type SnapshotCaptureResult = {
  snapshot: Awaited<ReturnType<BrowserInterface['snapshot']>>;
  elementsFilter: 'all' | 'interactive';
  originalElementCount: number;
  returnedElementCount: number;
  truncated: boolean;
  maxElements: number;
};

export async function captureSnapshotResult(
  browser: BrowserInterface,
  options: SnapshotCaptureOptions = {}
): Promise<SnapshotCaptureResult> {
  let snapshot = await browser.snapshot({
    elementsFilter: options.elementsFilter,
  });
  snapshot = {
    ...snapshot,
    elements: decorateSnapshotElementsWithRefs(snapshot.elements),
  };

  const elementsFilter = options.elementsFilter || 'interactive';
  const originalElementCount = snapshot.elements.length;
  const maxElements = options.maxElements !== undefined ? options.maxElements : 50;
  let truncated = false;
  if (maxElements > 0 && snapshot.elements.length > maxElements) {
    snapshot.elements = snapshot.elements.slice(0, maxElements);
    truncated = true;
  }

  return {
    snapshot,
    elementsFilter,
    originalElementCount,
    returnedElementCount: snapshot.elements.length,
    truncated,
    maxElements,
  };
}

function getSessionVisibilityLabel(
  deps: ToolHandlerDependencies
): 'visible' | 'hidden' | 'unknown' {
  if (deps.mcpSessionContext?.visible === true) {
    return 'visible';
  }
  if (deps.mcpSessionContext?.visible === false) {
    return 'hidden';
  }
  return 'unknown';
}

export async function collectInteractionHealth(
  browser: BrowserInterface,
  snapshot: Awaited<ReturnType<BrowserInterface['snapshot']>>,
  deps: ToolHandlerDependencies
): Promise<{
  interactionReady: boolean;
  viewportHealth: 'unknown' | 'ready' | 'warning' | 'broken';
  viewportHealthReason: string | null;
  sessionVisibility: 'visible' | 'hidden' | 'unknown';
  hostWindowId: string | null;
  offscreenDetected: boolean;
  diagnostics: Record<string, unknown>;
}> {
  let viewportWidth = 0;
  let viewportHeight = 0;
  try {
    const viewport = await browser.evaluate<{ width: number; height: number }>(`
      (function() {
        return {
          width: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
          height: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
        };
      })()
    `);
    viewportWidth = Number(viewport?.width || 0);
    viewportHeight = Number(viewport?.height || 0);
  } catch {
    // ignore
  }

  const elementsWithBounds = snapshot.elements.filter((element) => element.bounds);
  const outOfViewportCount = snapshot.elements.filter((element) => element.inViewport === false).length;
  const negativeBoundsCount = elementsWithBounds.filter((element) => {
    const bounds = element.bounds!;
    return bounds.x < 0 || bounds.y < 0;
  }).length;
  const overflowBoundsCount = elementsWithBounds.filter((element) => {
    const bounds = element.bounds!;
    return (
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      (bounds.x + bounds.width > viewportWidth + 1 || bounds.y + bounds.height > viewportHeight + 1)
    );
  }).length;

  const sessionVisibility = getSessionVisibilityLabel(deps);
  const hostWindowId = asNonEmptyString(deps.mcpSessionContext?.hostWindowId) || null;
  const sessionViewportHealth = deps.mcpSessionContext?.viewportHealth || ('unknown' as const);
  const sessionViewportHealthReason =
    asNonEmptyString(deps.mcpSessionContext?.viewportHealthReason) || null;
  const sessionInteractionReady = deps.mcpSessionContext?.interactionReady === true;
  const sessionOffscreenDetected = deps.mcpSessionContext?.offscreenDetected === true;

  const offscreenDetected =
    sessionOffscreenDetected ||
    negativeBoundsCount > 0 ||
    (elementsWithBounds.length > 0 &&
      overflowBoundsCount >= Math.max(1, Math.ceil(elementsWithBounds.length / 2)));

  let viewportHealth: 'unknown' | 'ready' | 'warning' | 'broken' = sessionViewportHealth;
  let viewportHealthReason = sessionViewportHealthReason;

  if (viewportWidth <= 0 || viewportHeight <= 0) {
    viewportHealth = 'broken';
    viewportHealthReason = viewportHealthReason || 'page viewport size is zero';
  } else if (offscreenDetected) {
    viewportHealth = sessionViewportHealth === 'unknown' ? 'broken' : sessionViewportHealth;
    viewportHealthReason =
      viewportHealthReason || 'interactive element bounds extend outside the current viewport';
  } else if (elementsWithBounds.length > 0 && outOfViewportCount === elementsWithBounds.length) {
    viewportHealth = 'warning';
    viewportHealthReason = viewportHealthReason || 'all returned elements are currently outside the viewport';
  } else if (viewportHealth === 'unknown') {
    viewportHealth = 'ready';
    viewportHealthReason = 'page viewport and returned element bounds look healthy';
  }

  const interactionReady =
    sessionInteractionReady ||
    (viewportHealth === 'ready' && viewportWidth > 0 && viewportHeight > 0);

  return {
    interactionReady,
    viewportHealth,
    viewportHealthReason,
    sessionVisibility,
    hostWindowId,
    offscreenDetected,
    diagnostics: {
      viewportWidth,
      viewportHeight,
      totalElements: snapshot.elements.length,
      elementsWithBounds: elementsWithBounds.length,
      outOfViewportCount,
      negativeBoundsCount,
      overflowBoundsCount,
    },
  };
}

export const normalizeObserveWaitUntil = (
  value: 'load' | 'domcontentloaded' | 'networkidle' | undefined
): 'load' | 'domcontentloaded' | 'networkidle0' | undefined => {
  if (value === 'networkidle') {
    return 'networkidle0';
  }
  return value;
};

function isDirectManagedViewportReady(
  viewportHealth: 'unknown' | 'ready' | 'warning' | 'broken' | undefined,
  viewportHealthReason: string | null | undefined,
  interactionReady: boolean | undefined
): boolean {
  if (interactionReady !== true) {
    return false;
  }

  if (viewportHealth === 'ready') {
    return true;
  }

  if (viewportHealth !== 'unknown') {
    return false;
  }

  const reason = asNonEmptyString(viewportHealthReason)?.toLowerCase();
  return (
    reason === 'browser implementation manages visibility directly' ||
    reason === 'browser does not expose a managed view; interaction health is implementation-defined'
  );
}

export async function ensureInteractionReadyForAction(
  deps: ToolHandlerDependencies,
  context: Record<string, unknown> = {}
): Promise<void> {
  const sessionContext = deps.mcpSessionContext;
  const likelyUnready =
    sessionContext &&
    !isDirectManagedViewportReady(
      sessionContext.viewportHealth,
      sessionContext.viewportHealthReason,
      sessionContext.interactionReady
    );

  if (!likelyUnready) {
    return;
  }

  const gateway = deps.mcpSessionGateway;
  if (!gateway?.ensureCurrentSessionInteractionReady) {
    throw createInteractionNotReadyError({
      ...context,
      sessionId: sessionContext.sessionId,
      visible: sessionContext.visible,
      hostWindowId: sessionContext.hostWindowId,
      viewportHealth: sessionContext.viewportHealth,
      viewportHealthReason: sessionContext.viewportHealthReason,
      offscreenDetected: sessionContext.offscreenDetected,
    });
  }

  const repaired = await gateway.ensureCurrentSessionInteractionReady();
  if (deps.mcpSessionContext) {
    deps.mcpSessionContext.sessionId = repaired.sessionId;
    deps.mcpSessionContext.visible = repaired.visible;
    deps.mcpSessionContext.hostWindowId = repaired.hostWindowId;
    deps.mcpSessionContext.viewportHealth = repaired.viewportHealth;
    deps.mcpSessionContext.viewportHealthReason = repaired.viewportHealthReason;
    deps.mcpSessionContext.interactionReady = repaired.interactionReady;
    deps.mcpSessionContext.offscreenDetected = repaired.offscreenDetected;
  }

  if (
    !isDirectManagedViewportReady(
      repaired.viewportHealth,
      repaired.viewportHealthReason,
      repaired.interactionReady
    )
  ) {
    throw createInteractionNotReadyError({
      ...context,
      sessionId: repaired.sessionId,
      visible: repaired.visible,
      hostWindowId: repaired.hostWindowId,
      viewportHealth: repaired.viewportHealth,
      viewportHealthReason: repaired.viewportHealthReason,
      offscreenDetected: repaired.offscreenDetected,
      repaired: repaired.repaired,
      browserAcquired: repaired.browserAcquired,
    });
  }
}
