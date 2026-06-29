/**
 * AI 浏览器控制系统 - MCP 集成
 *
 * 提供 Claude Code 通过 MCP 协议控制浏览器的能力
 * 使用 HTTP 传输，可在设置页面的 HTTP API 标签中启用
 */

// 类型导出
export type {
  // 快照相关
  PageSnapshot,
  SnapshotElement,
  NetworkEntry,
  ConsoleMessage,
  // 日志相关
  Logger,
} from './types';

// 日志工具导出
export { silentLogger, consoleLogger } from './types';

// 浏览器接口（从共享类型直接导入）
export type { BrowserInterface } from '../../types/browser-interface';
