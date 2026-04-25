/**
 * 定时任务调度器 - 共享工具函数
 * 供主进程和渲染进程使用
 */

import type { ScheduledTask } from '../types/scheduler';

/**
 * 将毫秒间隔转换为详细的人类可读格式
 * 例如: 3723000 -> "1 小时 2 分钟"
 */
export function formatInterval(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours} 小时`;
    }
    return `${hours} 小时 ${remainingMinutes} 分钟`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours === 0) {
    return `${days} 天`;
  }
  return `${days} 天 ${remainingHours} 小时`;
}

/**
 * 将毫秒转换为简短格式
 * 例如: 3723000 -> "1.0h"
 */
export function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * 格式化时间戳为本地日期时间字符串
 */
export function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 获取调度类型的人类可读描述
 *
 * 注意：此函数不解析 cron 表达式，仅提供基础描述
 * 如需详细的 cron 描述，请使用主进程的 describeCronExpression
 */
export function getScheduleDescription(task: ScheduledTask): string {
  if (task.scheduleType === 'cron' && task.cronExpression) {
    // 简单的 cron 描述，不做完整解析
    return `Cron: ${task.cronExpression}`;
  } else if (task.scheduleType === 'interval' && task.intervalMs) {
    return `每 ${formatInterval(task.intervalMs)}`;
  } else if (task.scheduleType === 'once' && task.runAt) {
    return `一次性: ${formatTimestamp(task.runAt)}`;
  }
  return '未知';
}
