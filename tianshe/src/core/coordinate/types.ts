/**
 * 坐标系统类型定义
 *
 * 支持多种坐标空间的转换：
 * - screen: 屏幕绝对坐标（用于 RobotJS/OCR）
 * - window: 窗口相对坐标
 * - viewport: 视口相对坐标（用于 Electron sendInputEvent）
 * - document: 文档坐标（含滚动偏移）
 * - normalized: 归一化百分比坐标 (0-100)
 * - anchored: 锚点相对坐标
 */

// ============================================================================
// 坐标空间
// ============================================================================

/**
 * 坐标空间类型
 */
export type CoordinateSpace =
  | 'screen' // 屏幕绝对坐标
  | 'window' // 窗口相对坐标
  | 'viewport' // 视口相对坐标
  | 'document' // 文档坐标（含滚动）
  | 'normalized' // 归一化百分比 (0-100)
  | 'anchored'; // 锚点相对坐标

// ============================================================================
// 比例定义
// ============================================================================

/**
 * 标准宽高比
 */
export const ASPECT_RATIOS = {
  '16:9': 16 / 9, // 1920×1080, 1280×720, 2560×1440
  '16:10': 16 / 10, // 1920×1200, 1680×1050, 1440×900
  '4:3': 4 / 3, // 1024×768, 1280×960
  '21:9': 21 / 9, // 2560×1080, 3440×1440 (超宽屏)
  '32:9': 32 / 9, // 5120×1440 (超超宽屏)
} as const;

export type AspectRatioName = keyof typeof ASPECT_RATIOS;

/**
 * 根据宽高计算比例名称
 */
export function detectAspectRatio(width: number, height: number): AspectRatioName | null {
  const ratio = width / height;
  const tolerance = 0.01;

  for (const [name, value] of Object.entries(ASPECT_RATIOS)) {
    if (Math.abs(ratio - value) < tolerance) {
      return name as AspectRatioName;
    }
  }

  return null;
}

// ============================================================================
// 点坐标
// ============================================================================

/**
 * 基础点坐标
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * 带坐标空间标识的点
 */
export interface TypedPoint extends Point {
  space: CoordinateSpace;
}

/**
 * 屏幕坐标点
 */
export interface ScreenPoint extends Point {
  space: 'screen';
}

/**
 * 窗口坐标点
 */
export interface WindowPoint extends Point {
  space: 'window';
}

/**
 * 视口坐标点
 */
export interface ViewportPoint extends Point {
  space: 'viewport';
}

/**
 * 文档坐标点
 */
export interface DocumentPoint extends Point {
  space: 'document';
}

/**
 * 归一化坐标点 (0-100)
 */
export interface NormalizedPoint extends Point {
  space: 'normalized';
}

// ============================================================================
// 锚点系统
// ============================================================================

/**
 * 锚点位置（九宫格）
 */
export type AnchorPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * 锚点坐标
 * 相对于锚点的百分比偏移，适合跨比例适配
 */
export interface AnchoredPoint {
  /** 锚点位置 */
  anchor: AnchorPosition;
  /** X 轴偏移（百分比，可正可负） */
  offsetX: number;
  /** Y 轴偏移（百分比，可正可负） */
  offsetY: number;
  /** 坐标空间标识 */
  space: 'anchored';
}

/**
 * 锚点适配策略
 *
 * - percentage: 百分比缩放（默认），偏移按视口尺寸百分比计算
 * - fixed-pixel: 固定像素偏移，保持相对于锚点的像素距离不变
 * - anchor-aware: 锚点感知，根据锚点类型智能选择策略
 */
export type AnchorAdaptStrategy = 'percentage' | 'fixed-pixel' | 'anchor-aware';

/**
 * 录制的锚点（包含源视口信息）
 * 用于跨分辨率脚本录制和回放
 */
export interface RecordedAnchor {
  /** 锚点坐标 */
  point: AnchoredPoint;
  /** 源视口配置（录制时的视口） */
  sourceViewport: ViewportConfig;
  /** 录制时间戳 */
  timestamp?: number;
}

