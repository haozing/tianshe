/**
 * 坐标转换器
 *
 * 提供不同坐标空间之间的转换功能：
 * - Screen ↔ Window ↔ Viewport ↔ Document
 * - Viewport ↔ Normalized (0-100)
 * - Viewport ↔ Anchored
 */

import { AnchorSystem } from './anchor';
import type {
  AnchoredPoint,
  AnchorPosition,
  Bounds,
  CoordinateSpace,
  NormalizedBounds,
  NormalizedPoint,
  Point,
  TransformContext,
  TypedBounds,
  TypedPoint,
  ViewportBounds,
} from './types';
import { createDefaultTransformContext, createNormalizedPoint } from './types';

/**
 * 坐标转换器
 *
 * @example
 * ```typescript
 * const transformer = new CoordinateTransformer(context);
 *
 * // 归一化坐标转视口坐标
 * const viewportPoint = transformer.normalizedToViewport({ x: 50, y: 50, space: 'normalized' });
 *
 * // 屏幕坐标转视口坐标
 * const point = transformer.screenToViewport({ x: 1000, y: 500 });
 * ```
 */
export class CoordinateTransformer {
  private context: TransformContext;

  constructor(context?: TransformContext) {
    this.context = context ?? createDefaultTransformContext();
  }

  /**
   * 获取当前转换上下文
   */
  getContext(): TransformContext {
    return { ...this.context };
  }

  /**
   * 更新转换上下文
   */
  updateContext(partial: Partial<TransformContext>): void {
    this.context = { ...this.context, ...partial };
  }

  /**
   * 设置完整的转换上下文
   */
  setContext(context: TransformContext): void {
    this.context = { ...context };
  }

  // ============================================================================
  // 核心转换方法
  // ============================================================================

  /**
   * 通用坐标转换
   *
   * @param point 源坐标
   * @param to 目标坐标空间
   * @returns 转换后的坐标
   */
  transform(point: TypedPoint, to: CoordinateSpace): TypedPoint {
    const { space: from } = point;

    if (from === to) {
      return { ...point };
    }

    // 先转换到视口坐标（作为中间格式）
    let viewportPoint: Point;

    switch (from) {
      case 'screen':
        viewportPoint = this.screenToViewport(point);
        break;
      case 'window':
        viewportPoint = this.windowToViewport(point);
        break;
      case 'viewport':
        viewportPoint = { x: point.x, y: point.y };
        break;
      case 'document':
        viewportPoint = this.documentToViewport(point);
        break;
      case 'normalized':
        viewportPoint = this.normalizedToViewport(point as NormalizedPoint);
        break;
      default:
        throw new Error(`Unsupported source coordinate space: ${from}`);
    }

    // 从视口坐标转换到目标空间
    switch (to) {
      case 'screen':
        return { ...this.viewportToScreen(viewportPoint), space: 'screen' };
      case 'window':
        return { ...this.viewportToWindow(viewportPoint), space: 'window' };
      case 'viewport':
        return { ...viewportPoint, space: 'viewport' };
      case 'document':
        return { ...this.viewportToDocument(viewportPoint), space: 'document' };
      case 'normalized':
        return this.viewportToNormalized(viewportPoint);
      default:
        throw new Error(`Unsupported target coordinate space: ${to}`);
    }
  }

