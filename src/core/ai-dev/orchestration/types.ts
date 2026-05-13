import type { StructuredError } from '../../../types/error-codes';
import type {
  BrowserCapabilityRequirement,
  BrowserInterface,
  BrowserRuntimeDescriptor,
} from '../../../types/browser-interface';
import type { CreateProfileParams, UpdateProfileParams } from '../../../types/profile';
import type { CapabilityCallResult } from '../capabilities/types';
import type { BrowserRuntimeStatus } from '../../browser-runtime';
import type {
  FailureBundle,
  RecentFailureSummary,
  TraceSummary,
  TraceTimeline,
} from '../../observability/types';

/**
 * 鑳藉姏搴熷純淇℃伅锛堢敤浜庡吋瀹圭獥鍙ｆ不鐞嗭級
 */
export interface OrchestrationCapabilityDeprecation {
  /** 寮€濮嬪簾寮冪増鏈?*/
  since: string;
  /** 璁″垝绉婚櫎鐗堟湰锛堝彲閫夛級 */
  removeIn?: string;
  /** 鏇夸唬鑳藉姏鍚嶇О锛堝彲閫夛級 */
  replacement?: string;
  /** 杩佺Щ璇存槑锛堝彲閫夛級 */
  message?: string;
}

/**
 * 缂栨帓灞傝兘鍔涜鏍硷紙鍗忚鏃犲叧锛?
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
  /** 鑳藉姏鍚嶇О锛堝缓璁叏灞€鍞竴锛?*/
  name: string;
  /** 闈㈠悜瀹㈡埛绔睍绀虹殑绋冲畾鏍囬 */
  title?: string;
  /** 鑳藉姏鐗堟湰锛堢敤浜庡吋瀹规紨杩涳級 */
  version: string;
  /** 杈撳叆鍙傛暟 Schema锛圝SON Schema锛?*/
  inputSchema?: Record<string, unknown>;
  /** 杈撳嚭缁撴灉 Schema锛圝SON Schema锛?*/
  outputSchema: Record<string, unknown>;
  /** 鎵ц璇ヨ兘鍔涙墍闇€鐨勮繍琛屾椂渚濊禆鑳藉姏 */
  requires?: OrchestrationCapabilityRequirement[];
  /** 鎻愮ず鎬ф敞瑙ｏ紙渚?MCP/LLM 瀹㈡埛绔紭鍖栧喅绛栵級 */
  annotations?: OrchestrationToolAnnotations;
  /** 鏄惁骞傜瓑锛堝悓鍙傛暟閲嶅璋冪敤鏄惁鍙畨鍏ㄩ噸璇曪級 */
  idempotent?: boolean;
  /** 閲嶈瘯寤鸿 */
  retryPolicy?: {
    retryable: boolean;
    maxAttempts: number;
  };
  /** 璋冪敤鎵€闇€鏉冮檺鍩?*/
  requiredScopes?: string[];
  /** 闂堛垹鎮?MCP/LLM 鐎广垺鍩涚粩顖滄畱閹绘劗銇氭穱鈩冧紖 */
  assistantGuidance?: OrchestrationAssistantGuidance;
  /** 闈㈠悜 MCP/LLM 瀹㈡埛绔殑宸ュ叿琛ㄩ潰鍏冩暟鎹?*/
  assistantSurface?: OrchestrationAssistantSurface;
  /** 搴熷純淇℃伅锛堝彲閫夛級 */
  deprecation?: OrchestrationCapabilityDeprecation;
}

/**
 * 缂栨帓灞傝兘鍔涘畾涔?
 */
