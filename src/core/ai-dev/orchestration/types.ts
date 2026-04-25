import type { StructuredError } from '../../../types/error-codes';
import type {
  BrowserCapabilityRequirement,
  BrowserInterface,
  BrowserRuntimeDescriptor,
} from '../../../types/browser-interface';
import type { CreateProfileParams, UpdateProfileParams } from '../../../types/profile';
import type { CapabilityCallResult } from '../capabilities/types';
import type {
  FailureBundle,
  RecentFailureSummary,
  TraceSummary,
  TraceTimeline,
} from '../../observability/types';

/**
 * 能力废弃信息（用于兼容窗口治理）
 */
export interface OrchestrationCapabilityDeprecation {
  /** 开始废弃版本 */
  since: string;
  /** 计划移除版本（可选） */
  removeIn?: string;
  /** 替代能力名称（可选） */
  replacement?: string;
  /** 迁移说明（可选） */
  message?: string;
}

/**
 * 编排层能力规格（协议无关）
 */
export type OrchestrationAssistantWorkflowStage =
  | 'setup'
  | 'session'
  | 'navigation'
  | 'inspection'
  | 'interaction'
  | 'observation'
  | 'data'
  | 'teardown';

export interface OrchestrationAssistantGuidanceExample {
  title: string;
  arguments: Record<string, unknown>;
}

export type OrchestrationAssistantToolProfile = 'full' | 'compact';

export interface OrchestrationAssistantGuidance {
  workflowStage: OrchestrationAssistantWorkflowStage;
  whenToUse: string;
  avoidWhen?: string;
  preferredTargetKind?: string;
  requiresBoundProfile?: boolean;
  transportEffect?: string;
  recommendedToolProfile?: OrchestrationAssistantToolProfile;
  preferredNextTools?: string[];
  examples?: OrchestrationAssistantGuidanceExample[];
}

export type OrchestrationAssistantSurfaceTier = 'canonical' | 'advanced' | 'legacy';

export interface OrchestrationAssistantSurface {
  publicMcp?: boolean;
  surfaceTier?: OrchestrationAssistantSurfaceTier;
  gettingStartedOrder?: number;
  sessionReuseOrder?: number;
  pageDebugOrder?: number;
}

export type OrchestrationMcpSessionPhase =
  | 'fresh_unbound'
  | 'prepared_unacquired'
  | 'acquiring_browser'
  | 'bound_browser'
  | 'closing'
  | 'closed';

export interface OrchestrationCapabilitySpec {
  /** 能力名称（建议全局唯一） */
  name: string;
  /** 面向客户端展示的稳定标题 */
  title?: string;
  /** 能力版本（用于兼容演进） */
  version: string;
  /** 输入参数 Schema（JSON Schema） */
  inputSchema?: Record<string, unknown>;
  /** 输出结果 Schema（JSON Schema） */
  outputSchema: Record<string, unknown>;
  /** 执行该能力所需的运行时依赖能力 */
  requires?: OrchestrationCapabilityRequirement[];
  /** 提示性注解（供 MCP/LLM 客户端优化决策） */
  annotations?: OrchestrationToolAnnotations;
  /** 是否幂等（同参数重复调用是否可安全重试） */
  idempotent?: boolean;
  /** 重试建议 */
  retryPolicy?: {
    retryable: boolean;
    maxAttempts: number;
  };
  /** 调用所需权限域 */
  requiredScopes?: string[];
  /** 闈㈠悜 MCP/LLM 瀹㈡埛绔殑鎻愮ず淇℃伅 */
  assistantGuidance?: OrchestrationAssistantGuidance;
  /** 面向 MCP/LLM 客户端的工具表面元数据 */
  assistantSurface?: OrchestrationAssistantSurface;
  /** 废弃信息（可选） */
  deprecation?: OrchestrationCapabilityDeprecation;
}

/**
 * 编排层能力定义
 */
export interface OrchestrationCapabilityDefinition extends OrchestrationCapabilitySpec {
  /** 能力描述 */
  description: string;
  /** 副作用级别 */
  sideEffectLevel?: 'none' | 'low' | 'high';
  /** 估计耗时（毫秒） */
  estimatedLatencyMs?: number;
}

