/**
 * 布局计算引擎
 * 负责根据语义化布局模式计算插件视图的实际边界
 *
 * 🔽 从 src/main/layout-calculator.ts 下沉到 src/core/layout
 * 原因：被 src/core/browser-pool/utils.ts 引用，消除 core→main 反向依赖
 */

import { Rectangle } from 'electron';
import { ACTIVITY_BAR_WIDTH, MIN_VIEW_SIZE } from '../../constants/layout';
import { createLogger } from '../logger';

const logger = createLogger('LayoutCalculator');

export interface WindowInfo {
  width: number;
  height: number;
  activityBarWidth: number;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class LayoutCalculator {
  static calculateFullBounds(windowInfo: WindowInfo): ViewBounds {
    const { width: windowWidth, height: windowHeight, activityBarWidth } = windowInfo;
    return {
      x: activityBarWidth,
      y: 0,
      width: windowWidth - activityBarWidth,
      height: windowHeight,
    };
  }

  static getWindowInfo(windowBounds: Rectangle, activityBarWidth = ACTIVITY_BAR_WIDTH): WindowInfo {
    return {
      width: windowBounds.width,
      height: windowBounds.height,
      activityBarWidth,
    };
  }

  static calculateSplitLayout(
    splitConfig: SplitLayoutConfig,
    containerBounds: ViewBounds
  ): SplitLayoutResult {
    const { mode, size } = splitConfig;
    const { x, y, width, height } = containerBounds;
    const defaultSize = mode.includes('left') || mode.includes('right') ? '40%' : '300px';
    const actualSize = size !== undefined ? size : defaultSize;
    const parsedSize = this.parseSize(
      actualSize,
      mode.includes('left') || mode.includes('right') ? width : height
    );

    let primary: ViewBounds;
    let secondary: ViewBounds;

    switch (mode) {
      case 'split-left':
        secondary = { x, y, width: parsedSize, height };
        primary = { x: x + parsedSize, y, width: width - parsedSize, height };
        break;
      case 'split-right':
        primary = { x, y, width: width - parsedSize, height };
        secondary = { x: x + width - parsedSize, y, width: parsedSize, height };
        break;
      case 'split-top':
        secondary = { x, y, width, height: parsedSize };
        primary = { x, y: y + parsedSize, width, height: height - parsedSize };
        break;
      case 'split-bottom':
        primary = { x, y, width, height: height - parsedSize };
        secondary = { x, y: y + height - parsedSize, width, height: parsedSize };
        break;
      default:
        throw new Error(`Unknown split mode: ${mode}`);
    }

    this.validateSplitResult(primary, secondary, containerBounds, mode);
    return { primary, secondary };
  }

  private static validateSplitResult(
    primary: ViewBounds,
    secondary: ViewBounds,
    container: ViewBounds,
    mode: string
  ): void {
    if (primary.width < MIN_VIEW_SIZE || primary.height < MIN_VIEW_SIZE) {
      throw new Error(
        `Primary view too small: ${primary.width}x${primary.height} (min: ${MIN_VIEW_SIZE}px)`
      );
    }
    if (secondary.width < MIN_VIEW_SIZE || secondary.height < MIN_VIEW_SIZE) {
      throw new Error(
        `Secondary view too small: ${secondary.width}x${secondary.height} (min: ${MIN_VIEW_SIZE}px)`
      );
    }

    const isHorizontalSplit = mode.includes('left') || mode.includes('right');
    const totalSize = isHorizontalSplit
      ? primary.width + secondary.width
      : primary.height + secondary.height;
    const containerSize = isHorizontalSplit ? container.width : container.height;

    if (Math.abs(totalSize - containerSize) > 1) {
      logger.warn('Split layout total size mismatch', {
        totalSize,
        containerSize,
        mode,
      });
    }
  }

  private static parseSize(size: number | string, containerSize: number): number {
    let parsedValue: number;

    if (typeof size === 'number') {
      parsedValue = size;
    } else if (size.endsWith('%')) {
      const percent = parseFloat(size);
      parsedValue = isNaN(percent)
        ? Math.floor(containerSize * 0.5)
        : Math.floor((containerSize * percent) / 100);
    } else if (size.endsWith('px')) {
      const pixels = parseInt(size);
      parsedValue = isNaN(pixels) ? Math.floor(containerSize * 0.5) : pixels;
    } else {
      const parsed = parseInt(size);
      parsedValue = isNaN(parsed) ? Math.floor(containerSize * 0.5) : parsed;
    }

    const maxSize = Math.max(containerSize - MIN_VIEW_SIZE, MIN_VIEW_SIZE);
    const clampedValue = Math.max(MIN_VIEW_SIZE, Math.min(parsedValue, maxSize));

    if (clampedValue !== parsedValue) {
      logger.warn('Split size clamped', {
        parsedValue,
        clampedValue,
        containerSize,
      });
    }

    return clampedValue;
  }
}

export interface SplitLayoutConfig {
  mode: 'split-left' | 'split-right' | 'split-top' | 'split-bottom';
  size?: number | string;
}

export interface SplitLayoutResult {
  primary: ViewBounds;
  secondary: ViewBounds;
}