export interface OrchestrationCapabilityDefinition extends OrchestrationCapabilitySpec {
  /** 鑳藉姏鎻忚堪 */
  description: string;
  /** 鍓綔鐢ㄧ骇鍒?*/
  sideEffectLevel?: 'none' | 'low' | 'high';
  /** 浼拌鑰楁椂锛堟绉掞級 */
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
 * 缂栨帓灞傝皟鐢ㄨ姹?
 */
export interface OrchestrationInvokeRequest {
  /** 鑳藉姏鍚嶇О */
  name: string;
  /** 璋冪敤鍙傛暟 */
  arguments: Record<string, unknown>;
  /** 鍙€夋巿鏉冧笂涓嬫枃锛堢敤浜?scope 鏍￠獙锛?*/
  auth?: {
    scopes?: string[];
    source?: 'mcp' | 'http' | 'internal';
    principal?: string;
  };
}

export type OrchestrationIdempotencyStatus = 'stored' | 'replayed';

export interface OrchestrationInvokeAttempt {
  /** 绗嚑娆″皾璇曪紙浠?1 寮€濮嬶級 */
  attempt: number;
  /** 灏濊瘯寮€濮嬫椂闂存埑锛坢s锛?*/
  startedAt: number;
  /** 灏濊瘯缁撴潫鏃堕棿鎴筹紙ms锛?*/
  finishedAt: number;
  /** 鏈鑰楁椂锛坢s锛?*/
  durationMs: number;
  /** 鏈灏濊瘯鏄惁鎴愬姛 */
  ok: boolean;
  /** 澶辫触鏃堕敊璇爜 */
  errorCode?: string;
}

export interface OrchestrationScopeDecision {
  /** 鏄惁鍚敤 scope 寮烘牎楠?*/
  enforced: boolean;
  /** 鑳藉姏澹版槑鎵€闇€ scope */
  requiredScopes: string[];
  /** 璋冪敤鏂规彁渚涚殑 scope */
  providedScopes: string[];
  /** 缂哄け scope */
  missingScopes: string[];
  /** 鏄惁鍏佽鎵ц */
  allowed: boolean;
}

export type OrchestrationIdempotencyDecisionStatus =
  | OrchestrationIdempotencyStatus
  | 'rejected'
  | 'skipped';

export interface OrchestrationIdempotencyDecision {
  /** 鏄惁鍚敤骞傜瓑璇箟 */
  enabled: boolean;
  /** 骞傜瓑閿紙鑻ユ彁渚涳級 */
  key?: string;
  /** 鍐崇瓥鐘舵€?*/
  status: OrchestrationIdempotencyDecisionStatus;
  /** 鍐崇瓥鍘熷洜 */
  reason?: string;
}

/**
 * 缂栨帓璋冪敤鍏冩暟鎹?
 */
export interface OrchestrationInvokeMeta {
  /** 缂栨帓鎵ц trace id锛堢敤浜庤法灞傚叧鑱旓級 */
  traceId?: string;
  /** 骞傜瓑閿紙鑻ュ惎鐢級 */
  idempotencyKey?: string;
  /** 骞傜瓑鐘舵€侊紙鑻ュ惎鐢級 */
  idempotencyStatus?: OrchestrationIdempotencyStatus;
  /** 瀹為檯灏濊瘯娆℃暟锛堝惈棣栨锛?*/
  attempts?: number;
  /** 姣忔灏濊瘯鐨勬椂闂寸嚎 */
  attemptTimeline?: OrchestrationInvokeAttempt[];
  /** scope 鍒ゅ畾缁嗚妭 */
  scopeDecision?: OrchestrationScopeDecision;
  /** 骞傜瓑鍒ゅ畾缁嗚妭 */
  idempotencyDecision?: OrchestrationIdempotencyDecision;
}

/**
 * 骞傜瓑缂撳瓨鏉＄洰
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
 * 缂栨帓璋冪敤鍙€夐」锛堝崗璁眰鍙寜闇€鎻愪緵锛?
 */
export interface OrchestrationInvokeOptions {
  /** 鍙€?trace id锛堝崗璁眰浼犲叆鏃剁敤浜庨摼璺榻愶級 */
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
 * 缂栨帓 API 鏍囧噯鍖栬緭鍑?
 *
 * `text` 渚夸簬鑷姩缂栨帓鐩存帴娑堣垂鏂囨湰淇℃伅銆?
 */
export interface OrchestrationInvokeOutput {
  /** 鏂囨湰鍐呭鐗囨锛堟寜鍘熷 content 椤哄簭锛?*/
  text: string[];
  /** 鏄惁鍖呭惈鍥剧墖 */
  hasImage: boolean;
  /** 鍥剧墖鏁伴噺 */
  imageCount: number;
  /** 缁撴瀯鍖栫粨鏋滐紙鑻ヨ兘鍔涜繑鍥烇級 */
  structuredContent?: Record<string, unknown>;
}

/**
 * 缂栨帓 API 缁熶竴鍝嶅簲
 */
export interface OrchestrationInvokeApiResult {
  /** 璋冪敤鏄惁鎴愬姛 */
  ok: boolean;
  /** 鑳藉姏鍚嶇О */
  capability: string;
  /** 鏍囧噯鍖栬緭鍑?*/
  output: OrchestrationInvokeOutput;
  /** 缁撴瀯鍖栭敊璇紙澶辫触鏃讹級 */
  error?: StructuredError;
  /** 璋冪敤鍏冩暟鎹紙骞傜瓑/閲嶈瘯锛?*/
  _meta?: OrchestrationInvokeMeta;
}

/**
 * 缂栨帓灞傛墽琛屽櫒
 */
export interface OrchestrationExecutor {
  /** 鍒楀嚭鍙敤鑳藉姏 */
  listCapabilities(): OrchestrationCapabilityDefinition[];
  /** 妫€鏌ヨ兘鍔涙槸鍚﹀瓨鍦?*/
  hasCapability(name: string): boolean;
  /** 鎵ц鑳藉姏 */
  invoke(
    request: OrchestrationInvokeRequest,
    options?: OrchestrationInvokeOptions
  ): Promise<CapabilityCallResult>;
  /** 鎵ц鑳藉姏锛堢粺涓€ API 鍝嶅簲锛?*/
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
  listBrowserRuntimeStatuses?(): Promise<BrowserRuntimeStatus[]>;
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
  runtimeId: string;
  status: string;
  partition?: string;
  isSystem?: boolean;
  totalUses?: number;
  lastActiveAt?: string;
  updatedAt?: string;
  runtimeDescriptor?: BrowserRuntimeDescriptor | null;
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
  runtimeId?: string;
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
  runtimeDescriptor?: BrowserRuntimeDescriptor | null;
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
  runtimeId: string | null;
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
  runtimeId?: string;
  visible: boolean;
  effectiveScopes: string[];
  browserAcquired: boolean;
  changed: Array<'profile' | 'runtimeId' | 'visible' | 'scopes'>;
  phase: OrchestrationMcpSessionPhase;
  bindingLocked: boolean;
  acquireReadiness?: OrchestrationMcpSessionAcquireReadiness | null;
  reason?:
    | 'current_session_unavailable'
    | 'binding_locked';
  currentProfileId?: string;
  currentRuntimeId?: string;
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
      runtimeId?: string;
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
 * 缂栨帓灞備緷璧?
 *
 * 缂栨帓灞備繚鎸佽嚜宸辩殑渚濊禆濂戠害锛岄伩鍏嶄笌 MCP 绫诲瀷鑰﹀悎銆?
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
  /** 鏄惁寮哄埗鎵ц requiredScopes 妫€鏌ワ紙榛樿 false锛屽吋瀹规ā寮忥級 */
  enforceScopes?: boolean;
  [key: string]: unknown;
}