export type OrchestrationCapabilityRequirement =
  | 'browser'
  | 'sessionBrowser'
  | BrowserCapabilityRequirement
  | 'systemGateway'
  | 'datasetGateway'
  | 'crossPluginGateway'
  | 'pluginGateway'
  | 'profileGateway'
  | 'observationGateway'
  | 'mcpSessionGateway';

export interface OrchestrationToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * 编排层调用请求
 */
export interface OrchestrationInvokeRequest {
  /** 能力名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
  /** 可选授权上下文（用于 scope 校验） */
  auth?: {
    scopes?: string[];
    source?: 'mcp' | 'http' | 'internal';
    principal?: string;
  };
}

export type OrchestrationIdempotencyStatus = 'stored' | 'replayed';

export interface OrchestrationInvokeAttempt {
  /** 第几次尝试（从 1 开始） */
  attempt: number;
  /** 尝试开始时间戳（ms） */
  startedAt: number;
  /** 尝试结束时间戳（ms） */
  finishedAt: number;
  /** 本次耗时（ms） */
  durationMs: number;
  /** 本次尝试是否成功 */
  ok: boolean;
  /** 失败时错误码 */
  errorCode?: string;
}

export interface OrchestrationScopeDecision {
  /** 是否启用 scope 强校验 */
  enforced: boolean;
  /** 能力声明所需 scope */
  requiredScopes: string[];
  /** 调用方提供的 scope */
  providedScopes: string[];
  /** 缺失 scope */
  missingScopes: string[];
  /** 是否允许执行 */
  allowed: boolean;
}

export type OrchestrationIdempotencyDecisionStatus =
  | OrchestrationIdempotencyStatus
  | 'rejected'
  | 'skipped';

export interface OrchestrationIdempotencyDecision {
  /** 是否启用幂等语义 */
  enabled: boolean;
  /** 幂等键（若提供） */
  key?: string;
  /** 决策状态 */
  status: OrchestrationIdempotencyDecisionStatus;
  /** 决策原因 */
  reason?: string;
}

/**
 * 编排调用元数据
 */
export interface OrchestrationInvokeMeta {
  /** 编排执行 trace id（用于跨层关联） */
  traceId?: string;
  /** 幂等键（若启用） */
  idempotencyKey?: string;
  /** 幂等状态（若启用） */
  idempotencyStatus?: OrchestrationIdempotencyStatus;
  /** 实际尝试次数（含首次） */
  attempts?: number;
  /** 每次尝试的时间线 */
  attemptTimeline?: OrchestrationInvokeAttempt[];
  /** scope 判定细节 */
  scopeDecision?: OrchestrationScopeDecision;
  /** 幂等判定细节 */
  idempotencyDecision?: OrchestrationIdempotencyDecision;
}

/**
 * 幂等缓存条目
 */
export interface OrchestrationIdempotencyEntry {
  requestHash: string;
  capability: string;
  createdAt: number;
  result: CapabilityCallResult;
  error?: StructuredError;
  meta?: OrchestrationInvokeMeta;
}

/**
 * 编排调用可选项（协议层可按需提供）
 */
export interface OrchestrationInvokeOptions {
  /** 可选 trace id（协议层传入时用于链路对齐） */
  traceId?: string;
  signal?: AbortSignal;
  idempotency?: {
    key: string;
    store: Map<string, OrchestrationIdempotencyEntry>;
    now?: () => number;
  };
  retry?: {
    maxAttempts?: number;
  };
}

/**
 * 编排 API 标准化输出
 *
 * `text` 便于自动编排直接消费文本信息。
 */
export interface OrchestrationInvokeOutput {
  /** 文本内容片段（按原始 content 顺序） */
  text: string[];
  /** 是否包含图片 */
  hasImage: boolean;
  /** 图片数量 */
  imageCount: number;
  /** 结构化结果（若能力返回） */
  structuredContent?: Record<string, unknown>;
}

/**
 * 编排 API 统一响应
 */
export interface OrchestrationInvokeApiResult {
  /** 调用是否成功 */
  ok: boolean;
  /** 能力名称 */
  capability: string;
  /** 标准化输出 */
  output: OrchestrationInvokeOutput;
  /** 结构化错误（失败时） */
  error?: StructuredError;
  /** 调用元数据（幂等/重试） */
  _meta?: OrchestrationInvokeMeta;
}

