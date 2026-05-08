/**
 * Sync 字段标准化工具
 *
 * 统一处理同步相关字段（sync_scope_type, sync_scope_id, sync_managed 等）
 * 的输入校验和类型转换，消除 tag/account/saved-site 等服务中的重复方法。
 */

export interface SyncScope {
  scopeType: string | null;
  scopeId: number | null;
}

export interface SyncOwnership {
  ownerUserId: number | null;
  ownerUserName: string | null;
}

/** 标准化字符串型 sync 字段（去空后返回 null 或字符串） */
export function normalizeSyncString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

/** 标准化数值型 sync 字段（非有限数返回 null，整数截断，可选最小值过滤） */
export function normalizeSyncInteger(
  value: unknown,
  options?: { min?: number }
): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const truncated = Math.trunc(numeric);
  if (options?.min !== undefined && truncated < options.min) return null;
  return truncated;
}

/** 标准化布尔型 sync 字段 */
export function normalizeSyncBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/** 将任意值转换为 DuckDB TIMESTAMP 可接受的值（null 保持 null，Date 转 ISO 字符串） */
export function normalizeSyncTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const str = String(value).trim();
  return str || null;
}

/** 组合标准化 sync scope */
export function normalizeSyncScope(
  scopeType: unknown,
  scopeId: unknown
): SyncScope {
  return {
    scopeType: normalizeSyncString(scopeType),
    scopeId: normalizeSyncInteger(scopeId),
  };
}

/** 组合标准化 sync ownership */
export function normalizeSyncOwnership(
  ownerUserId: unknown,
  ownerUserName: unknown
): SyncOwnership {
  return {
    ownerUserId: normalizeSyncInteger(ownerUserId),
    ownerUserName: normalizeSyncString(ownerUserName),
  };
}
