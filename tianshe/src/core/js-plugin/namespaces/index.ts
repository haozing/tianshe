/**
 * JS Plugin Namespaces Export
 *
 * 导出所有命名空间类型和实现
 * 重构后统一从此文件导出，保持一致性
 *
 * 导出分为两类：
 * 1. 公共 API：命名空间类（*Namespace），供插件日常使用
 * 2. 高级/内部 API：底层类和工具，仅供高级用户使用，可能变化
 *
 * 插件通常只需要使用命名空间类（如 helpers.database, helpers.profile）
 * 底层类（如 SimpleBrowser, IntegratedBrowser）仅在需要直接访问时使用
 */

// ============================================================================
// 公共 API：命名空间类
// ============================================================================

// === 基础命名空间 ===
export { DatabaseNamespace } from './database';
export { NetworkNamespace } from './network';
export { UINamespace } from './ui';
export { StorageNamespace } from './storage';
export { UtilsNamespace, type TaskController, type IntervalOptions } from './utils';

// ============================================================================
// 高级 API：底层类（直接访问，可能变化）
// ============================================================================

// 浏览器核心类和类型（从 browser-core 导出）
// ⚠️ 这些是底层实现，建议通过 helpers.profile.launch() 获取 handle.browser 使用
export {
  // 核心类
  SimpleBrowser,
  type ViewManager,
  // 子命名空间 API
  BrowserNativeAPI,
  BrowserSessionAPI,
  BrowserCaptureAPI,
  BrowserCDPAPI,
  // 工具函数
  CircularBuffer,
  waitUntil,
  sleep,
  BrowserLogger,
  BrowserError,
  NavigationTimeoutError,
  ElementNotFoundError,
  WaitForSelectorTimeoutError,
  WaitForResponseTimeoutError,
  WaitForLoginTimeoutError,
  BrowserClosedError,
  WebContentsDestroyedError,
} from '../../browser-core';

// 浏览器自动化（从 browser-automation 导出）
// ⚠️ 这些是底层实现，API 可能变化
export {
  IntegratedBrowser,
  ElementSearchEngine,
  getSnapshotScript,
  getSelectorEngineScript,
  getPageStructureScript,
} from '../../browser-automation';
export type {
  InterceptConfig,
  SearchResult as ElementSearchResult,
  SearchOptions as ElementSearchOptions,
} from '../../browser-automation';

// 浏览器分析（从 browser-analysis 导出）
// ⚠️ 这些是底层实现，API 可能变化
export { PageAnalyzer } from '../../browser-analysis';
export type {
  PageSummary,
  PageType,
  KeyElementsCount,
  LoginStatusSummary,
} from '../../browser-analysis';

// ============================================================================
// 公共 API：其他命名空间
// ============================================================================

// 类型导出（从 browser-core 导出）
export type {
  // 核心类型
  PageSnapshot,
  SnapshotElement,
  NetworkEntry,
  ConsoleMessage,
  SnapshotOptions,
  ClickOptions,
  TypeOptions,
  WaitForSelectorOptions,
  NetworkCaptureOptions,
  Cookie,
  // 工具类型
  LogLevel,
  WaitUntilOptions,
  // 子命名空间类型
  NativeClickOptions,
  NativeTypeOptions,
  NativeDragOptions,
  CaptureScreenshotOptions,
  PDFOptions,
  CDPEventCleanup,
} from '../../browser-core';

// Session API 类型（需要从 session 模块单独导入）
export type { ProxyConfig, ClearStorageOptions, CookieFilter } from '../../browser-core/session';

export {
  ProfileNamespace,
  type LaunchOptions,
  type LaunchPopupOptions,
  type PopupBrowserHandle,
} from './profile';
export { SavedSiteNamespace, type EnsureDoudianSavedSiteOptions } from './saved-site';
export { CloudNamespace } from './cloud';
export { CustomFieldNamespace } from './custom-field';

// Profile 相关类型（从 types/profile 重新导出，方便插件使用）
export type {
  BrowserProfile,
  CreateProfileParams,
  UpdateProfileParams,
  ProxyConfig as ProfileProxyConfig,
  FingerprintConfig,
  ProfileStatus,
  ProfileListParams,
} from '../../../types/profile';

export { OpenAINamespace } from './openai';

// === 窗口和 UI ===
export { WindowNamespace } from './window';
export { ButtonNamespace } from './button';

// === 插件系统 ===
export { PluginNamespace } from './plugin';

// === 系统能力 ===
export { FFINamespace } from './ffi';

// === 任务管理 ===
export { TaskQueueNamespace } from './task-queue';
export type {
  TaskQueue,
  TaskQueueOptions,
  TaskOptions,
  TaskContext,
  TaskInfo,
  TaskEvent,
  TaskStatus,
  TaskProgress,
  QueueStats,
} from './task-queue';
export { SchedulerNamespace } from './scheduler';

// === 网络扩展 ===
export { WebhookNamespace } from './webhook';

// === 原生 API ===
export { RawNamespace } from './raw';
export { AdvancedNamespace } from './advanced';

// === ONNX 模型推理 ===
export { ONNXNamespace } from './onnx';
export type {
  SimpleTensorInput,
  SimpleTensorOutput,
  LoadModelOptions,
  ModelInfo as ONNXModelInfo,
} from './onnx';

// === 图像相似度（pHash -> SSIM） ===
export { ImageNamespace } from './image';
export type {
  HashFormat,
  PerceptualHashOptions,
  PerceptualHashResult,
  PerceptualHashCompareResult,
  ResizeMode,
  SSIMCompareOptions,
  SSIMCompareResult,
  ImageSimilarityCompareOptions,
  ImageSimilarityCompareResult,
} from './image';

// === 图像搜索 ===
export { ImageSearchNamespace } from './image-search';
export type {
  SearchOptions as ImageSearchOptions,
  SearchResult as ImageSearchResult,
  TemplateInfo as ImageTemplateInfo,
  BatchAddResult as ImageBatchAddResult,
  IndexStats as ImageIndexStats,
  DownloadProgress as ImageDownloadProgress,
} from './image-search';

// === OCR 文字识别 ===
export { OCRNamespace } from './ocr';
export type {
  SimpleOCROptions,
  FindTextOptions,
  OCROptions,
  OCRResult,
  DetailedOCRResult,
} from './ocr';

// === OpenCV 通用图像处理 ===
export { CVNamespace } from './cv';
export type {
  CVInitOptions,
  DecodeOptions,
  EncodeFormat,
  FindCropsOptions,
  ExtractCropsResult,
  ExtractCropsBatchOptions,
} from './cv';

// === 向量索引 ===
export { VectorIndexNamespace } from './vector-index';
export type {
  CreateIndexOptions,
  VectorSearchOptions,
  VectorSearchResult,
  VectorEntry,
  BatchAddResult as VectorBatchAddResult,
  SpaceType,
  IndexStats as VectorIndexStats,
} from './vector-index';