/**
 * 编排层执行器
 */
export interface OrchestrationExecutor {
  /** 列出可用能力 */
  listCapabilities(): OrchestrationCapabilityDefinition[];
  /** 检查能力是否存在 */
  hasCapability(name: string): boolean;
  /** 执行能力 */
  invoke(
    request: OrchestrationInvokeRequest,
    options?: OrchestrationInvokeOptions
  ): Promise<CapabilityCallResult>;
  /** 执行能力（统一 API 响应） */
  invokeApi(
    request: OrchestrationInvokeRequest,
    options?: OrchestrationInvokeOptions
  ): Promise<OrchestrationInvokeApiResult>;
}

export interface OrchestrationDatasetQueryResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  filteredTotalCount?: number;
}

export interface OrchestrationDatasetGateway {
  listDatasets(): Promise<unknown[]>;
  getDatasetInfo(datasetId: string): Promise<unknown | null>;
  queryDataset(
    datasetId: string,
    sql?: string,
    offset?: number,
    limit?: number
  ): Promise<OrchestrationDatasetQueryResult>;
  createEmptyDataset(
    datasetName: string,
    options?: { folderId?: string | null }
  ): Promise<string>;
  importDatasetFile(
    filePath: string,
    datasetName: string,
    options?: { folderId?: string | null }
  ): Promise<string>;
  renameDataset(datasetId: string, newName: string): Promise<void>;
  deleteDataset(datasetId: string): Promise<void>;
}

export type OrchestrationSystemHealthStatus = 'ok' | 'degraded' | 'error';

export interface OrchestrationSystemHealthAlert {
  code: string;
  severity: 'warning' | 'critical';
  message: string;
  source: 'runtime_metrics' | 'build_freshness' | 'mcp_sdk' | 'session_leak_risk';
  [key: string]: unknown;
}

export interface OrchestrationSystemHealthSnapshot {
  status: OrchestrationSystemHealthStatus;
  name: string;
  version: string;
  activeSessions: number;
  mcpSessions: number;
  orchestrationSessions: number;
  authEnabled: boolean;
  mcpConfigured: boolean;
  mcpEnabled: boolean;
  mcpRequireAuth: boolean;
  mcpProtocolCompatibilityMode: string;
  mcpProtocolVersion: string;
  mcpSupportedProtocolVersions: string[];
  mcpSdkSupportedProtocolVersions: string[];
  enforceOrchestrationScopes: boolean;
  orchestrationIdempotencyStore: 'memory' | 'duckdb';
  queueDepth: Record<string, unknown>;
  runtimeCounters: Record<string, unknown>;
  sessionLeakRisk: Record<string, unknown>;
  sessionCleanupPolicy: Record<string, unknown>;
  processStartTime: string | null;
  mainDistUpdatedAt: string | null;
  rendererDistUpdatedAt: string | null;
  mainBuildStamp: Record<string, unknown> | null;
  mcpRuntimeFreshness: Record<string, unknown>;
  buildFreshness: Record<string, unknown>;
  gitCommit: string | null;
  mcpSdk: Record<string, unknown>;
  runtimeAlerts: OrchestrationSystemHealthAlert[];
}

export interface OrchestrationSystemGateway {
  getHealth(): Promise<OrchestrationSystemHealthSnapshot>;
  listPublicCapabilities(): Promise<string[]> | string[];
}

export interface OrchestrationCrossPluginApiInfo {
  pluginId: string;
  pluginName: string;
  apiName: string;
  description?: string;
  schema?: Record<string, unknown>;
  mcpCallable: boolean;
}

export interface OrchestrationCrossPluginCallResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

export interface OrchestrationProfileInfo {
  id: string;
  name: string;
  engine: string;
  status: string;
  partition?: string;
  isSystem?: boolean;
  totalUses?: number;
  lastActiveAt?: string;
  updatedAt?: string;
  engineRuntimeDescriptor?: BrowserRuntimeDescriptor | null;
}

export interface OrchestrationProfileResolveResult {
  query: string;
  matchedBy: 'id' | 'name';
  profile: OrchestrationProfileInfo;
}