  /**
   * 边界转换
   *
   * @param bounds 源边界
   * @param to 目标坐标空间
   * @returns 转换后的边界
   */
  transformBounds(bounds: TypedBounds, to: CoordinateSpace): TypedBounds {
    const topLeft = this.transform({ x: bounds.x, y: bounds.y, space: bounds.space }, to);

    const bottomRight = this.transform(
      {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
        space: bounds.space,
      },
      to
    );

    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
      space: to,
    };
  }

  // ============================================================================
  // Screen ↔ Viewport
  // ============================================================================

  /**
   * 屏幕坐标转视口坐标
   */
  screenToViewport(point: Point): Point {
    const { windowPosition, viewportOffset } = this.context;

    return {
      x: point.x - windowPosition.x - viewportOffset.x,
      y: point.y - windowPosition.y - viewportOffset.y,
    };
  }

  /**
   * 视口坐标转屏幕坐标
   */
  viewportToScreen(point: Point): Point {
    const { windowPosition, viewportOffset } = this.context;

    return {
      x: point.x + windowPosition.x + viewportOffset.x,
      y: point.y + windowPosition.y + viewportOffset.y,
    };
  }

  // ============================================================================
  // Window ↔ Viewport
  // ============================================================================

  /**
   * 窗口坐标转视口坐标
   */
  windowToViewport(point: Point): Point {
    const { viewportOffset } = this.context;

    return {
      x: point.x - viewportOffset.x,
      y: point.y - viewportOffset.y,
    };
  }

  /**
   * 视口坐标转窗口坐标
   */
  viewportToWindow(point: Point): Point {
    const { viewportOffset } = this.context;

    return {
      x: point.x + viewportOffset.x,
      y: point.y + viewportOffset.y,
    };
  }

  // ============================================================================
  // Document ↔ Viewport
  // ============================================================================

  /**
   * 文档坐标转视口坐标
   */
  documentToViewport(point: Point): Point {
    const { scrollOffset } = this.context;

    return {
      x: point.x - scrollOffset.x,
      y: point.y - scrollOffset.y,
    };
  }

  /**
   * 视口坐标转文档坐标
   */
  viewportToDocument(point: Point): Point {
    const { scrollOffset } = this.context;

    return {
      x: point.x + scrollOffset.x,
      y: point.y + scrollOffset.y,
    };
  }

  // ============================================================================
  // Normalized ↔ Viewport
  // ============================================================================

  /**
   * 归一化坐标 (0-100) 转视口坐标
   */
  normalizedToViewport(point: NormalizedPoint): Point {
    const { viewport } = this.context;

    return {
      x: Math.round((point.x / 100) * viewport.width),
      y: Math.round((point.y / 100) * viewport.height),
    };
  }

  /**
   * 视口坐标转归一化坐标 (0-100)
   */
  viewportToNormalized(point: Point): NormalizedPoint {
    const { viewport } = this.context;

    return createNormalizedPoint(
      (point.x / viewport.width) * 100,
      (point.y / viewport.height) * 100
    );
  }

  // ============================================================================
  // Anchored ↔ Viewport
  // ============================================================================

  /**
   * 锚点坐标转视口坐标
   */
  anchoredToViewport(point: AnchoredPoint): Point {
    return AnchorSystem.fromAnchoredPoint(point, this.context.viewport);
  }

  /**
   * 视口坐标转锚点坐标
   *
   * @param point 视口坐标
   * @param preferredAnchor 指定锚点，不指定则自动选择最近的
   */
  viewportToAnchored(point: Point, preferredAnchor?: AnchorPosition): AnchoredPoint {
    return AnchorSystem.toAnchoredPoint(point, this.context.viewport, preferredAnchor);
  }

  // ============================================================================
  // Normalized Bounds
  // ============================================================================

  /**
   * 归一化边界转视口边界
   */
  normalizedBoundsToViewport(bounds: NormalizedBounds): ViewportBounds {
    const { viewport } = this.context;

    return {
      x: Math.round((bounds.x / 100) * viewport.width),
      y: Math.round((bounds.y / 100) * viewport.height),
      width: Math.round((bounds.width / 100) * viewport.width),
      height: Math.round((bounds.height / 100) * viewport.height),
      space: 'viewport',
    };
  }

  /**
   * 视口边界转归一化边界
   */
  viewportBoundsToNormalized(bounds: Bounds): NormalizedBounds {
    const { viewport } = this.context;

    return {
      x: (bounds.x / viewport.width) * 100,
      y: (bounds.y / viewport.height) * 100,
      width: (bounds.width / viewport.width) * 100,
      height: (bounds.height / viewport.height) * 100,
      space: 'normalized',
    };
  }

  // ============================================================================
  // 便捷方法
  // ============================================================================

  /**
   * 计算边界的中心点
   */
  getBoundsCenter(bounds: Bounds): Point {
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  }

  /**
   * 计算边界的中心点（归一化坐标）
   */
  getBoundsCenterNormalized(bounds: Bounds): NormalizedPoint {
    const center = this.getBoundsCenter(bounds);
    return this.viewportToNormalized(center);
  }

  /**
   * 检查点是否在边界内
   */
  isPointInBounds(point: Point, bounds: Bounds): boolean {
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  }

  /**
   * 检查点是否在视口内
   */
  isPointInViewport(point: Point): boolean {
    const { viewport } = this.context;
    return point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height;
  }

  /**
   * 将点限制在视口范围内
   */
  clampToViewport(point: Point): Point {
    const { viewport } = this.context;
    return {
      x: Math.max(0, Math.min(point.x, viewport.width)),
      y: Math.max(0, Math.min(point.y, viewport.height)),
    };
  }

  /**
   * 将归一化坐标限制在 0-100 范围内
   */
  clampNormalized(point: NormalizedPoint): NormalizedPoint {
    return createNormalizedPoint(
      Math.max(0, Math.min(point.x, 100)),
      Math.max(0, Math.min(point.y, 100))
    );
  }

  // ============================================================================
  // 静态工厂方法
  // ============================================================================

  /**
   * 从视口尺寸创建转换器
   */
  static fromViewport(
    width: number,
    height: number,
    devicePixelRatio: number = 1
  ): CoordinateTransformer {
    return new CoordinateTransformer({
      viewport: { width, height, aspectRatio: width / height, devicePixelRatio },
      windowPosition: { x: 0, y: 0 },
      viewportOffset: { x: 0, y: 0 },
      scrollOffset: { x: 0, y: 0 },
    });
  }

  /**
   * 创建默认的 1920x1080 转换器
   */
  static createDefault(): CoordinateTransformer {
    return CoordinateTransformer.fromViewport(1920, 1080);
  }
}
