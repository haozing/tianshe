/**
 * 按钮单元格组件
 *
 * 点击时仅入队执行请求，真正的插件调用放到 effect 中处理，
 * 避免把 Electron IPC 调用绑在表格点击事件栈里。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Link2, Loader2, XCircle } from 'lucide-react';
import { toast } from '../../../lib/toast';
import { pluginFacade } from '../../../services/datasets/pluginFacade';
import { normalizeButtonMetadata } from '../../../../../utils/button-metadata';

type ExecutionStatus = 'idle' | 'executing' | 'success' | 'error';

const STATUS_RESET_DELAY = {
  success: 3000,
  error: 5000,
} as const;

const EXECUTION_FEEDBACK_TIMEOUT_MS = 2500;
const BUTTON_CELL_BRIDGE_ID = 'datasets-button-cell-ipc-bridge';

type ActionExecutionResult = {
  updatedFields?: string[];
  triggeredNext?: boolean;
};

type PendingExecution = {
  requestId: number;
  rowId: number;
};

type BridgeCallKind = 'list' | 'executeActionColumn';

type BridgeCallRequest = {
  kind: BridgeCallKind;
  args: unknown[];
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

type ButtonCellBridgeState = {
  queue: BridgeCallRequest[];
  running: boolean;
};

type BrowserTimeoutHandle = number;

function getBridgeState(): ButtonCellBridgeState {
  const bridgeHost = globalThis as typeof globalThis & {
    __datasetsButtonCellBridgeState?: ButtonCellBridgeState;
  };

  if (!bridgeHost.__datasetsButtonCellBridgeState) {
    bridgeHost.__datasetsButtonCellBridgeState = {
      queue: [],
      running: false,
    };
  }

  return bridgeHost.__datasetsButtonCellBridgeState;
}

function ensureBridgeButton(): HTMLButtonElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const existingButton = document.getElementById(BUTTON_CELL_BRIDGE_ID) as HTMLButtonElement | null;
  if (existingButton) {
    return existingButton;
  }

  const bridgeButton = document.createElement('button');
  bridgeButton.id = BUTTON_CELL_BRIDGE_ID;
  bridgeButton.type = 'button';
  bridgeButton.setAttribute('aria-hidden', 'true');
  bridgeButton.tabIndex = -1;
  bridgeButton.style.position = 'fixed';
  bridgeButton.style.left = '-9999px';
  bridgeButton.style.top = '-9999px';

  bridgeButton.addEventListener('click', async () => {
    const bridgeState = getBridgeState();
    if (bridgeState.running || bridgeState.queue.length === 0) {
      return;
    }

    const request = bridgeState.queue.shift();
    if (!request) {
      return;
    }

    bridgeState.running = true;

    try {
      const jsPluginApi = window.electronAPI?.jsPlugin;
      if (!jsPluginApi) {
        throw new Error('Electron API is not available. Make sure the preload script is loaded.');
      }

      let result: unknown;
      if (request.kind === 'list') {
        result = await jsPluginApi.list();
      } else {
        result = await jsPluginApi.executeActionColumn(
          request.args[0] as string,
          request.args[1] as string,
          request.args[2] as number,
          request.args[3] as string
        );
      }

      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      bridgeState.running = false;
      if (bridgeState.queue.length > 0) {
        bridgeButton.click();
      }
    }
  });

  document.body.appendChild(bridgeButton);
  return bridgeButton;
}

function invokeBridge(kind: BridgeCallKind, args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const bridgeButton = ensureBridgeButton();
    if (!bridgeButton) {
      reject(new Error('Button cell bridge is unavailable'));
      return;
    }

    const bridgeState = getBridgeState();
    bridgeState.queue.push({ kind, args, resolve, reject });

    if (!bridgeState.running) {
      bridgeButton.click();
    }
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: BrowserTimeoutHandle | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      window.clearTimeout(timer);
    }
  });
}

export interface ButtonCellProps {
  rowData: Record<string, unknown>;
  metadata?: {
    pluginId?: string;
    methodId?: string;
    buttonLabel?: string;
    buttonIcon?: string;
    buttonColor?: string;
    buttonVariant?: 'default' | 'primary' | 'success' | 'danger';
    confirmMessage?: string;
    showResult?: boolean;
  };
  datasetId?: string;
  readOnly?: boolean;
}

function resolveRowId(rowData: Record<string, unknown>): number {
  const rawRowId = rowData._row_id;

  if (typeof rawRowId === 'number' && Number.isFinite(rawRowId)) {
    return rawRowId;
  }

  if (typeof rawRowId === 'string' && rawRowId.trim().length > 0) {
    const parsed = Number(rawRowId);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error('缺少 _row_id');
}

export const ButtonCell: React.FC<ButtonCellProps> = ({ rowData, metadata, datasetId, readOnly }) => {
  const normalizedMetadata = normalizeButtonMetadata(metadata);
  const {
    pluginId,
    methodId,
    buttonLabel = '执行',
    buttonIcon = '▶️',
    buttonVariant = 'primary',
    confirmMessage,
    showResult = true,
  } = normalizedMetadata;
  const resolvedPluginId = typeof pluginId === 'string' ? pluginId.trim() : '';
  const resolvedMethodId = typeof methodId === 'string' ? methodId.trim() : '';
  const resolvedDatasetId = typeof datasetId === 'string' ? datasetId.trim() : '';

  const [status, setStatus] = useState<ExecutionStatus>('idle');
  const [lastResult, setLastResult] = useState<ActionExecutionResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingExecution, setPendingExecution] = useState<PendingExecution | null>(null);
  const [debugPhase, setDebugPhase] = useState('idle');

  const isMountedRef = useRef(true);
  const timeoutRef = useRef<BrowserTimeoutHandle | null>(null);
  const executionWatchdogRef = useRef<BrowserTimeoutHandle | null>(null);
  const directDomFallbackRef = useRef<BrowserTimeoutHandle | null>(null);
  const requestSequenceRef = useRef(0);
  const activeRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      if (executionWatchdogRef.current) {
        window.clearTimeout(executionWatchdogRef.current);
      }
      if (directDomFallbackRef.current) {
        window.clearTimeout(directDomFallbackRef.current);
      }
    };
  }, []);

  const clearDirectDomFallback = useCallback(() => {
    if (directDomFallbackRef.current) {
      window.clearTimeout(directDomFallbackRef.current);
      directDomFallbackRef.current = null;
    }
  }, []);

  const scheduleStatusReset = useCallback((nextStatus: 'success' | 'error') => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      if (!isMountedRef.current) {
        return;
      }

      setStatus('idle');
      setDebugPhase('idle');
    }, STATUS_RESET_DELAY[nextStatus]);
  }, []);

  const applyExecutionFailure = useCallback(
    (message: string, requestId: number) => {
      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      setLastResult(null);
      setLastError(message);
      setStatus('error');
      setDebugPhase('error');
      toast.error(`执行失败: ${message}`);
      scheduleStatusReset('error');
    },
    [scheduleStatusReset]
  );

  const executeActionColumn = useCallback(
    (rowId: number) => {
      if (!resolvedPluginId || !resolvedMethodId || !resolvedDatasetId) {
        return Promise.resolve({
          success: false,
          error: '按钮动作未正确配置 pluginId、methodId 或 datasetId',
        });
      }

      if (window.electronAPI?.jsPlugin?.executeActionColumn) {
        return invokeBridge('executeActionColumn', [
          resolvedPluginId,
          resolvedMethodId,
          rowId,
          resolvedDatasetId,
        ]).catch(() =>
          window.electronAPI.jsPlugin.executeActionColumn(
            resolvedPluginId,
            resolvedMethodId,
            rowId,
            resolvedDatasetId
          )
        );
      }

      return pluginFacade.executeActionColumn(
        resolvedPluginId,
        resolvedMethodId,
        rowId,
        resolvedDatasetId
      );
    },
    [resolvedDatasetId, resolvedMethodId, resolvedPluginId]
  );

  const isPluginInstalled = useCallback(async () => {
    if (!resolvedPluginId) {
      return false;
    }

    const listResult = window.electronAPI?.jsPlugin?.list
      ? await invokeBridge('list', []).catch(() => window.electronAPI.jsPlugin.list())
      : await pluginFacade.listPlugins();

    if (!listResult.success || !Array.isArray(listResult.plugins)) {
      return true;
    }

    return listResult.plugins.some((plugin: { id?: string } | null | undefined) => {
      return plugin?.id === resolvedPluginId;
    });
  }, [resolvedPluginId]);

  const getButtonStyle = () => {
    const baseStyle =
      'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50';

    const variants: Record<string, string> = {
      default: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
      primary: 'bg-blue-600 text-white hover:bg-blue-700',
      success: 'bg-green-600 text-white hover:bg-green-700',
      danger: 'bg-red-600 text-white hover:bg-red-700',
    };

    return `${baseStyle} ${variants[buttonVariant] || variants.primary} ${
      status === 'executing' ? 'animate-pulse' : ''
    }`;
  };

  const handleExecute = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (status === 'executing') {
        return;
      }

      if (readOnly) {
        toast.warning('数据未就绪，暂不支持执行插件操作');
        return;
      }

      if (confirmMessage && !window.confirm(confirmMessage)) {
        return;
      }

      let rowId: number;
      try {
        rowId = resolveRowId(rowData);
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        const requestId = requestSequenceRef.current + 1;
        requestSequenceRef.current = requestId;
        activeRequestIdRef.current = requestId;
        applyExecutionFailure(message, requestId);
        return;
      }

      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      clearDirectDomFallback();

      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      activeRequestIdRef.current = requestId;
      setLastResult(null);
      setLastError(null);
      setStatus('executing');
      setDebugPhase('queued');
      setPendingExecution({ requestId, rowId });

      const buttonElement = event.currentTarget;
      directDomFallbackRef.current = window.setTimeout(() => {
        if (!buttonElement.isConnected || activeRequestIdRef.current !== requestId) {
          return;
        }

        activeRequestIdRef.current = null;
        setPendingExecution(null);
        setLastResult(null);
        setLastError('插件执行未在预期时间内返回，请重试。');
        setStatus('error');
        setDebugPhase('timeout');
        toast.error('执行失败: 插件执行未在预期时间内返回，请重试。');
        scheduleStatusReset('error');
      }, EXECUTION_FEEDBACK_TIMEOUT_MS);
    },
    [applyExecutionFailure, buttonLabel, clearDirectDomFallback, confirmMessage, readOnly, rowData, scheduleStatusReset, status]
  );

  useEffect(() => {
    if (
      pendingExecution == null ||
      !resolvedPluginId ||
      !resolvedMethodId ||
      !resolvedDatasetId
    ) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        setDebugPhase('executing-action');
        const response = await withTimeout(
          (async () => {
            const pluginInstalled = await isPluginInstalled();
            if (!pluginInstalled) {
              return {
                success: false,
                error: `Plugin ${resolvedPluginId} is not installed. Please install it first.`,
              };
            }

            return executeActionColumn(pendingExecution.rowId);
          })(),
          EXECUTION_FEEDBACK_TIMEOUT_MS,
          '插件执行未在预期时间内返回，请重试。'
        );

        if (
          cancelled ||
          !isMountedRef.current ||
          activeRequestIdRef.current !== pendingExecution.requestId
        ) {
          return;
        }

        if (response.success) {
          clearDirectDomFallback();
          const result = response.result || {};
          const nextResult: ActionExecutionResult = {
            updatedFields: Array.isArray(result.updatedFields) ? result.updatedFields : undefined,
            triggeredNext: Boolean(result.triggeredNext),
          };

          setLastError(null);
          setLastResult(nextResult);
          setStatus('success');
          setDebugPhase('success');

          if (showResult) {
            const successSummary = ['执行成功'];
            if (nextResult.updatedFields && nextResult.updatedFields.length > 0) {
              successSummary.push(`已更新: ${nextResult.updatedFields.join(', ')}`);
            }
            if (nextResult.triggeredNext) {
              successSummary.push('已触发链式执行');
            }
            toast.success(successSummary.join('\n'));
          }

          scheduleStatusReset('success');
        } else {
          clearDirectDomFallback();
          applyExecutionFailure(response.error || '未知错误', pendingExecution.requestId);
        }
      } catch (error) {
        clearDirectDomFallback();
        const message = error instanceof Error ? error.message : '未知错误';
        applyExecutionFailure(message, pendingExecution.requestId);
      } finally {
        if (
          !cancelled &&
          isMountedRef.current &&
          activeRequestIdRef.current === pendingExecution.requestId
        ) {
          setPendingExecution(null);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    applyExecutionFailure,
    clearDirectDomFallback,
    executeActionColumn,
    isPluginInstalled,
    pendingExecution,
    resolvedDatasetId,
    resolvedMethodId,
    resolvedPluginId,
    scheduleStatusReset,
    showResult,
  ]);

  useEffect(() => {
    if (pendingExecution == null || status !== 'executing') {
      if (executionWatchdogRef.current) {
        window.clearTimeout(executionWatchdogRef.current);
        executionWatchdogRef.current = null;
      }
      return;
    }

    if (executionWatchdogRef.current) {
      window.clearTimeout(executionWatchdogRef.current);
    }

    executionWatchdogRef.current = window.setTimeout(() => {
      if (!isMountedRef.current || activeRequestIdRef.current !== pendingExecution.requestId) {
        return;
      }

      activeRequestIdRef.current = null;
      setPendingExecution(null);
      setLastResult(null);
      setLastError('插件执行未在预期时间内返回，请重试。');
      setStatus('error');
      setDebugPhase('timeout');
      clearDirectDomFallback();
      toast.error('执行失败: 插件执行未在预期时间内返回，请重试。');
      scheduleStatusReset('error');
    }, EXECUTION_FEEDBACK_TIMEOUT_MS);

    return () => {
      if (executionWatchdogRef.current) {
        window.clearTimeout(executionWatchdogRef.current);
        executionWatchdogRef.current = null;
      }
    };
  }, [clearDirectDomFallback, pendingExecution, scheduleStatusReset, status]);

  if (!resolvedPluginId || !resolvedMethodId) {
    return (
      <span className="flex items-center gap-1 text-xs italic text-gray-400">
        <XCircle className="h-3 w-3" />
        未配置
      </span>
    );
  }

  if (!resolvedDatasetId) {
    return (
      <span className="flex items-center gap-1 text-xs italic text-gray-400">
        <XCircle className="h-3 w-3" />
        缺少数据集
      </span>
    );
  }

  const renderButtonContent = () => {
    switch (status) {
      case 'executing':
        return (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>执行中...</span>
          </>
        );
      case 'success':
        return (
          <>
            <CheckCircle className="h-4 w-4" />
            <span>完成</span>
            {lastResult?.triggeredNext ? <Link2 className="h-3 w-3" /> : null}
          </>
        );
      case 'error':
        return (
          <>
            <XCircle className="h-4 w-4" />
            <span>失败</span>
          </>
        );
      default:
        return (
          <>
            <span>{buttonIcon}</span>
            <span>{buttonLabel}</span>
          </>
        );
    }
  };

  const title = readOnly
    ? '数据未就绪，暂不支持执行插件操作'
    : lastError
      ? `上次失败: ${lastError}`
      : lastResult?.updatedFields && lastResult.updatedFields.length > 0
        ? `上次更新: ${lastResult.updatedFields.join(', ')}`
        : undefined;
  const ariaLabel =
    status === 'error'
      ? `${buttonLabel} 执行失败`
      : status === 'success'
        ? `${buttonLabel} 执行完成`
        : status === 'executing'
          ? `${buttonLabel} 执行中`
          : buttonLabel;

  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={handleExecute}
      disabled={status === 'executing' || readOnly}
      className={getButtonStyle()}
      title={title}
      aria-label={ariaLabel}
      data-button-cell-status={status}
      data-button-cell-bound="true"
      data-button-cell-invocations={String(requestSequenceRef.current)}
      data-button-cell-phase={debugPhase}
    >
      {renderButtonContent()}
    </button>
  );
};