export interface OrchestrationPluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  icon?: string;
  category?: string;
  installedAt: number;
  path: string;
  hasActivityBarView?: boolean;
  activityBarViewOrder?: number;
  activityBarViewIcon?: string;
  enabled: boolean;
  devMode?: boolean;
  sourcePath?: string;
  isSymlink?: boolean;
  hotReloadEnabled?: boolean;
  sourceType?: 'local_private' | 'cloud_managed';
  installChannel?: 'manual_import' | 'cloud_download';
  cloudPluginCode?: string;
  cloudReleaseVersion?: string;
  managedByPolicy?: boolean;
  policyVersion?: string;
  lastPolicySyncAt?: number;
}

export interface OrchestrationPluginRuntimeStatus {
  pluginId: string;
  pluginName?: string;
  lifecyclePhase: 'disabled' | 'inactive' | 'starting' | 'active' | 'stopping' | 'error';
  workState: 'idle' | 'busy' | 'error';
  activeQueues: number;
  runningTasks: number;
  pendingTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  currentSummary?: string;
  currentOperation?: string;
  progressPercent?: number;
  lastError?: {
    message: string;
    at: number;
  };
  lastActivityAt?: number;
  updatedAt: number;
}

export interface OrchestrationPluginInstallRequest {
  sourceType: 'local_path' | 'cloud_code';
  sourcePath?: string;
  devMode?: boolean;
  cloudPluginCode?: string;
}

export interface OrchestrationPluginInstallResult {
  pluginId: string;
  operation: 'installed' | 'updated';
  sourceType: 'local_path' | 'cloud_code';
  warnings?: string[];
}

export interface OrchestrationPluginGateway {
  listPlugins(): Promise<OrchestrationPluginInfo[]>;
  getPlugin(pluginId: string): Promise<OrchestrationPluginInfo | null>;
  listRuntimeStatuses(): Promise<OrchestrationPluginRuntimeStatus[]>;
  getRuntimeStatus(pluginId: string): Promise<OrchestrationPluginRuntimeStatus | null>;
  installPlugin(
    request: OrchestrationPluginInstallRequest
  ): Promise<OrchestrationPluginInstallResult>;
  reloadPlugin(pluginId: string): Promise<void>;
  uninstallPlugin(pluginId: string, options?: { deleteTables?: boolean }): Promise<void>;
}

export interface OrchestrationProfileGateway {
  listProfiles(): Promise<OrchestrationProfileInfo[]>;
  getProfile(profileId: string): Promise<OrchestrationProfileInfo | null>;
  resolveProfile(query: string): Promise<OrchestrationProfileResolveResult | null>;
  createProfile(params: CreateProfileParams): Promise<OrchestrationProfileInfo>;
  updateProfile(id: string, params: UpdateProfileParams): Promise<OrchestrationProfileInfo>;
  deleteProfile(id: string): Promise<void>;
}

export interface OrchestrationMcpSessionInfo {
  sessionId: string;
  profileId?: string;
  engine?: string;
  visible?: boolean;
  lastActivityAt: string;
  pendingInvocations: number;
  activeInvocations: number;
  maxQueueSize: number;
  browserAcquired: boolean;
  browserAcquireInProgress: boolean;
  hasBrowserHandle: boolean;
  effectiveScopes?: string[];
  closing?: boolean;
  terminateAfterResponse?: boolean;
  hostWindowId?: string;
  viewportHealth?: 'unknown' | 'ready' | 'warning' | 'broken';
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
  engineRuntimeDescriptor?: BrowserRuntimeDescriptor | null;
  browserRuntimeDescriptor?: BrowserRuntimeDescriptor | null;
  resolvedRuntimeDescriptor?: BrowserRuntimeDescriptor | null;
  phase?: OrchestrationMcpSessionPhase;
  bindingLocked?: boolean;
  acquireReadiness?: OrchestrationMcpSessionAcquireReadiness | null;
}

export interface OrchestrationBrowserSessionContext {
  sessionId?: string;
  visible?: boolean;
  hostWindowId?: string;
  viewportHealth?: 'unknown' | 'ready' | 'warning' | 'broken';
  viewportHealthReason?: string;
  interactionReady?: boolean;
  offscreenDetected?: boolean;
  phase?: OrchestrationMcpSessionPhase;
  bindingLocked?: boolean;
}

