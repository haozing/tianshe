import type { Rectangle } from 'electron';
import { isDevelopmentMode } from '../constants/runtime-config';
import { createLogger } from '../core/logger';
import { createChildTraceContext } from '../core/observability/observation-context';
import { observationService } from '../core/observability/observation-service';
import type { WindowManager } from './window-manager';
import type { WebContentsViewInfo } from './webcontentsview-manager';

const logger = createLogger('WebContentsViewViewportDebugger');

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface WebContentsViewViewportDebuggerDeps {
  pool: Map<string, WebContentsViewInfo>;
  windowManager: WindowManager;
  getViewType(viewId: string): 'page' | 'temp' | 'pool' | 'unknown';
  getActivityBarWidth(): number;
}

export class WebContentsViewViewportDebugger {
  private viewportDebugTimers = new Map<string, NodeJS.Timeout>();
  private lastViewportDebugKey = new Map<string, string>();

  constructor(private deps: WebContentsViewViewportDebuggerDeps) {}

  schedule(viewId: string, reason: string): void {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo?.attachedTo || !viewInfo.bounds) return;

    const viewType = this.deps.getViewType(viewId);
    if (viewType !== 'page' && viewType !== 'temp') return;

    const prev = this.viewportDebugTimers.get(viewId);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
      this.viewportDebugTimers.delete(viewId);
      void this.log(viewId, reason);
    }, 150);

    this.viewportDebugTimers.set(viewId, timer);
  }

  clear(viewId: string): void {
    const debugTimer = this.viewportDebugTimers.get(viewId);
    if (debugTimer) clearTimeout(debugTimer);
    this.viewportDebugTimers.delete(viewId);
    this.lastViewportDebugKey.delete(viewId);
  }

  private async log(viewId: string, reason: string): Promise<void> {
    const viewInfo = this.deps.pool.get(viewId);
    if (!viewInfo?.attachedTo || !viewInfo.bounds) return;

    const view = viewInfo.view;
    if (view.webContents.isDestroyed()) return;

    const window = this.deps.windowManager.getWindowById(viewInfo.attachedTo);
    const windowState =
      window && !window.isDestroyed()
        ? {
            contentBounds: window.getContentBounds(),
            isMaximized: window.isMaximized(),
            isFullScreen: window.isFullScreen(),
          }
        : undefined;

    let actualBounds: Rectangle | undefined;
    try {
      actualBounds = view.getBounds();
    } catch {
      actualBounds = undefined;
    }

    let viewport:
      | {
          innerWidth: number;
          innerHeight: number;
          clientWidth: number | null;
          clientHeight: number | null;
          dpr: number;
        }
      | { error: string }
      | undefined;

    try {
      viewport = (await view.webContents.executeJavaScript(
        `(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement?.clientWidth ?? null, clientHeight: document.documentElement?.clientHeight ?? null, dpr: window.devicePixelRatio }))()`,
        true
      )) as typeof viewport;
    } catch (error) {
      viewport = { error: getErrorMessage(error) };
    }

    const desired = viewInfo.bounds;
    const key = [
      desired.x,
      desired.y,
      desired.width,
      desired.height,
      actualBounds?.x ?? 'x',
      actualBounds?.y ?? 'y',
      actualBounds?.width ?? 'w',
      actualBounds?.height ?? 'h',
      viewport && 'innerWidth' in viewport ? viewport.innerWidth : 'iw',
      viewport && 'innerHeight' in viewport ? viewport.innerHeight : 'ih',
      windowState?.contentBounds.width ?? 'cw',
      windowState?.contentBounds.height ?? 'ch',
      windowState?.isMaximized ? 1 : 0,
      windowState?.isFullScreen ? 1 : 0,
      this.deps.getActivityBarWidth(),
    ].join(',');

    if (this.lastViewportDebugKey.get(viewId) === key) return;
    this.lastViewportDebugKey.set(viewId, key);

    const diagnostics = {
      viewId,
      reason,
      pluginId: viewInfo.metadata?.pluginId,
      viewType: this.deps.getViewType(viewId),
      activityBarWidth: this.deps.getActivityBarWidth(),
      desiredBounds: viewInfo.bounds,
      actualBounds,
      viewport,
      window: windowState,
    };

    if (isDevelopmentMode()) {
      logger.debug('Viewport diagnostics', diagnostics);
    }

    const issue = this.detectViewportIssue(desired, actualBounds, viewport);
    if (issue) {
      await observationService.attachArtifact({
        context: createChildTraceContext({
          source: 'webcontents-view',
          pluginId: viewInfo.metadata?.pluginId,
        }),
        component: 'webcontents-view',
        type: 'error_context',
        label: 'WebContentsView viewport diagnostics',
        attrs: {
          viewId,
          issue,
          reason,
        },
        data: {
          issue,
          ...diagnostics,
        },
      });
    }
  }

  private detectViewportIssue(
    desired: Rectangle,
    actualBounds:
      | Rectangle
      | undefined,
    viewport:
      | {
          innerWidth: number;
          innerHeight: number;
          clientWidth: number | null;
          clientHeight: number | null;
          dpr: number;
        }
      | { error: string }
      | undefined
  ): string | null {
    if (!actualBounds) {
      return 'actual_bounds_unavailable';
    }
    if (actualBounds.width <= 0 || actualBounds.height <= 0) {
      return 'actual_bounds_zero';
    }
    if (
      Math.abs(actualBounds.width - desired.width) > 1 ||
      Math.abs(actualBounds.height - desired.height) > 1
    ) {
      return 'bounds_mismatch';
    }
    if (!viewport) {
      return null;
    }
    if ('error' in viewport) {
      return 'viewport_probe_failed';
    }
    if (viewport.innerWidth <= 0 || viewport.innerHeight <= 0) {
      return 'dom_viewport_zero';
    }
    return null;
  }
}
