/**
 * 统一错误码定义
 *
 * 所有模块共享的错误码常量，确保错误分类的一致性
 *
 * 设计原则：
 * - 使用字符串常量而非 enum，便于跨模块使用
 * - 分组命名：MODULE_CATEGORY_SPECIFIC
 * - 提供类型定义供 TypeScript 使用
 */

// ============================================
// 通用错误码（所有模块共用）
// ============================================

export const CommonErrorCode = {
  // 参数相关
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  PARAMETER_TYPE_MISMATCH: 'PARAMETER_TYPE_MISMATCH',
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // 超时相关
  TIMEOUT: 'TIMEOUT',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',

  // 网络相关
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_FAILED: 'REQUEST_FAILED',

  // 权限相关
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // 资源未找到
  NOT_FOUND: 'NOT_FOUND',

  // 执行相关
  OPERATION_FAILED: 'OPERATION_FAILED',
  EXECUTION_ERROR: 'EXECUTION_ERROR',

  // 系统错误
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

// eslint-disable-next-line no-redeclare
export type CommonErrorCode = (typeof CommonErrorCode)[keyof typeof CommonErrorCode];

// ============================================
// 浏览器相关错误码
// ============================================

export const BrowserErrorCode = {
  BROWSER_NOT_READY: 'BROWSER_NOT_READY',
  PAGE_NOT_LOADED: 'PAGE_NOT_LOADED',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_INTERACTABLE',
  INTERACTION_NOT_READY: 'INTERACTION_NOT_READY',
  ACTION_UNVERIFIED: 'ACTION_UNVERIFIED',
  SCRIPT_EXECUTION_FAILED: 'SCRIPT_EXECUTION_FAILED',
  NETWORK_CAPTURE_NOT_STARTED: 'NETWORK_CAPTURE_NOT_STARTED',
  BROWSER_CLOSED: 'BROWSER_CLOSED',
  WEBCONTENTS_DESTROYED: 'WEBCONTENTS_DESTROYED',
} as const;

// eslint-disable-next-line no-redeclare
export type BrowserErrorCode = (typeof BrowserErrorCode)[keyof typeof BrowserErrorCode];

// ============================================
// 插件相关错误码
// ============================================

export const PluginErrorCode = {
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_LOAD_ERROR: 'PLUGIN_LOAD_ERROR',
  PLUGIN_CONFIG_ERROR: 'PLUGIN_CONFIG_ERROR',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  API_NOT_FOUND: 'API_NOT_FOUND',
  DATASET_NOT_FOUND: 'DATASET_NOT_FOUND',
} as const;

// eslint-disable-next-line no-redeclare
export type PluginErrorCode = (typeof PluginErrorCode)[keyof typeof PluginErrorCode];

// ============================================
// 数据库相关错误码
// ============================================

export const DatabaseErrorCode = {
  DATABASE_ERROR: 'DATABASE_ERROR',
  QUERY_FAILED: 'QUERY_FAILED',
  INSERT_FAILED: 'INSERT_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  DELETE_FAILED: 'DELETE_FAILED',
} as const;

// eslint-disable-next-line no-redeclare
export type DatabaseErrorCode = (typeof DatabaseErrorCode)[keyof typeof DatabaseErrorCode];

// ============================================
// AI/LLM 相关错误码
// ============================================

export const AIErrorCode = {
  OPENAI_ERROR: 'OPENAI_ERROR',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
} as const;

// eslint-disable-next-line no-redeclare
export type AIErrorCode = (typeof AIErrorCode)[keyof typeof AIErrorCode];

// ============================================
// 浏览器池相关错误码
// ============================================

export const BrowserPoolErrorCode = {
  // 池状态错误
  POOL_STOPPED: 'BROWSER_POOL_STOPPED',
  POOL_NOT_INITIALIZED: 'BROWSER_POOL_NOT_INITIALIZED',

  // Profile 错误
  PROFILE_NOT_FOUND: 'BROWSER_POOL_PROFILE_NOT_FOUND',
  PROFILE_INVALID: 'BROWSER_POOL_PROFILE_INVALID',

  // 获取浏览器错误
  ACQUIRE_FAILED: 'BROWSER_POOL_ACQUIRE_FAILED',
  ACQUIRE_TIMEOUT: 'BROWSER_POOL_ACQUIRE_TIMEOUT',
  BROWSER_NOT_FOUND: 'BROWSER_POOL_BROWSER_NOT_FOUND',

  // 释放浏览器错误
  RELEASE_FAILED: 'BROWSER_POOL_RELEASE_FAILED',

  // 浏览器创建错误
  BROWSER_CREATE_FAILED: 'BROWSER_POOL_BROWSER_CREATE_FAILED',
  FACTORY_NOT_SET: 'BROWSER_POOL_FACTORY_NOT_SET',

  // 会话错误
  SESSION_NOT_FOUND: 'BROWSER_POOL_SESSION_NOT_FOUND',
  SESSION_LIMIT_EXCEEDED: 'BROWSER_POOL_SESSION_LIMIT_EXCEEDED',

  // 锁错误
  LOCK_EXPIRED: 'BROWSER_POOL_LOCK_EXPIRED',
  LOCK_RENEWAL_FAILED: 'BROWSER_POOL_LOCK_RENEWAL_FAILED',
} as const;

// eslint-disable-next-line no-redeclare
export type BrowserPoolErrorCode = (typeof BrowserPoolErrorCode)[keyof typeof BrowserPoolErrorCode];

// ============================================
// Stealth/反检测相关错误码
// ============================================

export const StealthErrorCode = {
  // CDP 模拟错误
  CDP_EMULATION_FAILED: 'STEALTH_CDP_EMULATION_FAILED',
  CDP_COMMAND_FAILED: 'STEALTH_CDP_COMMAND_FAILED',
  CDP_NOT_AVAILABLE: 'STEALTH_CDP_NOT_AVAILABLE',

  // 指纹错误
  FINGERPRINT_GENERATION_FAILED: 'STEALTH_FINGERPRINT_GENERATION_FAILED',
  FINGERPRINT_INVALID: 'STEALTH_FINGERPRINT_INVALID',
  FINGERPRINT_PROFILE_NOT_FOUND: 'STEALTH_FINGERPRINT_PROFILE_NOT_FOUND',

  // 脚本错误
  SCRIPT_GENERATION_FAILED: 'STEALTH_SCRIPT_GENERATION_FAILED',
  SCRIPT_INJECTION_FAILED: 'STEALTH_SCRIPT_INJECTION_FAILED',

  // 配置错误
  INVALID_CONFIG: 'STEALTH_INVALID_CONFIG',
  UNSUPPORTED_PLATFORM: 'STEALTH_UNSUPPORTED_PLATFORM',
} as const;

// eslint-disable-next-line no-redeclare
export type StealthErrorCode = (typeof StealthErrorCode)[keyof typeof StealthErrorCode];

// ============================================
// 查询引擎相关错误码
// ============================================

export const QueryEngineErrorCode = {
  // 配置错误
  INVALID_CONFIG: 'QUERY_INVALID_CONFIG',
  FIELD_NOT_FOUND: 'QUERY_FIELD_NOT_FOUND',
  INVALID_PARAMETER: 'QUERY_INVALID_PARAMETER',
  MISSING_REQUIRED_PARAM: 'QUERY_MISSING_REQUIRED_PARAM',

  // Builder 错误
  INVALID_FILTER: 'QUERY_INVALID_FILTER',
  INVALID_COMPUTE: 'QUERY_INVALID_COMPUTE',
  INVALID_VALIDATION: 'QUERY_INVALID_VALIDATION',
  INVALID_LOOKUP: 'QUERY_INVALID_LOOKUP',
  INVALID_CLEAN: 'QUERY_INVALID_CLEAN',
  INVALID_DEDUPE: 'QUERY_INVALID_DEDUPE',
  INVALID_SORT: 'QUERY_INVALID_SORT',
  INVALID_COLUMN: 'QUERY_INVALID_COLUMN',

  // SQL 生成错误
  SQL_GENERATION_FAILED: 'QUERY_SQL_GENERATION_FAILED',
  UNSUPPORTED_OPERATION: 'QUERY_UNSUPPORTED_OPERATION',

  // 执行错误
  EXECUTION_FAILED: 'QUERY_EXECUTION_FAILED',
  DATASET_NOT_FOUND: 'QUERY_DATASET_NOT_FOUND',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',

  // 安全错误
  SQL_INJECTION_ATTEMPT: 'QUERY_SQL_INJECTION_ATTEMPT',
  EXPRESSION_TOO_LONG: 'QUERY_EXPRESSION_TOO_LONG',
  DANGEROUS_KEYWORD: 'QUERY_DANGEROUS_KEYWORD',
  INVALID_CHARACTERS: 'QUERY_INVALID_CHARACTERS',

  // 资源限制错误
  LIMIT_EXCEEDED: 'QUERY_LIMIT_EXCEEDED',
  PAGE_OUT_OF_RANGE: 'QUERY_PAGE_OUT_OF_RANGE',
  TOPK_TOO_LARGE: 'QUERY_TOPK_TOO_LARGE',
} as const;

// eslint-disable-next-line no-redeclare
export type QueryEngineErrorCode = (typeof QueryEngineErrorCode)[keyof typeof QueryEngineErrorCode];

// ============================================
// 插件注册中心相关错误码
// ============================================

export const RegistryErrorCode = {
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  API_NOT_FOUND: 'API_NOT_FOUND',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  INVALID_PARAMS: 'INVALID_PARAMS',
} as const;

// eslint-disable-next-line no-redeclare
export type RegistryErrorCode = (typeof RegistryErrorCode)[keyof typeof RegistryErrorCode];

// ============================================
// 聚合所有错误码
// ============================================

export const ErrorCode = {
  ...CommonErrorCode,
  ...BrowserErrorCode,
  ...PluginErrorCode,
  ...DatabaseErrorCode,
  ...AIErrorCode,
  ...BrowserPoolErrorCode,
  ...StealthErrorCode,
  ...QueryEngineErrorCode,
  ...RegistryErrorCode,
} as const;

// eslint-disable-next-line no-redeclare
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================
// 结构化错误接口
// ============================================

/**
 * 统一的结构化错误接口
 *
 * 提供机器可读的错误信息，适用于：
 * - MCP 工具返回给 AI
 * - IPC 错误传输
 * - 日志记录
 */
export interface StructuredError {
  /** 错误代码（从 ErrorCode 常量） */
  code: string;
  /** 人类可读的错误消息 */
  message: string;
  /** 详细错误信息（可选） */
  details?: string;
  /** 建议的解决方案（可选） */
  suggestion?: string;
  /** 相关上下文数据（可选） */
  context?: Record<string, unknown>;
  reasonCode?: string;
  retryable?: boolean;
  recommendedNextTools?: string[];
  authoritativeFields?: string[];
  candidates?: Array<Record<string, unknown>>;
  nextActionHints?: string[];
}

export interface StructuredErrorPayload extends Record<string, unknown> {
  ok: false;
  summary: string;
  error: StructuredError;
  nextActionHints: string[];
  recommendedNextTools: string[];
  authoritativeFields: string[];
  retryable: boolean;
}

/**
 * 创建结构化错误
 */
export function createStructuredError(
  code: string,
  message: string,
  options?: {
    details?: string;
    suggestion?: string;
    context?: Record<string, unknown>;
    reasonCode?: string;
    retryable?: boolean;
    recommendedNextTools?: string[];
    authoritativeFields?: string[];
    candidates?: Array<Record<string, unknown>>;
    nextActionHints?: string[];
  }
): StructuredError {
  return {
    code,
    message,
    details: options?.details,
    suggestion: options?.suggestion,
    context: options?.context,
    reasonCode: options?.reasonCode,
    retryable: options?.retryable,
    recommendedNextTools: options?.recommendedNextTools,
    authoritativeFields: options?.authoritativeFields,
    candidates: options?.candidates,
    nextActionHints: options?.nextActionHints,
  };
}

export function createStructuredErrorPayload(error: StructuredError): StructuredErrorPayload {
  const fallbackMessage = 'Capability execution failed';
  const nextActionHints =
    Array.isArray(error.nextActionHints) && error.nextActionHints.length > 0
      ? error.nextActionHints.map((item) => String(item || '').trim()).filter(Boolean)
      : [String(error.suggestion || '').trim()].filter(Boolean);
  const recommendedNextTools = Array.isArray(error.recommendedNextTools)
    ? error.recommendedNextTools.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const authoritativeFields = Array.isArray(error.authoritativeFields)
    ? error.authoritativeFields.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    ok: false,
    summary: String(error.message || '').trim() || fallbackMessage,
    error: {
      code: String(error.code || '').trim() || ErrorCode.OPERATION_FAILED,
      message: String(error.message || '').trim() || fallbackMessage,
      ...(String(error.details || '').trim() ? { details: String(error.details || '').trim() } : {}),
      ...(String(error.suggestion || '').trim()
        ? { suggestion: String(error.suggestion || '').trim() }
        : {}),
      ...(error.context ? { context: error.context } : {}),
      ...(String(error.reasonCode || '').trim()
        ? { reasonCode: String(error.reasonCode || '').trim() }
        : {}),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(recommendedNextTools.length ? { recommendedNextTools } : {}),
      ...(authoritativeFields.length ? { authoritativeFields } : {}),
      ...(Array.isArray(error.candidates) && error.candidates.length > 0
        ? { candidates: error.candidates }
        : {}),
      ...(nextActionHints.length ? { nextActionHints } : {}),
    },
    nextActionHints,
    recommendedNextTools,
    authoritativeFields,
    retryable: error.retryable === true,
  };
}

export function formatStructuredErrorText(error: StructuredError): string {
  const parts = [`ERROR [${error.code}] ${error.message}`];

  if (error.details) {
    parts.push(`\nDetails: ${error.details}`);
  }

  if (error.suggestion) {
    parts.push(`\nSuggestion: ${error.suggestion}`);
  }

  if (error.context) {
    parts.push(`\nContext: ${JSON.stringify(error.context, null, 2)}`);
  }

  return parts.join('');
}
