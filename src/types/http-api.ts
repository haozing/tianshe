/**
 * HTTP API 相关类型定义
 */
import type {
  OrchestrationCrossPluginGateway,
  OrchestrationIdempotencyEntry,
  OrchestrationDatasetGateway,
  OrchestrationObservationGateway,
  OrchestrationProfileLoginStateGateway,
  OrchestrationPluginGateway,
  OrchestrationProfileGateway,
  OrchestrationSystemGateway,
} from '../core/ai-dev/orchestration/types';
import type { CapabilityProvider } from '../core/ai-dev/capabilities';
import type { BrowserRuntimeManager, ProfileSessionGateway } from '../core/browser-runtime';

export interface OrchestrationIdempotencyPersistenceStore {
  get(namespace: string, key: string): Promise<OrchestrationIdempotencyEntry | null>;
  reserve?(
    namespace: string,
    key: string,
    entry: OrchestrationIdempotencyEntry
  ): Promise<
    | { status: 'reserved'; entry: OrchestrationIdempotencyEntry }
    | { status: 'exists'; entry: OrchestrationIdempotencyEntry }
  >;
  set(namespace: string, key: string, entry: OrchestrationIdempotencyEntry): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  pruneExpired(ttlMs: number, nowMs?: number): Promise<number>;
}

/**
 * HTTP API 依赖项（最小化）
 */
export interface RestApiDependencies {
  viewManager?: any; // WebContentsViewManager 实例
  windowManager?: any; // WindowManager 实例
  browserRuntimeManager?: BrowserRuntimeManager;
  systemGateway?: OrchestrationSystemGateway;
  datasetGateway?: OrchestrationDatasetGateway;
  crossPluginGateway?: OrchestrationCrossPluginGateway;
  pluginGateway?: OrchestrationPluginGateway;
  profileGateway?: OrchestrationProfileGateway;
  profileLoginStateGateway?: OrchestrationProfileLoginStateGateway;
  profileSessionGateway?: ProfileSessionGateway;
  observationGateway?: OrchestrationObservationGateway;
  idempotencyPersistence?: OrchestrationIdempotencyPersistenceStore;
  capabilityProviders?: CapabilityProvider[];
}

/**
 * HTTP API 配置
 */
export interface RestApiConfig {
  enableAuth: boolean;
  token?: string;
  /** MCP 服务开关 */
  enableMcp?: boolean;
  /**
   * MCP 端点是否需要鉴权
   * - true: /mcp 需要 Bearer token（默认，推荐）
   * - false: /mcp 免鉴权（仅限本地开发或已有其他安全措施）
   * @default true
   */
  mcpRequireAuth?: boolean;
  mcpAllowedOrigins?: string[];
  /**
   * 是否强制执行 orchestration requiredScopes 校验
   * @default true
   */
  enforceOrchestrationScopes?: boolean;
  /**
   * agent-hand 安全默认模式：开启后强制 Token 鉴权、MCP 鉴权和 requiredScopes 校验
   */
  agentHandMode?: boolean;
  /**
   * 编排幂等存储策略
   * - memory: 仅会话内内存（默认，兼容）
   * - duckdb: 基于现有 DuckDB 的可选持久化
   */
  orchestrationIdempotencyStore?: 'memory' | 'duckdb';
}
