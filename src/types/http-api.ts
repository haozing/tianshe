/**
 * HTTP API 相关类型定义
 */
import type {
  OrchestrationCrossPluginGateway,
  OrchestrationIdempotencyEntry,
  OrchestrationDatasetGateway,
  OrchestrationObservationGateway,
  OrchestrationPluginGateway,
  OrchestrationProfileGateway,
  OrchestrationSystemGateway,
} from '../core/ai-dev/orchestration/types';

export interface OrchestrationIdempotencyPersistenceStore {
  get(namespace: string, key: string): Promise<OrchestrationIdempotencyEntry | null>;
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
  systemGateway?: OrchestrationSystemGateway;
  datasetGateway?: OrchestrationDatasetGateway;
  crossPluginGateway?: OrchestrationCrossPluginGateway;
  pluginGateway?: OrchestrationPluginGateway;
  profileGateway?: OrchestrationProfileGateway;
  observationGateway?: OrchestrationObservationGateway;
  idempotencyPersistence?: OrchestrationIdempotencyPersistenceStore;
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
   */
  enforceOrchestrationScopes?: boolean;
  /**
   * 编排幂等存储策略
   * - memory: 仅会话内内存（默认，兼容）
   * - duckdb: 基于现有 DuckDB 的可选持久化
   */
  orchestrationIdempotencyStore?: 'memory' | 'duckdb';
}
