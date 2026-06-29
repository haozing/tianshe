/**
 * 锚点系统
 *
 * 提供基于锚点的坐标定位，适合跨比例适配场景。
 * 锚点是视口中的九个关键位置（九宫格），
 * 相对于锚点的偏移在不同比例下更稳定。
 */

import type {
  AnchorPosition,
  AnchoredPoint,
  AnchorAdaptStrategy,
  Point,
  RecordedAnchor,
  ViewportConfig,
} from './types';

/**
 * 锚点系统工具类
 */
export class AnchorSystem {
  /**
   * 获取锚点在视口中的绝对位置
   *
   * @param anchor 锚点位置
   * @param viewport 视口配置
   * @returns 锚点的绝对坐标（像素）
   */
  static getAnchorPosition(anchor: AnchorPosition, viewport: ViewportConfig): Point {
    const { width, height } = viewport;

    // 计算锚点的 X 坐标
    let x: number;
    if (anchor.includes('left')) {
      x = 0;
    } else if (anchor.includes('right')) {
      x = width;
    } else {
      x = width / 2;
    }

    // 计算锚点的 Y 坐标
    let y: number;
    if (anchor.includes('top')) {
      y = 0;
    } else if (anchor.includes('bottom')) {
      y = height;
    } else {
      y = height / 2;
    }

    return { x, y };
  }

  /**
   * 将绝对坐标转换为锚点相对坐标
   *
   * @param point 绝对坐标（像素）
   * @param viewport 视口配置
   * @param preferredAnchor 指定锚点，如果不指定则自动选择最近的锚点
   * @returns 锚点相对坐标
   */
  static toAnchoredPoint(
    point: Point,
    viewport: ViewportConfig,
    preferredAnchor?: AnchorPosition
  ): AnchoredPoint {
    const anchor = preferredAnchor ?? this.findNearestAnchor(point, viewport);
    const anchorPos = this.getAnchorPosition(anchor, viewport);

    // 计算相对于锚点的百分比偏移
    const offsetX = ((point.x - anchorPos.x) / viewport.width) * 100;
    const offsetY = ((point.y - anchorPos.y) / viewport.height) * 100;

    return {
      anchor,
      offsetX,
      offsetY,
      space: 'anchored',
    };
  }

