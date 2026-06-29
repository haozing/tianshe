/**
 * 坐标系统模块
 *
 * 提供多坐标空间支持和转换功能：
 * - Screen: 屏幕绝对坐标（用于系统级自动化）
 * - Window: 窗口相对坐标
 * - Viewport: 视口相对坐标（用于浏览器自动化）
 * - Document: 文档坐标（含滚动偏移）
 * - Normalized: 归一化百分比坐标 (0-100)
 * - Anchored: 锚点相对坐标（跨比例适配）
 *
 * @example
 * ```typescript
 * import {
 *   CoordinateTransformer,
 *   TransformContextManager,
 *   AnchorSystem,
 *   createNormalizedPoint,
 * } from './coordinate';
 *
 * // 创建转换器
 * const transformer = CoordinateTransformer.fromViewport(1920, 1080);
 *
 * // 归一化坐标转视口坐标
 * const normalized = createNormalizedPoint(50, 50);
 * const viewport = transformer.normalizedToViewport(normalized);
 * // viewport = { x: 960, y: 540 }
 *
 * // 使用锚点坐标（跨比例更稳定）
 * const anchored = AnchorSystem.toAnchoredPoint(
 *   { x: 960, y: 540 },
 *   { width: 1920, height: 1080, aspectRatio: 16/9, devicePixelRatio: 1 }
 * );
 * // anchored = { anchor: 'center', offsetX: 0, offsetY: 0, space: 'anchored' }
 * ```
 */

// 类型导出
export type {
  // 坐标空间
  CoordinateSpace,
  AspectRatioName,
  // 点类型
  Point,
  TypedPoint,
  ScreenPoint,
  WindowPoint,
  ViewportPoint,
  DocumentPoint,
  NormalizedPoint,
  // 锚点
  AnchorPosition,
  AnchoredPoint,
  AnchorAdaptStrategy,
  RecordedAnchor,
  // 边界
  Bounds,
  TypedBounds,
  ScreenBounds,
  ViewportBounds,
  NormalizedBounds,
  // 配置
  ViewportConfig,
  TransformContext,
} from './types';

// 常量和工厂函数导出
export {
  ASPECT_RATIOS,
  detectAspectRatio,
  createViewportConfig,
  createDefaultTransformContext,
  // 类型守卫
  isNormalizedPoint,
  isAnchoredPoint,
  isScreenPoint,
  isViewportPoint,
  // 工厂函数
  createNormalizedPoint,
  createScreenPoint,
  createViewportPoint,
  createAnchoredPoint,
  createNormalizedBounds,
  createViewportBounds,
  createScreenBounds,
} from './types';

// 锚点系统
export { AnchorSystem, AnchorRecorder } from './anchor';

// 坐标转换器
export { CoordinateTransformer } from './transformer';

// 上下文管理器
export { TransformContextManager } from './context';
export type { BrowserLike } from './context';
