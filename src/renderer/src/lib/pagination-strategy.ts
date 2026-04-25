/**
 * 分页策略决策工具
 * 根据操作类型和数据量自动决定是否需要分页
 */

export type OperationType =
  | 'filter'
  | 'sort'
  | 'aggregate'
  | 'clean'
  | 'dedupe'
  | 'sample'
  | 'group'
  | 'compute'
  | 'lookup'
  | 'column'
  | 'color'
  | 'rowHeight';

export type PaginationStrategyType =
  | 'pagination' // 强制分页
  | 'no-pagination' // 不分页
  | 'virtual-scroll' // 虚拟滚动
  | 'conditional'; // 条件分页

export interface PaginationStrategy {
  type: PaginationStrategyType;
  pageSize?: number;
  showCount?: boolean; // 是否显示结果计数
  reason?: string; // 决策原因
}

/**
 * 分页阈值配置
 */
export const PAGINATION_THRESHOLDS = {
  // 超过此行数强制分页
  FORCE_PAGINATION: 100000,

  // 建议分页阈值
  SUGGEST_PAGINATION: 50000,

  // 虚拟滚动阈值
  VIRTUAL_SCROLL: 500,

  // 默认分页大小
  DEFAULT_PAGE_SIZE: 10000,

  // 排序专用分页大小
  SORT_PAGE_SIZE: 10000,
} as const;

/**
 * 根据操作类型和数据量决定分页策略
 */
export function determinePaginationStrategy(
  operation: OperationType,
  inputRowCount: number,
  outputRowCount?: number // 预估输出行数（如果可知）
): PaginationStrategy {
  // 实际行数（优先使用输出行数）
  const effectiveRowCount = outputRowCount ?? inputRowCount;

  switch (operation) {
    case 'filter':
      // 筛选：不分页，但需显示结果计数
      return {
        type: 'no-pagination',
        showCount: true,
        reason: '筛选操作通过谓词下推优化，无需分页',
      };

    case 'sort':
      // 排序：强制分页（性能考虑）
      // 排序需要扫描全表，分页可以减少内存占用
      return {
        type: 'pagination',
        pageSize: Math.min(PAGINATION_THRESHOLDS.SORT_PAGE_SIZE, inputRowCount),
        reason: '排序操作需要分页以优化性能和内存占用',
      };

    case 'aggregate':
      // 聚合：通常不需要分页（自动降维）
      // 但如果聚合后仍有大量数据，建议分页
      if (effectiveRowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          showCount: true,
          reason: '聚合结果较多，建议分页以提升性能',
        };
      }
      return {
        type: 'no-pagination',
        showCount: true,
        reason: '聚合操作自动降维，通常结果数据量较小',
      };

    case 'dedupe':
      // 去重：条件分页
      // 去重后如果仍有大量数据，建议分页
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '去重后数据量仍较大，强制分页',
        };
      } else if (effectiveRowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
        return {
          type: 'conditional',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '去重后数据量较多，建议启用分页',
        };
      }
      return {
        type: 'virtual-scroll',
        reason: '去重后数据量适中，使用虚拟滚动',
      };

    case 'sample':
      // 采样：通常降维，但结果仍可能很大，保留条件分页能力
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          showCount: true,
          reason: '采样结果仍然较大，强制分页以保持滚动稳定和内存可控',
        };
      }
      if (effectiveRowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
        return {
          type: 'conditional',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          showCount: true,
          reason: '采样结果较多，建议启用分页',
        };
      }
      return {
        type: 'no-pagination',
        showCount: true,
        reason: '采样结果较小，无需分页',
      };

    case 'group':
      // 分组（窗口函数）：不改变行数，使用虚拟滚动
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '分组后数据量过大，建议分页',
        };
      }
      return {
        type: 'virtual-scroll',
        reason: '窗口函数分组不改变行数，使用虚拟滚动',
      };

    case 'compute':
      // 计算列：不改变行数，使用虚拟滚动
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '数据量过大，建议分页',
        };
      }
      return {
        type: 'virtual-scroll',
        reason: '计算列不改变行数，使用虚拟滚动',
      };

    case 'lookup':
      // 关联：可能略有增加，使用虚拟滚动
      // 注意：INNER JOIN 可能减少行数，LEFT JOIN 保持或略增
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '关联后数据量过大，建议分页',
        };
      }
      return {
        type: 'virtual-scroll',
        reason: '关联操作使用虚拟滚动处理结果',
      };

    case 'clean':
      // 清洗：不改变行数，无需分页
      return {
        type: 'no-pagination',
        reason: '数据清洗不改变行数，无需分页',
      };

    case 'column':
    case 'color':
    case 'rowHeight':
      // 纯 UI 操作，永不分页
      return {
        type: 'no-pagination',
        reason: '纯 UI 操作，无需分页',
      };

    default:
      // 默认策略：根据数据量自动决定
      if (effectiveRowCount > PAGINATION_THRESHOLDS.FORCE_PAGINATION) {
        return {
          type: 'pagination',
          pageSize: PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE,
          reason: '数据量过大，强制分页',
        };
      } else if (effectiveRowCount > PAGINATION_THRESHOLDS.VIRTUAL_SCROLL) {
        return {
          type: 'virtual-scroll',
          reason: '数据量适中，使用虚拟滚动',
        };
      }
      return {
        type: 'no-pagination',
        reason: '数据量较小，无需特殊处理',
      };
  }
}

/**
 * 判断是否需要显示分页警告
 */
export function shouldShowPaginationWarning(
  operation: OperationType,
  rowCount: number
): { show: boolean; message?: string } {
  const strategy = determinePaginationStrategy(operation, rowCount);

  if (strategy.type === 'conditional') {
    return {
      show: true,
      message: `${strategy.reason}。当前数据量：${rowCount.toLocaleString()} 条。`,
    };
  }

  if (operation === 'aggregate' && rowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
    return {
      show: true,
      message: `聚合后仍有 ${rowCount.toLocaleString()} 条记录，建议先应用筛选以减少数据量。`,
    };
  }

  if (operation === 'dedupe' && rowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
    return {
      show: true,
      message: `去重后仍有 ${rowCount.toLocaleString()} 条记录，建议先应用筛选或采样以减少数据量。`,
    };
  }

  if (operation === 'sample' && rowCount > PAGINATION_THRESHOLDS.SUGGEST_PAGINATION) {
    return {
      show: true,
      message: `采样后仍有 ${rowCount.toLocaleString()} 条记录，建议启用分页或进一步缩小采样范围。`,
    };
  }

  return { show: false };
}

/**
 * 获取推荐的分页大小
 */
export function getRecommendedPageSize(operation: OperationType, totalRows: number): number {
  const strategy = determinePaginationStrategy(operation, totalRows);

  if (strategy.pageSize) {
    return strategy.pageSize;
  }

  // 根据总行数动态调整
  if (totalRows < 1000) return totalRows; // 小数据集直接全部加载
  if (totalRows < 10000) return 100;
  if (totalRows < 100000) return 500;
  if (totalRows < 1000000) return 1000;
  return PAGINATION_THRESHOLDS.DEFAULT_PAGE_SIZE;
}

/**
 * 格式化分页信息文本
 */
export function formatPaginationInfo(
  currentPage: number,
  pageSize: number,
  totalRows: number
): string {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalRows);

  return `显示 ${start.toLocaleString()} - ${end.toLocaleString()} 条，共 ${totalRows.toLocaleString()} 条`;
}

/**
 * 计算总页数
 */
export function calculateTotalPages(totalRows: number, pageSize: number): number {
  return Math.ceil(totalRows / pageSize);
}
