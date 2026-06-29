/**
 * 浏览器自动化模块
 *
 * 提供页面快照、元素操作、HTTP 拦截等自动化功能。
 * 这些功能从 browser-core 分离，作为可选的扩展功能。
 *
 * 核心导出：
 * - IntegratedBrowser: 完整功能的浏览器类（实现 BrowserInterface）
 * - 各种服务类: 用于按需组合
 *
 * 坐标系统请直接从 '../coordinate' 导入
 */

// 集成浏览器（完整功能）
export { IntegratedBrowser } from './integrated-browser';
export type { ScreenshotOptions } from '../../types/browser-interface';

// 页面快照和搜索
export { BrowserSnapshotService } from './snapshot';
export type { SnapshotDependencies } from './snapshot';
export type { NetworkFilter, NetworkSummary } from '../../types/browser-interface';

// HTTP 拦截
export { BrowserInterceptorService } from './interceptor';
export type { InterceptConfig, InterceptorDependencies } from './interceptor';

// 选择器脚本生成
export {
  getSnapshotScript,
  getSelectorEngineScript,
  getPageStructureScript,
} from './selector-generator';

// 元素搜索引擎
export { ElementSearchEngine } from './element-search';
export type { SearchResult, SearchOptions } from './element-search';

// 视口 OCR 服务
export { ViewportOCRService } from './viewport-ocr';
export type { ViewportOCROptions, ViewportOCRResult } from './viewport-ocr';