export interface OrchestrationMcpSessionInteractionReadyResult
  extends OrchestrationBrowserSessionContext {
  repaired: boolean;
  browserAcquired: boolean;
}

export interface OrchestrationMcpSessionAcquireReadinessBrowser {
  browserId: string;
  status: string;
  engine: string | null;
  source: string | null;
  pluginId: string | null;
  requestId: string | null;
  viewId: string | null;
}

export interface OrchestrationMcpSessionAcquireReadiness {
  profileId: string;
  browserCount: number;
  lockedBrowserCount: number;
  creatingBrowserCount: number;
  idleBrowserCount: number;
  destroyingBrowserCount: number;
  busy: boolean;
  browsers: OrchestrationMcpSessionAcquireReadinessBrowser[];
}

export interface OrchestrationMcpSessionPrepareResult {
  sessionId: string;
  prepared: boolean;
  idempotent: boolean;
  profileId?: string;
  engine?: string;
  visible: boolean;
  effectiveScopes: string[];
  browserAcquired: boolean;
  changed: Array<'profile' | 'engine' | 'visible' | 'scopes'>;
  phase: OrchestrationMcpSessionPhase;
  bindingLocked: boolean;
  acquireReadiness?: OrchestrationMcpSessionAcquireReadiness | null;
  reason?:
    | 'current_session_unavailable'
    | 'binding_locked';
  currentProfileId?: string;
  currentEngine?: string;
  currentVisible?: boolean;
}

export interface OrchestrationMcpSessionCloseResult {
  closed: boolean;
  reason?: 'not_found' | 'current_session_blocked';
  closedCurrentSession?: boolean;
  transportInvalidated?: boolean;
  allowFurtherCallsOnSameTransport?: boolean;
  terminationTiming?: 'immediate' | 'after_response_flush';
}

export interface OrchestrationMcpSessionGateway {
  getCurrentSessionId(): string | undefined;
  listSessions(): Promise<OrchestrationMcpSessionInfo[]>;
  ensureCurrentSessionInteractionReady?(): Promise<OrchestrationMcpSessionInteractionReadyResult>;
  prepareCurrentSession?(
    options: {
      profileId?: string;
      engine?: string;
      visible?: boolean;
      scopes?: string[];
    }
  ): Promise<OrchestrationMcpSessionPrepareResult>;
  closeSession(
    sessionId: string,
    options?: { allowCurrent?: boolean }
  ): Promise<OrchestrationMcpSessionCloseResult>;
}

export interface OrchestrationCrossPluginGateway {
  listCallableApis(): OrchestrationCrossPluginApiInfo[];
  callApi(
    pluginId: string,
    apiName: string,
    params?: unknown[]
  ): Promise<OrchestrationCrossPluginCallResult>;
}

export interface OrchestrationObservationGateway {
  getTraceSummary(traceId: string): Promise<TraceSummary>;
  getFailureBundle(traceId: string): Promise<FailureBundle>;
  getTraceTimeline(traceId: string, limit?: number): Promise<TraceTimeline>;
  searchRecentFailures(limit?: number): Promise<RecentFailureSummary[]>;
}

/**
 * 编排层依赖
 *
 * 编排层保持自己的依赖契约，避免与 MCP 类型耦合。
 */
export interface OrchestrationDependencies {
  browser?: BrowserInterface;
  browserFactory?: (options: { partition?: string; visible?: boolean }) => Promise<BrowserInterface>;
  signal?: AbortSignal;
  systemGateway?: OrchestrationSystemGateway;
  datasetGateway?: OrchestrationDatasetGateway;
  crossPluginGateway?: OrchestrationCrossPluginGateway;
  pluginGateway?: OrchestrationPluginGateway;
  profileGateway?: OrchestrationProfileGateway;
  observationGateway?: OrchestrationObservationGateway;
  mcpSessionGateway?: OrchestrationMcpSessionGateway;
  mcpSessionContext?: OrchestrationBrowserSessionContext;
  /** 是否强制执行 requiredScopes 检查（默认 false，兼容模式） */
  enforceScopes?: boolean;
  [key: string]: unknown;
}
