/**
 * Electron API Hook
 * 封装对 window.electronAPI 的访问
 */

import { useEffect, useRef } from 'react';
import type { ElectronAPI } from '../../../types/electron';

type Unsubscribe = (() => void) | void;

/**
 * 获取 Electron API
 */
export function useElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

/**
 * 统一事件订阅生命周期，避免组件层重复处理 callback ref 和清理逻辑
 */
export function useEventSubscription<T>(
  subscribe: (callback: (payload: T) => void) => Unsubscribe,
  callback: (payload: T) => void
) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    const unsubscribe = subscribe((payload) => {
      savedCallback.current(payload);
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [subscribe]);
}

/**
 * 监听下载事件
 */
export function useDownloadEvents(
  channel:
    | 'download:started'
    | 'download:progress'
    | 'download:completed'
    | 'download:cancelled'
    | 'download:interrupted',
  callback: (info: any) => void
) {
  const api = useElectronAPI();

  useEventSubscription(
    (listener) => api.onDownloadEvent(channel, listener),
    callback
  );
}
