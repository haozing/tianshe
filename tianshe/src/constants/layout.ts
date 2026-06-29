/**
 * 布局相关常量配置
 * 集中管理所有布局尺寸，便于维护和调整
 */

/**
 * Activity Bar（左侧导航栏）的宽度（单位：px）
 *
 * 影响范围：
 * - 主窗口内容区域的 x 偏移量
 * - 插件视图的可用宽度计算
 * - 前端组件的宽度样式（对应 Tailwind 的 w-12）
 *
 * 注意：此值必须与前端 ActivityBar 组件的 Tailwind 类 w-12 (48px) 保持一致
 */
/**
 * Activity Bar（左侧导航栏）的宽度（单位：px）
 *
 * 注意：这是“折叠态”的宽度，需要与前端 ActivityBar 的 `w-12` (48px) 保持一致。
 * 展开态宽度请使用 ACTIVITY_BAR_WIDTH_EXPANDED。
 */
export const ACTIVITY_BAR_WIDTH = 48;

/**
 * Activity Bar（展开态）的宽度（单位：px）
 *
 * 需要与前端 ActivityBar 的 `w-40` (160px) 保持一致。
 */
export const ACTIVITY_BAR_WIDTH_EXPANDED = 160;

/**
 * 默认的顶部栏高度（单位：px）
 * 当前版本采用 Activity Bar 布局，没有顶部栏
 */
export const TOP_BAR_HEIGHT = 0;

/**
 * Windows 原生标题栏覆盖层高度（单位：px）
 *
 * 需要与 BrowserWindow 的 `titleBarOverlay.height` 保持一致。
 */
export const WINDOWS_TITLEBAR_OVERLAY_HEIGHT = 44;

/**
 * Renderer 顶部边框预留高度（单位：px）
 *
 * 说明：
 * - 主界面 React 容器使用了 `border-t`（通常为 1px）。
 * - WebContentsView 会叠加在 renderer 上方，如果 y=0 会覆盖这条顶部边框，导致“插件页顶部缺少边框/不贴合”。
 * - 将主窗口中 WebContentsView 的 bounds.y 下移该像素值即可露出边框。
 */
export const RENDERER_TOP_INSET = 1;

/**
 * 浏览器导航默认超时时间（单位：ms）
 */
export const DEFAULT_BROWSER_TIMEOUT = 60000;

/**
 * 视图最小尺寸（单位：px）
 * 用于分栏布局时确保视图可见
 */
export const MIN_VIEW_SIZE = 50;

/**
 * WebContentsView 池最大容量
 */
export const DEFAULT_MAX_POOL_SIZE = 15;

/**
 * 分栏布局默认尺寸
 */
export const DEFAULT_SPLIT_SIZE = '50%';

/**
 * 默认窗口尺寸（用于降级场景的参考值）
 */
const DEFAULT_WINDOW_WIDTH = 1920;
const DEFAULT_WINDOW_HEIGHT = 1080;

/**
 * 默认的插件视图边界（用于降级场景）
 *
 * 注意：实际边界应该根据窗口大小和插件配置动态计算
 * 这些值仅用于：
 * 1. 窗口信息不可用时的降级处理
 * 2. 开发时的参考值
 */
export const DEFAULT_VIEW_BOUNDS = {
  x: ACTIVITY_BAR_WIDTH,
  y: TOP_BAR_HEIGHT,
  // 宽度和高度应该动态计算，这里仅作为参考
  width: DEFAULT_WINDOW_WIDTH - ACTIVITY_BAR_WIDTH, // 1920 - 48 = 1872
  height: DEFAULT_WINDOW_HEIGHT - TOP_BAR_HEIGHT, // 1080 - 0 = 1080
} as const;
