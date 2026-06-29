/**
 * 强制更新模态框
 * 全屏显示，无法关闭，必须完成更新
 */

import { AlertTriangle, CheckCircle, Download, RefreshCw } from 'lucide-react';
import { formatBytes, formatSpeed } from '../../utils/format';

interface ForceUpdateModalProps {
  state: 'available' | 'downloading' | 'downloaded' | 'error';
  version: string;
  downloadProgress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  };
  error: string;
  onRetry: () => void;
}

export function ForceUpdateModal({
  state,
  version,
  downloadProgress,
  error,
  onRetry,
}: ForceUpdateModalProps) {
  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-8 max-w-md w-full mx-4">
        <div className="flex flex-col items-center text-center">
          {/* 图标 */}
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
              state === 'downloaded'
                ? 'bg-green-100 dark:bg-green-900/30'
                : 'bg-orange-100 dark:bg-orange-900/30'
            }`}
          >
            {state === 'error' ? (
              <AlertTriangle className="w-8 h-8 text-orange-500" />
            ) : state === 'downloaded' ? (
              <CheckCircle className="w-8 h-8 text-green-500" />
            ) : (
              <RefreshCw
                className={`w-8 h-8 text-orange-500 ${state === 'downloading' ? 'animate-spin' : ''}`}
              />
            )}
          </div>

          {/* 标题 */}
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">必须更新</h2>

          {/* 描述 */}
          {state === 'available' && (
            <>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                检测到新版本{' '}
                <span className="font-semibold text-gray-900 dark:text-gray-100">{version}</span>
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-500 mb-6">
                当前版本过旧，必须更新后才能继续使用。
                <br />
                更新将自动下载并安装，请稍候...
              </p>
            </>
          )}

          {state === 'downloading' && (
            <>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                正在下载新版本{' '}
                <span className="font-semibold text-gray-900 dark:text-gray-100">{version}</span>
              </p>

              {/* 进度条 */}
              <div className="w-full mb-4">
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden mb-2">
                  <div
                    className="bg-orange-500 h-3 transition-all duration-300 ease-out"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
                <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>{Math.round(downloadProgress.percent)}%</span>
                  <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
                </div>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-500">
                {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
              </p>
            </>
          )}

          {state === 'downloaded' && (
            <>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                新版本{' '}
                <span className="font-semibold text-gray-900 dark:text-gray-100">{version}</span>{' '}
                已下载完成
              </p>
              <p className="text-sm text-green-600 dark:text-green-400 mb-6">
                即将自动重启安装，请稍候...
              </p>
              {/* 进度指示 */}
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div className="bg-green-500 h-2 animate-pulse w-full" />
              </div>
            </>
          )}

          {state === 'error' && (
            <>
              <p className="text-red-600 dark:text-red-400 mb-4">更新失败</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{error}</p>
              <button
                onClick={onRetry}
                className="w-full px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
              >
                <Download className="w-5 h-5" />
                重试下载
              </button>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-4">
                如果持续失败，请访问官网手动下载最新版本
              </p>
            </>
          )}

          {/* 警告 */}
          {(state === 'available' || state === 'downloading') && (
            <div className="mt-6 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-xs text-yellow-800 dark:text-yellow-300">
                ⚠️ 更新完成前，应用将无法使用，请勿关闭窗口
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
