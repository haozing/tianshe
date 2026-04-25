/**
 * 自定义页面查看器组件
 * 用于在iframe中渲染插件的自定义页面
 */

import React, { useRef, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { CustomPageInfo } from '../../../../types/js-plugin';
import { useEventSubscription } from '../../hooks/useElectronAPI';
import { pluginFacade } from '../../services/datasets/pluginFacade';
import { pluginEvents } from '../../services/datasets/pluginEvents';

interface CustomPageViewerProps {
  page: CustomPageInfo;
  datasetId?: string;
}

export function CustomPageViewer({ page, datasetId }: CustomPageViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0); // 热重载触发器

  useEventSubscription(pluginEvents.subscribeToPluginReloaded, ({ pluginId, success }) => {
    if (pluginId === page.plugin_id && success) {
      setReloadKey((prev) => prev + 1);
    }
  });

  useEffect(() => {
    // 监听页面消息
    const handleMessage = async (event: MessageEvent) => {
      // 只处理来自iframe的消息
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      const data = event.data as { type?: string; messageId?: number } & Record<string, unknown>;
      if (!data?.type) {
        return;
      }

      if (data.type === 'plugin-page-ready') {
        setIsReady(true);
        setIsLoading(false);
      } else if (data.type === 'plugin-page-message') {
        try {
          // 转发消息到后端处理
          const result = await pluginFacade.sendPageMessage(data);

          // 回复消息到iframe
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                messageId: data.messageId,
                result: result.result,
                error: result.error,
              },
              '*'
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error('[CustomPageViewer] Failed to handle page message:', err);

          // 发送错误响应
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                messageId: data.messageId,
                error: message,
              },
              '*'
            );
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [page.page_id]);

  useEffect(() => {
    // 加载页面内容
    let isComponentMounted = true;

    async function loadPageContent() {
      setIsLoading(true);
      setError(null);
      setIsReady(false);

      try {
        const result = await pluginFacade.renderCustomPage(page.plugin_id, page.page_id, datasetId);

        if (!result.success || !result.html) {
          throw new Error(result.error || 'Failed to render page');
        }

        // 检查组件是否仍然挂载
        if (!isComponentMounted) return;

        if (iframeRef.current) {
          const doc = iframeRef.current.contentDocument;
          if (doc) {
            doc.open();
            doc.write(result.html);
            doc.close();
          }
        }
      } catch (err) {
        console.error('[CustomPageViewer] Failed to load page:', err);
        if (isComponentMounted) {
          const message = err instanceof Error ? err.message : 'Failed to load page';
          setError(message);
          setIsLoading(false);
        }
      }
    }

    loadPageContent();

    return () => {
      isComponentMounted = false;
    };
  }, [page.plugin_id, page.page_id, datasetId, reloadKey]);

  return (
    <div className="shell-content-muted relative flex h-full w-full flex-col">
      {/* 加载状态 */}
      {isLoading && !error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-8">
          <div className="shell-soft-card flex max-w-sm items-start gap-4 px-6 py-5">
            <div className="shell-field-chip shell-field-chip--ghost flex h-11 w-11 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">正在加载插件页面</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                正在准备 {page.title} 的渲染环境，请稍候。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-8">
          <div className="shell-soft-card flex max-w-md items-start gap-4 border-red-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(255,246,246,0.95))] px-6 py-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">插件页面加载失败</p>
              <p className="mt-1 break-words text-sm leading-6 text-slate-600">{error}</p>
              <button
                onClick={() => setReloadKey((prev) => prev + 1)}
                className="shell-field-control mt-4 inline-flex h-9 items-center gap-2 px-3.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
              >
                <RefreshCw className="h-4 w-4" />
                <span>重新加载</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* iframe容器 */}
      <iframe
        ref={iframeRef}
        className={`w-full h-full border-none ${!isReady ? 'invisible' : ''}`}
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={page.title}
      />
    </div>
  );
}
