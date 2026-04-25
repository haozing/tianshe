/**
 * 全局常量定义
 * 将所有硬编码的 magic numbers 集中管理，提高可维护性
 */

// ============================================================================
// WebContentsView 相关常量
// ============================================================================

/**
 * WebContentsView 池的最大容量
 * 限制同时存在的 WebContentsView 数量，防止内存溢出
 */
export const MAX_WEBCONTENTSVIEWS = 15;

/**
 * 单个 WebContentsView 的估算内存占用（MB）
 */
export const PER_VIEW_MEMORY_MB = 150;

// ============================================================================
// 超时相关常量（单位：毫秒）
// ============================================================================

/**
 * 默认断言超时时间：5 秒
 * 用于 waitFor、waitForSelector 等断言操作
 */
export const DEFAULT_ASSERTION_TIMEOUT = 5000;

/**
 * 默认 Workflow 总超时时间：5 分钟
 * 防止 workflow 执行时间过长
 */
export const DEFAULT_WORKFLOW_TIMEOUT = 300000;

/**
 * 默认调度间隔：1 分钟
 * scheduled 模式下的默认执行间隔
 */
export const DEFAULT_SCHEDULE_INTERVAL = 60000;

/**
 * 默认数据拉取间隔：5 秒
 * data-driven 模式下的默认拉取间隔
 */
export const DEFAULT_PULL_INTERVAL = 5000;

/**
 * 健康检查间隔：1 分钟
 * 系统健康状态检查的时间间隔
 */
export const HEALTH_CHECK_INTERVAL = 60000;

// ============================================================================
// 数据库连接池相关常量
// ============================================================================

/**
 * 连接空闲超时：5 分钟
 * 空闲连接在 5 分钟后自动释放
 */
export const CONNECTION_IDLE_TIMEOUT = 300000;

/**
 * 连接泄漏检测阈值：1 分钟
 * 连接被借出超过此时间将触发泄漏警告
 */
export const LEAK_DETECTION_THRESHOLD = 60000;

/**
 * 默认最小连接数
 */
export const DEFAULT_MIN_CONNECTIONS = 1;

/**
 * 默认最大连接数
 */
export const DEFAULT_MAX_CONNECTIONS = 5;

// ============================================================================
// 循环和并发控制常量
// ============================================================================

/**
 * 默认最大循环迭代次数
 * 防止无限循环
 */
export const DEFAULT_MAX_LOOP_ITERATIONS = 100;

/**
 * 默认并发数
 * 用于批量执行任务时的并发控制
 */
export const DEFAULT_CONCURRENCY = 1;

// ============================================================================
// 其他常量
// ============================================================================

/**
 * 默认视口大小
 */
export const DEFAULT_VIEWPORT = {
  width: 1920,
  height: 1080,
};

/**
 * 默认 Partition
 */
export const DEFAULT_PARTITION = 'default';
