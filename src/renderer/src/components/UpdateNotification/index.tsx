/**
 * 软件更新通知组件
 * 功能：
 * - 显示更新检查状态
 * - 显示下载进度
 * - 提示安装更新
 * - 处理强制更新逻辑
 */

import { useState, useEffect } from 'react';
import { X, Download, RefreshCw } from 'lucide-react';
import { ForceUpdateModal } from './ForceUpdateModal';
import { formatBytes, formatSpeed } from '../../utils/format';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'not-available';

interface UpdateInfo {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  isForceUpdate?: boolean;
}

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export function UpdateNotification() {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({});
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });
  const [error, setError] = useState<string>('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // 监听：正在检查更新
    cleanups.push(
      window.electronAPI.updater.onChecking(() => {
        setUpdateState('checking');
        setVisible(true);
        // 使用函数式更新避免闭包陷阱
        setTimeout(() => {
          setUpdateState((currentState) => {
            if (currentState === 'checking') {
              setVisible(false); // 3秒后自动隐藏"正在检查"
            }
            return currentState; // 不改变 state
          });
        }, 3000);
      })
    );

    // 监听：发现新版本
    cleanups.push(
      window.electronAPI.updater.onUpdateAvailable((info) => {
        setUpdateState('available');
        setUpdateInfo(info);
        setVisible(true);

        // 如果是强制更新，不允许关闭
        if (info.isForceUpdate) {
          console.warn('[UpdateNotification] Force update detected, notification cannot be closed');
        }
      })
    );

    // 监听：已是最新版本
    cleanups.push(
      window.electronAPI.updater.onUpdateNotAvailable(() => {
        setUpdateState('not-available');
        setVisible(true);
        // 2秒后自动隐藏
        setTimeout(() => {
          setVisible(false);
        }, 2000);
      })
    );

    // 监听：下载进度
    cleanups.push(
      window.electronAPI.updater.onDownloadProgress((progress) => {
        setUpdateState('downloading');
        setDownloadProgress(progress);
        setVisible(true);
      })
    );

    // 监听：下载完成
    cleanups.push(
      window.electronAPI.updater.onUpdateDownloaded((info) => {
        setUpdateState('downloaded');
        setUpdateInfo((prev) => ({ ...prev, ...info }));
        setVisible(true);
      })
    );

    // 监听：更新错误
    cleanups.push(
      window.electronAPI.updater.onError((err) => {
        setUpdateState('error');
        setError(err.message);
        setUpdateInfo((prev) => ({ ...prev, isForceUpdate: err.isForceUpdate }));
        setVisible(true);
      })
    );

    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  const handleClose = () => {
    // 强制更新时不允许关闭
    if (updateInfo.isForceUpdate) {
      return;
    }
    setVisible(false);
  };

  const handleInstall = () => {
    window.electronAPI.updater.quitAndInstall();
  };

  const handleRetryDownload = () => {
    window.electronAPI.updater.downloadUpdate();
  };

  // 如果是强制更新，显示全屏模态框
  if (
    updateInfo.isForceUpdate &&
    (updateState === 'available' ||
      updateState === 'downloading' ||
      updateState === 'downloaded' ||
      updateState === 'error')
  ) {
    return (
      <ForceUpdateModal
        state={updateState as 'available' | 'downloading' | 'downloaded' | 'error'}
        version={updateInfo.version || ''}
        downloadProgress={downloadProgress}
        error={error}
        onRetry={handleRetryDownload}
      />
    );
  }

  // 普通通知（右上角）
  if (!visible) return null;

  return (
    <div className="fixed top-4 right-4 z-50 w-96 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 animate-in slide-in-from-right">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <RefreshCw
            className={`w-5 h-5 text-blue-500 ${updateState === 'checking' || updateState === 'downloading' ? 'animate-spin' : ''}`}
          />
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">软件更新</h3>
        </div>
        {!updateInfo.isForceUpdate && (
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 正在检查 */}
      {updateState === 'checking' && (
        <p className="text-sm text-gray-600 dark:text-gray-400">正在检查更新...</p>
      )}

      {/* 已是最新版本 */}
      {updateState === 'not-available' && (
        <p className="text-sm text-green-600 dark:text-green-400">✓ 当前已是最新版本</p>
      )}

      {/* 发现新版本 */}
      {updateState === 'available' && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            发现新版本{' '}
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {updateInfo.version}
            </span>
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-500 mb-3">更新将自动下载...</p>
        </>
      )}

      {/* 正在下载 */}
      {updateState === 'downloading' && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">正在下载更新...</p>
          <div className="mb-2">
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className="bg-blue-500 h-2 transition-all duration-300 ease-out"
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>
          </div>
          <div className="flex justify-between text-xs text-gray-500 dark:text-gray-500">
            <span>{Math.round(downloadProgress.percent)}%</span>
            <span>
              {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
            </span>
            <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
          </div>
        </>
      )}

      {/* 下载完成 */}
      {updateState === 'downloaded' && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            新版本{' '}
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {updateInfo.version}
            </span>{' '}
            已下载完成
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleInstall}
              className="flex-1 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              立即安装
            </button>
            <button
              onClick={handleClose}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md transition-colors"
            >
              稍后安装
            </button>
          </div>
        </>
      )}

      {/* 错误 */}
      {updateState === 'error' && (
        <>
          <p className="text-sm text-red-600 dark:text-red-400 mb-3">更新失败: {error}</p>
          {updateInfo.isForceUpdate ? (
            <button
              onClick={handleRetryDownload}
              className="w-full px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-md transition-colors"
            >
              重试下载
            </button>
          ) : (
            <button
              onClick={handleClose}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md transition-colors"
            >
              关闭
            </button>
          )}
        </>
      )}
    </div>
  );
}