// ============================================================================
// 边界/区域
// ============================================================================

/**
 * 基础边界
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 带坐标空间标识的边界
 */
export interface TypedBounds extends Bounds {
  space: CoordinateSpace;
}

/**
 * 屏幕边界
 */
export interface ScreenBounds extends Bounds {
  space: 'screen';
}

/**
 * 视口边界
 */
export interface ViewportBounds extends Bounds {
  space: 'viewport';
}

/**
 * 归一化边界 (0-100)
 */
export interface NormalizedBounds extends Bounds {
  space: 'normalized';
}

// ============================================================================
// 视口配置
// ============================================================================

/**
 * 视口配置
 */
export interface ViewportConfig {
  /** 视口宽度（像素） */
  width: number;
  /** 视口高度（像素） */
  height: number;
  /** 宽高比（自动计算） */
  aspectRatio: number;
  /** 设备像素比（用于高 DPI 屏幕） */
  devicePixelRatio: number;
}

/**
 * 创建视口配置
 */
export function createViewportConfig(
  width: number,
  height: number,
  devicePixelRatio: number = 1
): ViewportConfig {
  return {
    width,
    height,
    aspectRatio: width / height,
    devicePixelRatio,
  };
}

// ============================================================================
// 转换上下文
// ============================================================================

/**
 * 坐标转换上下文
 * 包含所有坐标空间转换所需的信息
 */
export interface TransformContext {
  /** 视口配置 */
  viewport: ViewportConfig;

  /** 窗口在屏幕中的位置 */
  windowPosition: Point;

  /** 视口在窗口中的偏移（减去标题栏、工具栏等） */
  viewportOffset: Point;

  /** 文档滚动偏移 */
  scrollOffset: Point;
}

/**
 * 创建默认转换上下文
 */
export function createDefaultTransformContext(): TransformContext {
  return {
    viewport: createViewportConfig(1920, 1080),
    windowPosition: { x: 0, y: 0 },
    viewportOffset: { x: 0, y: 0 },
    scrollOffset: { x: 0, y: 0 },
  };
}

// ============================================================================
// 工具类型
// ============================================================================

/**
 * 点类型守卫
 */
export function isNormalizedPoint(point: TypedPoint): point is NormalizedPoint {
  return point.space === 'normalized';
}

export function isAnchoredPoint(point: TypedPoint | AnchoredPoint): point is AnchoredPoint {
  return 'anchor' in point && point.space === 'anchored';
}

export function isScreenPoint(point: TypedPoint): point is ScreenPoint {
  return point.space === 'screen';
}

export function isViewportPoint(point: TypedPoint): point is ViewportPoint {
  return point.space === 'viewport';
}

/**
 * 创建各类型点的工厂函数
 */
export function createNormalizedPoint(x: number, y: number): NormalizedPoint {
  return { x, y, space: 'normalized' };
}

export function createScreenPoint(x: number, y: number): ScreenPoint {
  return { x, y, space: 'screen' };
}

export function createViewportPoint(x: number, y: number): ViewportPoint {
  return { x, y, space: 'viewport' };
}

export function createAnchoredPoint(
  anchor: AnchorPosition,
  offsetX: number = 0,
  offsetY: number = 0
): AnchoredPoint {
  return { anchor, offsetX, offsetY, space: 'anchored' };
}

/**
 * 创建各类型边界的工厂函数
 */
export function createNormalizedBounds(
  x: number,
  y: number,
  width: number,
  height: number
): NormalizedBounds {
  return { x, y, width, height, space: 'normalized' };
}

export function createViewportBounds(
  x: number,
  y: number,
  width: number,
  height: number
): ViewportBounds {
  return { x, y, width, height, space: 'viewport' };
}

export function createScreenBounds(
  x: number,
  y: number,
  width: number,
  height: number
): ScreenBounds {
  return { x, y, width, height, space: 'screen' };
}
