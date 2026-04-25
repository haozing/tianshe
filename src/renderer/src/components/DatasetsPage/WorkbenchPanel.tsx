import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  CLOUD_AUTH_COOKIE_NAME,
  CLOUD_WORKBENCH_PARTITION,
  CLOUD_WORKBENCH_URL,
  CLOUD_WORKBENCH_VIEW_ID,
} from '../../../../constants/cloud';
import { useCloudAuthStore } from '../../stores/cloudAuthStore';
import { useUIStore } from '../../stores/uiStore';

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

export function WorkbenchPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRegisteredRef = useRef(false);
  const attachedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastAppliedAuthRevisionRef = useRef<number>(-1);

  const authState = useCloudAuthStore((state) => state.authState);
  const cloudSession = useCloudAuthStore((state) => state.session);
  const authError = useCloudAuthStore((state) => state.error);
  const isCloudAuthDialogOpen = useUIStore((state) => state.isCloudAuthDialogOpen);

  const [viewReady, setViewReady] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  const syncBounds = useCallback(async () => {
    const target = containerRef.current;
    if (!target || authState !== 'ready' || isCloudAuthDialogOpen) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width <= 1 || height <= 1) {
      return;
    }

    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    };

    if (!attachedRef.current) {
      const attachResult = await window.electronAPI.view.attach({
        viewId: CLOUD_WORKBENCH_VIEW_ID,
        windowId: 'main',
        bounds,
      });
      if (!attachResult.success) {
        throw new Error(attachResult.error || '附加工作台失败');
      }
      attachedRef.current = true;
      return;
    }

    const updateResult = await window.electronAPI.view.updateBounds({
      viewId: CLOUD_WORKBENCH_VIEW_ID,
      bounds,
    });
    if (!updateResult.success) {
      throw new Error(updateResult.error || '更新工作台布局失败');
    }
  }, [authState, isCloudAuthDialogOpen]);

  const scheduleSyncBounds = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      void syncBounds().catch((error) => {
        setViewError(getErrorMessage(error, '同步工作台布局失败'));
      });
    });
  }, [syncBounds]);

  const ensureWorkbenchReady = useCallback(async () => {
    if (authState !== 'ready') {
      return;
    }

    if (!viewRegisteredRef.current) {
      const createResult = await window.electronAPI.view.create({
        viewId: CLOUD_WORKBENCH_VIEW_ID,
        partition: CLOUD_WORKBENCH_PARTITION,
        url: CLOUD_WORKBENCH_URL,
        metadata: {
          label: '工作台',
          displayMode: 'fullscreen',
          source: 'pool',
        },
      });
      if (!createResult.success) {
        throw new Error(createResult.error || '注册工作台失败');
      }
      viewRegisteredRef.current = true;
    }

    const activateResult = await window.electronAPI.view.activate(CLOUD_WORKBENCH_VIEW_ID);
    if (!activateResult.success) {
      throw new Error(activateResult.error || '激活工作台失败');
    }

    const syncAuthResult = await window.electronAPI.view.syncCloudAuth({
      viewId: CLOUD_WORKBENCH_VIEW_ID,
      url: CLOUD_WORKBENCH_URL,
      cookieName: CLOUD_AUTH_COOKIE_NAME,
    });
    if (!syncAuthResult.success) {
      throw new Error(syncAuthResult.error || syncAuthResult.reason || '同步工作台登录态失败');
    }

    const navigateResult = await window.electronAPI.view.navigate({
      viewId: CLOUD_WORKBENCH_VIEW_ID,
      url: CLOUD_WORKBENCH_URL,
    });
    if (!navigateResult.success) {
      throw new Error(navigateResult.error || '打开工作台失败');
    }

    lastAppliedAuthRevisionRef.current = cloudSession.authRevision;
  }, [authState, cloudSession.authRevision]);

  useEffect(() => {
    if (authState !== 'ready') {
      setViewReady(false);
      setViewError(null);
      lastAppliedAuthRevisionRef.current = -1;
      attachedRef.current = false;
      void window.electronAPI.view.detach(CLOUD_WORKBENCH_VIEW_ID).catch(() => undefined);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setViewError(null);
        setViewReady(false);
        await ensureWorkbenchReady();
        if (cancelled) return;
        if (!isCloudAuthDialogOpen) {
          await syncBounds();
        }
        if (cancelled) return;
        setViewReady(true);
      } catch (error) {
        if (!cancelled) {
          setViewError(getErrorMessage(error, '工作台加载失败'));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authState, cloudSession.authRevision, ensureWorkbenchReady, isCloudAuthDialogOpen, syncBounds]);

  useEffect(() => {
    if (authState !== 'ready' || !viewReady) {
      return;
    }

    const target = containerRef.current;
    if (!target) {
      return;
    }

    if (isCloudAuthDialogOpen) {
      attachedRef.current = false;
      void window.electronAPI.view.detach(CLOUD_WORKBENCH_VIEW_ID).catch(() => undefined);
      return;
    }

    scheduleSyncBounds();

    const resizeObserver = new ResizeObserver(() => {
      scheduleSyncBounds();
    });
    resizeObserver.observe(target);

    window.addEventListener('resize', scheduleSyncBounds);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleSyncBounds);
    };
  }, [authState, isCloudAuthDialogOpen, scheduleSyncBounds, viewReady]);

  useEffect(() => {
    if (
      authState !== 'ready' ||
      !viewReady ||
      isCloudAuthDialogOpen ||
      lastAppliedAuthRevisionRef.current === cloudSession.authRevision
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setViewError(null);
        await ensureWorkbenchReady();
        if (cancelled) return;
        scheduleSyncBounds();
      } catch (error) {
        if (!cancelled) {
          setViewError(getErrorMessage(error, '同步工作台登录态失败'));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authState,
    cloudSession.authRevision,
    ensureWorkbenchReady,
    isCloudAuthDialogOpen,
    scheduleSyncBounds,
    viewReady,
  ]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      attachedRef.current = false;
      void window.electronAPI.view.detach(CLOUD_WORKBENCH_VIEW_ID).catch(() => undefined);
    };
  }, []);

  const overlay = (() => {
    if (viewError) {
      return {
        title: '工作台加载失败',
        description: viewError,
        loading: false,
      };
    }
    if (authState === 'logged_out') {
      return {
        title: '请先登录云端账户',
        description: '工作台依赖固定云端会话。登录恢复完成后会自动加载。',
        loading: false,
      };
    }
    if (authState === 'restoring' && authError) {
      return {
        title: '云端会话恢复失败',
        description: authError,
        loading: false,
      };
    }
    if (authState === 'restoring' || !viewReady) {
      return {
        title: '正在打开远程工作台',
        description: '正在恢复云端会话和工作台登录态...',
        loading: true,
      };
    }
    return null;
  })();

  return (
    <div className="relative min-h-0 flex-1 bg-slate-50">
      <div ref={containerRef} className="h-full w-full" />

      {overlay ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-sm">
            {overlay.loading ? (
              <>
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />
                <p className="mt-3 text-sm text-slate-600">{overlay.title}</p>
                <p className="mt-2 max-w-md text-xs leading-5 text-slate-500">{overlay.description}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-700">{overlay.title}</p>
                <p className="mt-2 max-w-md text-xs leading-5 text-slate-500">{overlay.description}</p>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
