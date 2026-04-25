/**
 * UI 相关常量配置
 * 集中管理颜色、样式等 UI 常量
 */

/**
 * 预设的标签颜色
 * 用于账号标签、配置标签等的显示
 */
export const TAG_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
] as const;

/**
 * 获取标签颜色（循环使用）
 * @param index 标签索引
 * @returns 颜色值
 */
export function getTagColor(index: number): string {
  return TAG_COLORS[index % TAG_COLORS.length];
}

/**
 * 获取标签背景色（带透明度）
 * @param index 标签索引
 * @returns 背景色值
 */
export function getTagBackgroundColor(index: number): string {
  return `${getTagColor(index)}20`;
}

/**
 * 获取标签边框色（带透明度）
 * @param index 标签索引
 * @returns 边框色值
 */
export function getTagBorderColor(index: number): string {
  return `${getTagColor(index)}40`;
}
