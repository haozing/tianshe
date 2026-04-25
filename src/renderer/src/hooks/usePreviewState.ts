/**
 * usePreviewState Hook
 * 统一管理预览状态、防抖逻辑和错误处理
 * 解决Panel组件中重复的预览状态管理逻辑
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface UsePreviewStateOptions {
  /**
   * 防抖延迟时间（毫秒）
   * 默认: 500
   */
  debounceMs?: number;

  /**
   * 是否自动触发预览
   * 如果为false，需要手动调用 triggerPreview()
   * 默认: true
   */
  autoTrigger?: boolean;
}

export interface UsePreviewStateResult<T> {
  /**
   * 预览数据
   */
  data: T | null;

  /**
   * 是否正在加载
   */
  loading: boolean;

  /**
   * 错误信息
   */
  error: string | null;

  /**
   * 手动设置预览数据
   */
  setData: (data: T | null) => void;

  /**
   * 手动设置错误
   */
  setError: (error: string | null) => void;

  /**
   * 清空预览状态
   */
  clearPreview: () => void;

  /**
   * 触发预览（带防抖）
   */
  triggerPreview: () => void;
}

/**
 * 自定义Hook: 管理预览状态和防抖逻辑
 *
 * @param fetchFn - 获取预览数据的异步函数
 * @param dependencies - 依赖项数组，变化时触发预览
 * @param options - 配置选项
 * @returns 预览状态和控制方法
 *
 * @example
 * ```tsx
 * const preview = usePreviewState(
 *   async () => {
 *     const result = await api.previewFilter(config);
 *     return result.data;
 *   },
 *   [config], // 当config变化时自动触发
 *   { debounceMs: 500 }
 * );
 *
 * // 使用
 * {preview.loading && <LoadingSpinner />}
 * {preview.error && <ErrorMessage error={preview.error} />}
 * {preview.data && <PreviewTable data={preview.data} />}
 * ```
 */
export function usePreviewState<T>(
  fetchFn: () => Promise<T>,
  dependencies: any[] = [],
  options: UsePreviewStateOptions = {}
): UsePreviewStateResult<T> {
  const { debounceMs = 500, autoTrigger = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  // 清除定时器
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 执行预览
  const executePreview = useCallback(async () => {
    // 只有在组件仍然挂载时才继续
    if (!isMountedRef.current) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchFn();

      // 再次检查是否仍然挂载
      if (isMountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : '预览失败';
        setError(errorMessage);
        setData(null);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetchFn]);

  // 触发预览（带防抖）
  const triggerPreview = useCallback(() => {
    clearTimer();

    timerRef.current = setTimeout(() => {
      executePreview();
    }, debounceMs);
  }, [clearTimer, executePreview, debounceMs]);

  // 清空预览状态
  const clearPreview = useCallback(() => {
    clearTimer();
    setData(null);
    setError(null);
    setLoading(false);
  }, [clearTimer]);

  // 自动触发预览（当依赖项变化时）
  useEffect(() => {
    if (autoTrigger) {
      triggerPreview();
    }

    // 清理函数
    return () => {
      clearTimer();
    };
  }, [...dependencies, autoTrigger, triggerPreview]);

  // 组件卸载时的清理
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  return {
    data,
    loading,
    error,
    setData,
    setError,
    clearPreview,
    triggerPreview,
  };
}