  /**
   * 将锚点相对坐标转换为绝对坐标
   *
   * @param anchored 锚点相对坐标
   * @param viewport 视口配置
   * @returns 绝对坐标（像素）
   */
  static fromAnchoredPoint(anchored: AnchoredPoint, viewport: ViewportConfig): Point {
    const anchorPos = this.getAnchorPosition(anchored.anchor, viewport);

    // 将百分比偏移转换为像素偏移
    const x = anchorPos.x + (anchored.offsetX / 100) * viewport.width;
    const y = anchorPos.y + (anchored.offsetY / 100) * viewport.height;

    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * 查找距离给定点最近的锚点
   *
   * @param point 目标点
   * @param viewport 视口配置
   * @returns 最近的锚点位置
   */
  static findNearestAnchor(point: Point, viewport: ViewportConfig): AnchorPosition {
    const anchors: AnchorPosition[] = [
      'top-left',
      'top-center',
      'top-right',
      'center-left',
      'center',
      'center-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ];

    let nearestAnchor: AnchorPosition = 'center';
    let minDistance = Infinity;

    for (const anchor of anchors) {
      const anchorPos = this.getAnchorPosition(anchor, viewport);
      const distance = Math.sqrt(
        Math.pow(point.x - anchorPos.x, 2) + Math.pow(point.y - anchorPos.y, 2)
      );

      if (distance < minDistance) {
        minDistance = distance;
        nearestAnchor = anchor;
      }
    }

    return nearestAnchor;
  }

  /**
   * 计算两个锚点坐标之间的相对距离
   *
   * @param point1 锚点坐标 1
   * @param point2 锚点坐标 2
   * @param viewport 视口配置（用于计算实际像素距离）
   * @returns 像素距离
   */
  static distance(point1: AnchoredPoint, point2: AnchoredPoint, viewport: ViewportConfig): number {
    const abs1 = this.fromAnchoredPoint(point1, viewport);
    const abs2 = this.fromAnchoredPoint(point2, viewport);

    return Math.sqrt(Math.pow(abs1.x - abs2.x, 2) + Math.pow(abs1.y - abs2.y, 2));
  }

  /**
   * 获取所有锚点位置
   *
   * @param viewport 视口配置
   * @returns 所有锚点的位置映射
   */
  static getAllAnchorPositions(viewport: ViewportConfig): Map<AnchorPosition, Point> {
    const anchors: AnchorPosition[] = [
      'top-left',
      'top-center',
      'top-right',
      'center-left',
      'center',
      'center-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ];

    const result = new Map<AnchorPosition, Point>();
    for (const anchor of anchors) {
      result.set(anchor, this.getAnchorPosition(anchor, viewport));
    }

    return result;
  }

  /**
   * 判断一个点是否在某个锚点的"影响区域"内
   *
   * 影响区域是以锚点为中心，视口宽高各 1/3 的矩形
   *
   * @param point 目标点
   * @param anchor 锚点
   * @param viewport 视口配置
   * @returns 是否在影响区域内
   */
  static isInAnchorZone(point: Point, anchor: AnchorPosition, viewport: ViewportConfig): boolean {
    const anchorPos = this.getAnchorPosition(anchor, viewport);
    const zoneWidth = viewport.width / 3;
    const zoneHeight = viewport.height / 3;

    return (
      Math.abs(point.x - anchorPos.x) <= zoneWidth / 2 &&
      Math.abs(point.y - anchorPos.y) <= zoneHeight / 2
    );
  }

  // ============================================================================
  // 跨视口适配
  // ============================================================================

  /**
   * 跨视口适配锚点坐标
   *
   * 根据策略将源视口的锚点坐标适配到目标视口
   *
   * @param anchored 源锚点坐标
   * @param sourceViewport 源视口配置
   * @param targetViewport 目标视口配置
   * @param strategy 适配策略，默认 'anchor-aware'
   * @returns 适配后的锚点坐标
   *
   * @example
   * ```typescript
   * const source = { width: 1920, height: 1080, aspectRatio: 16/9, devicePixelRatio: 1 };
   * const target = { width: 1280, height: 800, aspectRatio: 16/10, devicePixelRatio: 1 };
   *
   * const closeButton: AnchoredPoint = {
   *   anchor: 'top-right',
   *   offsetX: -1.04,  // 约 -20px
   *   offsetY: 0.93,   // 约 10px
   *   space: 'anchored'
   * };
   *
   * const adapted = AnchorSystem.adaptAcrossViewport(closeButton, source, target);
   * // 使用 anchor-aware，角落锚点会保持固定像素距离
   * ```
   */
  static adaptAcrossViewport(
    anchored: AnchoredPoint,
    sourceViewport: ViewportConfig,
    targetViewport: ViewportConfig,
    strategy: AnchorAdaptStrategy = 'anchor-aware'
  ): AnchoredPoint {
    switch (strategy) {
      case 'percentage':
        return this.adaptPercentage(anchored);

      case 'fixed-pixel':
        return this.adaptFixedPixel(anchored, sourceViewport, targetViewport);

      case 'anchor-aware':
      default:
        return this.adaptAnchorAware(anchored, sourceViewport, targetViewport);
    }
  }

  /**
   * 根据锚点类型推荐适配策略
   *
   * - 角落锚点 → fixed-pixel（保持边距）
   * - 边缘锚点 → anchor-aware（混合策略）
   * - 中心锚点 → percentage（等比缩放）
   *
   * @param anchor 锚点位置
   * @returns 推荐的适配策略
   */
  static recommendStrategy(anchor: AnchorPosition): AnchorAdaptStrategy {
    // 角落锚点：固定像素
    const isCorner =
      anchor === 'top-left' ||
      anchor === 'top-right' ||
      anchor === 'bottom-left' ||
      anchor === 'bottom-right';

    if (isCorner) {
      return 'fixed-pixel';
    }

    // 中心锚点：百分比
    if (anchor === 'center') {
      return 'percentage';
    }

    // 边缘锚点：锚点感知
    return 'anchor-aware';
  }

  // ============================================================================
  // 私有适配方法
  // ============================================================================

  /**
   * 百分比适配（默认行为）
   * 偏移保持不变，因为已经是百分比
   */
  private static adaptPercentage(anchored: AnchoredPoint): AnchoredPoint {
    return { ...anchored };
  }

  /**
   * 固定像素适配
   * 将源视口的像素偏移保持到目标视口
   */
  private static adaptFixedPixel(
    anchored: AnchoredPoint,
    sourceViewport: ViewportConfig,
    targetViewport: ViewportConfig
  ): AnchoredPoint {
    // 计算源视口中的像素偏移
    const sourcePixelOffsetX = (anchored.offsetX / 100) * sourceViewport.width;
    const sourcePixelOffsetY = (anchored.offsetY / 100) * sourceViewport.height;

    // 转换为目标视口的百分比偏移（保持像素值不变）
    let targetOffsetX = (sourcePixelOffsetX / targetViewport.width) * 100;
    let targetOffsetY = (sourcePixelOffsetY / targetViewport.height) * 100;

    // 边界保护：如果适配后超出视口，回退到百分比策略
    const targetPoint = this.fromAnchoredPoint(
      { ...anchored, offsetX: targetOffsetX, offsetY: targetOffsetY },
      targetViewport
    );

    if (
      targetPoint.x < 0 ||
      targetPoint.x > targetViewport.width ||
      targetPoint.y < 0 ||
      targetPoint.y > targetViewport.height
    ) {
      // 回退到百分比策略
      return this.adaptPercentage(anchored);
    }

    return {
      anchor: anchored.anchor,
      offsetX: targetOffsetX,
      offsetY: targetOffsetY,
      space: 'anchored',
    };
  }

  /**
   * 锚点感知适配
   * 根据锚点类型智能选择适配策略
   */
  private static adaptAnchorAware(
    anchored: AnchoredPoint,
    sourceViewport: ViewportConfig,
    targetViewport: ViewportConfig
  ): AnchoredPoint {
    const { anchor } = anchored;

    // 角落锚点：固定像素
    if (
      anchor === 'top-left' ||
      anchor === 'top-right' ||
      anchor === 'bottom-left' ||
      anchor === 'bottom-right'
    ) {
      return this.adaptFixedPixel(anchored, sourceViewport, targetViewport);
    }

    // 中心锚点：百分比
    if (anchor === 'center') {
      return this.adaptPercentage(anchored);
    }

    // 水平边缘锚点 (top-center, bottom-center)：X 百分比，Y 固定像素
    if (anchor === 'top-center' || anchor === 'bottom-center') {
      const sourcePixelOffsetY = (anchored.offsetY / 100) * sourceViewport.height;
      let targetOffsetY = (sourcePixelOffsetY / targetViewport.height) * 100;

      // Y 方向边界检查
      const testPoint = this.fromAnchoredPoint(
        { ...anchored, offsetY: targetOffsetY },
        targetViewport
      );
      if (testPoint.y < 0 || testPoint.y > targetViewport.height) {
        targetOffsetY = anchored.offsetY; // 回退到百分比
      }

      return {
        anchor: anchored.anchor,
        offsetX: anchored.offsetX, // X 保持百分比
        offsetY: targetOffsetY, // Y 尝试固定像素
        space: 'anchored',
      };
    }

    // 垂直边缘锚点 (center-left, center-right)：X 固定像素，Y 百分比
    if (anchor === 'center-left' || anchor === 'center-right') {
      const sourcePixelOffsetX = (anchored.offsetX / 100) * sourceViewport.width;
      let targetOffsetX = (sourcePixelOffsetX / targetViewport.width) * 100;

      // X 方向边界检查
      const testPoint = this.fromAnchoredPoint(
        { ...anchored, offsetX: targetOffsetX },
        targetViewport
      );
      if (testPoint.x < 0 || testPoint.x > targetViewport.width) {
        targetOffsetX = anchored.offsetX; // 回退到百分比
      }

      return {
        anchor: anchored.anchor,
        offsetX: targetOffsetX, // X 尝试固定像素
        offsetY: anchored.offsetY, // Y 保持百分比
        space: 'anchored',
      };
    }

    // 默认：百分比
    return this.adaptPercentage(anchored);
  }
}

// ============================================================================
// 锚点录制器
// ============================================================================

/**
 * 锚点录制器
 *
 * 用于跨分辨率脚本录制和回放：
 * - 在录制时记住源视口信息
 * - 在回放时自动适配到目标视口
 *
 * @example
 * ```typescript
 * // 录制阶段
 * const recorder = new AnchorRecorder({ width: 1920, height: 1080, aspectRatio: 16/9, devicePixelRatio: 1 });
 * const recorded = recorder.record({ x: 1900, y: 20 }, 'top-right');
 *
 * // 回放阶段
 * const targetViewport = { width: 1280, height: 800, aspectRatio: 16/10, devicePixelRatio: 1 };
 * const adapted = recorder.adapt(recorded, targetViewport);
 * await browser.clickAtAnchored(adapted);
 * ```
 */
export class AnchorRecorder {
  private sourceViewport: ViewportConfig;

  constructor(sourceViewport: ViewportConfig) {
    this.sourceViewport = sourceViewport;
  }

  /**
   * 获取源视口配置
   */
  getSourceViewport(): ViewportConfig {
    return { ...this.sourceViewport };
  }

  /**
   * 更新源视口配置
   */
  setSourceViewport(viewport: ViewportConfig): void {
    this.sourceViewport = { ...viewport };
  }

  /**
   * 录制一个点位
   *
   * @param point 视口坐标
   * @param anchor 指定锚点，不指定则自动选择最近的
   * @returns 包含源视口信息的录制结果
   */
  record(point: Point, anchor?: AnchorPosition): RecordedAnchor {
    const anchoredPoint = AnchorSystem.toAnchoredPoint(point, this.sourceViewport, anchor);

    return {
      point: anchoredPoint,
      sourceViewport: { ...this.sourceViewport },
      timestamp: Date.now(),
    };
  }

  /**
   * 适配到目标视口
   *
   * @param recorded 录制的锚点
   * @param targetViewport 目标视口配置
   * @param strategy 适配策略，默认 'anchor-aware'
   * @returns 适配后的锚点坐标
   */
  adapt(
    recorded: RecordedAnchor,
    targetViewport: ViewportConfig,
    strategy: AnchorAdaptStrategy = 'anchor-aware'
  ): AnchoredPoint {
    return AnchorSystem.adaptAcrossViewport(
      recorded.point,
      recorded.sourceViewport,
      targetViewport,
      strategy
    );
  }

  /**
   * 批量适配
   *
   * @param records 录制的锚点数组
   * @param targetViewport 目标视口配置
   * @param strategy 适配策略
   * @returns 适配后的锚点坐标数组
   */
  adaptAll(
    records: RecordedAnchor[],
    targetViewport: ViewportConfig,
    strategy: AnchorAdaptStrategy = 'anchor-aware'
  ): AnchoredPoint[] {
    return records.map((record) => this.adapt(record, targetViewport, strategy));
  }

  /**
   * 将录制结果转换为视口坐标（用于回放）
   *
   * @param recorded 录制的锚点
   * @param targetViewport 目标视口配置
   * @param strategy 适配策略
   * @returns 目标视口中的像素坐标
   */
  toViewportPoint(
    recorded: RecordedAnchor,
    targetViewport: ViewportConfig,
    strategy: AnchorAdaptStrategy = 'anchor-aware'
  ): Point {
    const adapted = this.adapt(recorded, targetViewport, strategy);
    return AnchorSystem.fromAnchoredPoint(adapted, targetViewport);
  }
}
