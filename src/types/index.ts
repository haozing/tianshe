/**
 * 类型定义统一导出
 */

// 浏览器接口相关类型
export type {
  BrowserCore,
  BrowserInterface,
  BrowserCookieFilter,
  BrowserCapabilityName,
  BrowserCapabilityRequirement,
  BrowserCapabilityDescriptor,
  BrowserRuntimeDescriptor,
  BrowserRuntimeIntrospection,
  BrowserNetworkCaptureCapability,
  BrowserConsoleCaptureCapability,
  BrowserWindowOpenPolicyCapability,
  BrowserTextOcrCapability,
  BrowserDownloadCapability,
  BrowserDialogCapability,
  BrowserTabCapability,
  BrowserEmulationCapability,
  BrowserInterceptCapability,
  BrowserInterceptedRequest,
  BrowserInterceptWaitOptions,
  NetworkFilter,
  NetworkSummary,
  SearchResult,
  SearchOptions,
  ScreenshotOptions,
  // 归一化坐标类型
  NormalizedPoint,
  NormalizedBounds,
  Bounds,
  // 原生输入类型
  NativeClickOptions,
  NativeTypeOptions,
  // 从 browser-types 重导出的类型
  PageSnapshot,
  SnapshotElement,
  NetworkEntry,
  ConsoleMessage,
  SnapshotOptions,
  NetworkCaptureOptions,
  Cookie,
} from './browser-interface';

// 统一错误码和结构化错误
export {
  ErrorCode,
  CommonErrorCode,
  BrowserErrorCode,
  PluginErrorCode,
  DatabaseErrorCode,
  AIErrorCode,
  createStructuredError,
} from './error-codes';

export type { StructuredError } from './error-codes';

// Note: workflow types have been removed as part of Workflow system cleanup

export type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactType,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncCapabilities,
  SyncClientInfo,
  SyncConflictPayload,
  SyncConflictPolicy,
  SyncDomain,
  SyncDomainCapability,
  SyncEntityType,
  SyncEnvelope,
  SyncErrorCode,
  SyncErrorResponse,
  SyncEventSource,
  SyncExtensionCapability,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncOperationType,
  SyncPullChange,
  SyncPullDomainResult,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushDomainResult,
  SyncPushEntity,
  SyncPushEntityResult,
  SyncPushOperation,
  SyncPushRequest,
  SyncPushResponse,
  SyncRequest,
  SyncResponse,
  SyncScope,
} from './sync-contract';

export { SYNC_PROTOCOL_VERSION } from './sync-contract';
