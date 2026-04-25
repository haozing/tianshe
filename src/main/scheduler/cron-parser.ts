/**
 * Cron 表达式解析器
 * 支持标准 5 字段 cron 表达式：分 时 日 月 周
 *
 * 示例：
 * - "0 9 * * *"     每天 9:00
 * - "30 * * * *"    每小时的 30 分
 * - "0 0 * * 0"     每周日 00:00
 * - "0 0 1 * *"     每月 1 号 00:00
 * - "0/15 * * * *"  每 15 分钟
 */

// 从共享工具导入 formatInterval，避免重复定义
export { formatInterval } from '../../utils/scheduler-utils';

/**
 * 解析 cron 字段
 */
function parseField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  // 处理多个值（逗号分隔）
  const parts = field.split(',');

  for (const part of parts) {
    // 处理步进值（如 */15 或 0/15）
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);

      let start = min;
      let end = max;

      if (range !== '*') {
        if (range.includes('-')) {
          const [rangeStart, rangeEnd] = range.split('-').map((n) => parseInt(n, 10));
          start = rangeStart;
          end = rangeEnd;
        } else {
          start = parseInt(range, 10);
        }
      }

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    }
    // 处理范围（如 1-5）
    else if (part.includes('-')) {
      const [start, end] = part.split('-').map((n) => parseInt(n, 10));
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    }
    // 处理通配符
    else if (part === '*') {
      for (let i = min; i <= max; i++) {
        values.add(i);
      }
    }
    // 处理单个值
    else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * 解析 cron 表达式
 */
export function parseCronExpression(expression: string): {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
} {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: "${expression}". Expected 5 fields (minute hour day month weekday)`
    );
  }

  const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = parts;

  return {
    minutes: parseField(minuteStr, 0, 59),
    hours: parseField(hourStr, 0, 23),
    days: parseField(dayStr, 1, 31),
    months: parseField(monthStr, 1, 12),
    weekdays: parseField(weekdayStr, 0, 6), // 0 = Sunday
  };
}

/**
 * 计算下次执行时间
 */
export function getNextCronTime(expression: string, after: Date = new Date()): Date {
  const cron = parseCronExpression(expression);

  // 从 after 时间的下一分钟开始搜索
  const next = new Date(after);
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setMinutes(next.getMinutes() + 1);

  // 最多搜索 4 年（避免无限循环）
  const maxIterations = 4 * 366 * 24 * 60; // 4 年的分钟数
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const month = next.getMonth() + 1; // 1-12
    const day = next.getDate(); // 1-31
    const weekday = next.getDay(); // 0-6
    const hour = next.getHours(); // 0-23
    const minute = next.getMinutes(); // 0-59

    // 检查月份
    if (!cron.months.includes(month)) {
      // 跳到下个月的第一天
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(0);
      next.setMinutes(0);
      continue;
    }

    // 检查日期或星期
    const dayMatch = cron.days.includes(day);
    const weekdayMatch = cron.weekdays.includes(weekday);

    // 如果 day 和 weekday 都不是 *，则是 OR 关系
    const dayIsWildcard = cron.days.length === 31;
    const weekdayIsWildcard = cron.weekdays.length === 7;

    let dateMatches: boolean;
    if (dayIsWildcard && weekdayIsWildcard) {
      dateMatches = true;
    } else if (dayIsWildcard) {
      dateMatches = weekdayMatch;
    } else if (weekdayIsWildcard) {
      dateMatches = dayMatch;
    } else {
      dateMatches = dayMatch || weekdayMatch;
    }

    if (!dateMatches) {
      // 跳到明天
      next.setDate(next.getDate() + 1);
      next.setHours(0);
      next.setMinutes(0);
      continue;
    }

    // 检查小时
    if (!cron.hours.includes(hour)) {
      // 找下一个匹配的小时
      const nextHour = cron.hours.find((h) => h > hour);
      if (nextHour !== undefined) {
        next.setHours(nextHour);
        next.setMinutes(cron.minutes[0]);
      } else {
        // 跳到明天的第一个匹配小时
        next.setDate(next.getDate() + 1);
        next.setHours(cron.hours[0]);
        next.setMinutes(cron.minutes[0]);
      }
      continue;
    }

    // 检查分钟
    if (!cron.minutes.includes(minute)) {
      // 找下一个匹配的分钟
      const nextMinute = cron.minutes.find((m) => m > minute);
      if (nextMinute !== undefined) {
        next.setMinutes(nextMinute);
      } else {
        // 跳到下一个小时的第一个匹配分钟
        next.setHours(next.getHours() + 1);
        next.setMinutes(cron.minutes[0]);
      }
      continue;
    }

    // 所有条件都匹配
    return next;
  }

  throw new Error(`Could not find next execution time for cron expression: ${expression}`);
}

/**
 * 验证 cron 表达式
 */
export function validateCronExpression(expression: string): {
  valid: boolean;
  error?: string;
} {
  try {
    parseCronExpression(expression);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 将 cron 表达式转换为人类可读的描述
 */
export function describeCronExpression(expression: string): string {
  try {
    const cron = parseCronExpression(expression);

    // 简单的描述生成
    const parts: string[] = [];

    // 分钟描述
    if (cron.minutes.length === 60) {
      parts.push('每分钟');
    } else if (cron.minutes.length === 1) {
      if (cron.minutes[0] === 0) {
        // 整点
      } else {
        parts.push(`${cron.minutes[0]} 分`);
      }
    } else {
      parts.push(`${cron.minutes.join(', ')} 分`);
    }

    // 小时描述
    if (cron.hours.length === 24) {
      if (cron.minutes.length !== 60) {
        parts.push('每小时');
      }
    } else if (cron.hours.length === 1) {
      parts.push(`${cron.hours[0]}:${cron.minutes[0].toString().padStart(2, '0')}`);
    } else {
      parts.push(`${cron.hours.join(', ')} 点`);
    }

    // 日期描述
    if (cron.days.length !== 31) {
      parts.push(`每月 ${cron.days.join(', ')} 号`);
    }

    // 星期描述
    if (cron.weekdays.length !== 7) {
      const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const weekdayStrs = cron.weekdays.map((w) => weekdayNames[w]);
      parts.push(weekdayStrs.join(', '));
    }

    // 月份描述
    if (cron.months.length !== 12) {
      parts.push(`${cron.months.join(', ')} 月`);
    }

    // 组合描述
    if (parts.length === 0) {
      return '每分钟';
    }

    // 简化常见模式
    if (
      cron.minutes.length === 1 &&
      cron.minutes[0] === 0 &&
      cron.hours.length === 1 &&
      cron.days.length === 31 &&
      cron.weekdays.length === 7 &&
      cron.months.length === 12
    ) {
      return `每天 ${cron.hours[0].toString().padStart(2, '0')}:00`;
    }

    if (
      cron.minutes.length === 1 &&
      cron.hours.length === 1 &&
      cron.days.length === 31 &&
      cron.weekdays.length === 7 &&
      cron.months.length === 12
    ) {
      return `每天 ${cron.hours[0].toString().padStart(2, '0')}:${cron.minutes[0].toString().padStart(2, '0')}`;
    }

    return parts.join(' ');
  } catch {
    return expression;
  }
}

/**
 * 解析人类可读的时间间隔
 * 支持格式：'30s', '5m', '1h', '1d'
 */
export function parseInterval(interval: string | number): number {
  if (typeof interval === 'number') {
    return interval;
  }

  const match = interval.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) {
    throw new Error(
      `Invalid interval format: "${interval}". Use format like "30s", "5m", "1h", "1d"`
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}
