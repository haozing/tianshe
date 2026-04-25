/**
 * 布局计算引擎
 * 负责根据语义化布局模式计算插件视图的实际边界
 */

import { Rectangle } from 'electron';
import { ACTIVITY_BAR_WIDTH, MIN_VIEW_SIZE, DEFAULT_SPLIT_SIZE } from '../constants/layout';

/**
 * 窗口信息
 */
export interface WindowInfo {
  width: number;
  height: number;
  activityBarWidth: number; // Activity Bar 宽度，通常是 64
}

/**
 * 视图边界
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 布局计算器类
 */
export class LayoutCalculator {
  /**
   * ✨ 计算插件主视图的全屏边界（占满 Activity Bar 右侧所有空间）
   * @param windowInfo 窗口信息
   * @returns 视图边界
   */
  static calculateFullBounds(windowInfo: WindowInfo): ViewBounds {
    const { width: windowWidth, height: windowHeight, activityBarWidth } = windowInfo;

    return {
      x: activityBarWidth,
      y: 0,
      width: windowWidth - activityBarWidth,
      height: windowHeight,
    };
  }

  /**
   * 获取窗口信息
   */
  static getWindowInfo(windowBounds: Rectangle, activityBarWidth = ACTIVITY_BAR_WIDTH): WindowInfo {
    return {
      width: windowBounds.width,
      height: windowBounds.height,
      activityBarWidth,
    };
  }

  /**
   * ✨ 计算分栏布局（主视图 + 次视图）
   * @param splitConfig 分栏配置
   * @param containerBounds 容器边界（通常是插件视图的总边界）
   */
  static calculateSplitLayout(
    splitConfig: SplitLayoutConfig,
    containerBounds: ViewBounds
  ): SplitLayoutResult {
    const { mode, size } = splitConfig;
    const { x, y, width, height } = containerBounds;

    // 使用默认尺寸（如果未提供）
    const defaultSize = mode.includes('left') || mode.includes('right') ? '40%' : '300px';
    const actualSize = size !== undefined ? size : defaultSize;

    // 解析尺寸（支持像素和百分比）
    const parsedSize = this.parseSize(
      actualSize,
      mode.includes('left') || mode.includes('right') ? width : height
    );

    let primary: ViewBounds;
    let secondary: ViewBounds;

    switch (mode) {
      case 'split-left':
        // browserView 在左侧
        secondary = { x, y, width: parsedSize, height };
        primary = { x: x + parsedSize, y, width: width - parsedSize, height };
        break;

      case 'split-right':
        // browserView 在右侧
        primary = { x, y, width: width - parsedSize, height };
        secondary = { x: x + width - parsedSize, y, width: parsedSize, height };
        break;

      case 'split-top':
        // browserView 在上方
        secondary = { x, y, width, height: parsedSize };
        primary = { x, y: y + parsedSize, width, height: height - parsedSize };
        break;

      case 'split-bottom':
        // browserView 在下方
        primary = { x, y, width, height: height - parsedSize };
        secondary = { x, y: y + height - parsedSize, width, height: parsedSize };
        break;

      default:
        throw new Error(`Unknown split mode: ${mode}`);
    }

    // ✅ 结果验证：确保计算出的边界合理
    this.validateSplitResult(primary, secondary, containerBounds, mode);

    return { primary, secondary };
  }

  /**
   * ✅ 验证分栏布局结果
   * 确保计算出的边界合理，不会导致视图不可见或重叠
   */
  private static validateSplitResult(
    primary: ViewBounds,
    secondary: ViewBounds,
    container: ViewBounds,
    mode: string
  ): void {
    // 检查宽度和高度是否为正数且不小于最小值
    if (primary.width < MIN_VIEW_SIZE || primary.height < MIN_VIEW_SIZE) {
      console.error(`❌ Invalid primary view bounds:`, primary);
      throw new Error(
        `Primary view too small: ${primary.width}x${primary.height} (min: ${MIN_VIEW_SIZE}px)`
      );
    }

    if (secondary.width < MIN_VIEW_SIZE || secondary.height < MIN_VIEW_SIZE) {
      console.error(`❌ Invalid secondary view bounds:`, secondary);
      throw new Error(
        `Secondary view too small: ${secondary.width}x${secondary.height} (min: ${MIN_VIEW_SIZE}px)`
      );
    }

    // 检查是否超出容器边界
    const isHorizontalSplit = mode.includes('left') || mode.includes('right');
    const totalSize = isHorizontalSplit
      ? primary.width + secondary.width
      : primary.height + secondary.height;

    const containerSize = isHorizontalSplit ? container.width : container.height;

    // 允许 1px 的误差（由于 Math.floor）
    if (Math.abs(totalSize - containerSize) > 1) {
      console.warn(
        `⚠️ Split layout total size mismatch: ${totalSize} vs ${containerSize} (mode: ${mode})`
      );
    }
  }

  /**
   * 解析尺寸字符串（支持像素和百分比）
   * 自动验证和限制范围，确保结果在合理范围内
   */
  private static parseSize(size: number | string, containerSize: number): number {
    let parsedValue: number;

    if (typeof size === 'number') {
      parsedValue = size;
    } else if (size.endsWith('%')) {
      const percent = parseFloat(size);
      if (isNaN(percent)) {
        console.warn(`⚠️ Invalid percentage value: ${size}, using ${DEFAULT_SPLIT_SIZE}`);
        parsedValue = Math.floor(containerSize * 0.5);
      } else {
        parsedValue = Math.floor((containerSize * percent) / 100);
      }
    } else if (size.endsWith('px')) {
      const pixels = parseInt(size);
      parsedValue = isNaN(pixels) ? Math.floor(containerSize * 0.5) : pixels;
    } else {
      const parsed = parseInt(size);
      parsedValue = isNaN(parsed) ? Math.floor(containerSize * 0.5) : parsed;
    }

    // ✅ 边界值验证：确保在合理范围内
    // 最小值：MIN_VIEW_SIZE（保证视图可见）
    // 最大值：containerSize - MIN_VIEW_SIZE（保证两个视图都可见）
    const maxSize = Math.max(containerSize - MIN_VIEW_SIZE, MIN_VIEW_SIZE);

    const clampedValue = Math.max(MIN_VIEW_SIZE, Math.min(parsedValue, maxSize));

    if (clampedValue !== parsedValue) {
      console.warn(
        `⚠️ Split size clamped: ${parsedValue}px -> ${clampedValue}px (container: ${containerSize}px)`
      );
    }

    return clampedValue;
  }
}

/**
 * ✨ 分栏布局配置
 */
export interface SplitLayoutConfig {
  mode: 'split-left' | 'split-right' | 'split-top' | 'split-bottom';
  size?: number | string; // 300, '300px', '40%'
}

/**
 * ✨ 分栏布局结果（两个视图的边界）
 */
export interface SplitLayoutResult {
  primary: ViewBounds; // 主视图（pageView）的边界
  secondary: ViewBounds; // 次视图（browserView）的边界
}
