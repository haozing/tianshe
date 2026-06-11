import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeArtifact } from '../core/observability/types';
import { setObservationSink } from '../core/observability/observation-service';
import { WebContentsViewViewportDebugger } from './webcontentsview-viewport-debugger';

class MemorySink {
  artifacts: RuntimeArtifact[] = [];
  recordEvent(): void {}
  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

describe('WebContentsViewViewportDebugger', () => {
  afterEach(() => {
    setObservationSink(null);
    vi.useRealTimers();
  });

  it('records structured diagnostics for abnormal viewport state outside dev logs', async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    setObservationSink(sink);
    const viewInfo = {
      attachedTo: 1,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      metadata: { pluginId: 'plugin-a' },
      view: {
        getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 0, height: 0 }),
        webContents: {
          isDestroyed: vi.fn().mockReturnValue(false),
          executeJavaScript: vi.fn().mockResolvedValue({
            innerWidth: 0,
            innerHeight: 0,
            clientWidth: 0,
            clientHeight: 0,
            dpr: 1,
          }),
        },
      },
    };
    const debuggerInstance = new WebContentsViewViewportDebugger({
      pool: new Map([['view-1', viewInfo as any]]),
      windowManager: {
        getWindowById: vi.fn().mockReturnValue({
          isDestroyed: vi.fn().mockReturnValue(false),
          getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1024, height: 768 }),
          isMaximized: vi.fn().mockReturnValue(false),
          isFullScreen: vi.fn().mockReturnValue(false),
        }),
      } as any,
      getViewType: vi.fn().mockReturnValue('page'),
      getActivityBarWidth: vi.fn().mockReturnValue(64),
    });

    debuggerInstance.schedule('view-1', 'bounds-update');
    await vi.advanceTimersByTimeAsync(150);

    expect(sink.artifacts).toHaveLength(1);
    expect(sink.artifacts[0]).toMatchObject({
      type: 'error_context',
      component: 'webcontents-view',
      label: 'WebContentsView viewport diagnostics',
      pluginId: 'plugin-a',
      attrs: {
        issue: 'actual_bounds_zero',
        viewId: 'view-1',
      },
    });
  });
});
