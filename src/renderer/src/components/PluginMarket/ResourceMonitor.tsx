/**
 * 资源监控组件（底部状态栏版本）
 * 显示 View 池状态和内存使用情况
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Cpu, Globe, ChevronRight } from 'lucide-react';
import { usePluginStore, usePoolStatus, useMemoryUsage } from '../../stores/pluginStore';
import { useUIStore } from '../../stores/uiStore';

export function ResourceMonitor() {
  const { startResourceMonitoring, stopResourceMonitoring } = usePluginStore();
  const { openAccountCenterTab } = useUIStore();
  const poolStatus = usePoolStatus();
  const memoryUsage = useMemoryUsage();
  const [deviceId, setDeviceId] = useState<string>('');
  const [deviceIdError, setDeviceIdError] = useState<string>('');
  const [deviceIdSource, setDeviceIdSource] = useState<'native' | 'fallback'>('native');
  const [deviceIdWarning, setDeviceIdWarning] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // 启动资源监控
    startResourceMonitoring();

    // 获取设备指纹
    const fetchDeviceId = async () => {
      try {
        const result = await window.electronAPI.getDeviceFingerprint();

        if (result.success && result.fingerprint) {
          setDeviceId(result.fingerprint);
          setDeviceIdSource(result.source || 'native');
          setDeviceIdWarning(result.warning || '');
          setDeviceIdError('');
        } else {
          const errorMsg = result.error || '未知错误';
          setDeviceIdError(errorMsg);
          console.error('[ResourceMonitor] Failed to get device ID:', errorMsg);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        setDeviceIdError(errorMsg);
        console.error('[ResourceMonitor] Exception while fetching device ID:', error);
      }
    };
    fetchDeviceId();

    // 组件卸载时停止监控
    return () => {
      stopResourceMonitoring();
    };
  }, []);

  // 获取状态颜色
  const getStatusColor = (percent: number) => {
    if (percent >= 90) return 'text-red-600';
    if (percent >= 70) return 'text-yellow-600';
    return 'text-green-600';
  };

  // 复制设备 ID
  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[ResourceMonitor] 复制失败:', error);
    }
  };

  return (
    <div className="h-8 bg-white border-t flex items-center justify-between px-4 text-xs">
      <div className="flex items-center gap-6">
        {/* View 池状态 - 点击进入浏览器管理 */}
        <button
          onClick={() => openAccountCenterTab('running')}
          className="flex items-center gap-2 hover:bg-gray-100 px-2 py-1 rounded transition-colors cursor-pointer"
          title="点击进入运行中浏览器"
        >
          <Globe className="h-3 w-3 text-blue-500" />
          <span className="text-gray-600">浏览器:</span>
          {poolStatus ? (
            <>
              <span className={getStatusColor(poolStatus.utilizationPercent)}>
                {poolStatus.size}/{poolStatus.maxSize}
              </span>
              {poolStatus.isFull && <AlertCircle className="h-3 w-3 text-red-600" />}
            </>
          ) : (
            <span className="text-gray-400 animate-pulse">...</span>
          )}
          <ChevronRight className="h-3 w-3 text-gray-400" />
        </button>

        {/* 分隔线 */}
        <div className="h-4 w-px bg-gray-200"></div>

        {/* 内存使用 */}
        {memoryUsage ? (
          <div className="flex items-center gap-2">
            <Cpu className="h-3 w-3 text-gray-500" />
            <span className="text-gray-600">内存:</span>
            <span className={getStatusColor(memoryUsage.utilizationPercent)}>
              {memoryUsage.estimatedMB.toFixed(0)} MB
            </span>
            <span className="text-gray-400">({memoryUsage.activeViews} 活跃)</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-gray-400">
            <Cpu className="h-3 w-3 animate-pulse" />
            <span>加载中...</span>
          </div>
        )}

        {/* 使用率百分比 */}
        {poolStatus && (
          <>
            <div className="h-4 w-px bg-gray-200"></div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600">使用率:</span>
              <span className={getStatusColor(poolStatus.utilizationPercent)}>
                {poolStatus.utilizationPercent.toFixed(1)}%
              </span>
            </div>
          </>
        )}
      </div>

      {/* 右侧：设备 ID */}
      <div className="flex items-center gap-2">
        <span className="text-gray-600">设备ID:</span>
        {deviceIdError ? (
          <span className="text-xs text-red-600" title={deviceIdError}>
            获取失败
          </span>
        ) : (
          <>
            <button
              onClick={handleCopyId}
              className="text-xs font-mono text-blue-600 hover:text-blue-800 hover:underline cursor-pointer transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
              title={
                deviceId
                  ? deviceIdSource === 'fallback'
                    ? deviceIdWarning || '使用 fallback 指纹（native 模块不可用）'
                    : '点击复制完整设备ID'
                  : '正在加载...'
              }
              disabled={!deviceId}
            >
              {deviceId ? `${deviceId.substring(0, 16)}...` : '加载中...'}
            </button>
            {deviceIdSource === 'fallback' && deviceId && (
              <span
                className="text-xs text-yellow-700"
                title={deviceIdWarning || '使用 fallback 指纹（native 模块不可用）'}
              >
                fallback
              </span>
            )}
            {copied && <span className="text-green-600 text-xs">✓ 已复制</span>}
          </>
        )}
      </div>
    </div>
  );
}
