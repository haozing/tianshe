/**
 * 浏览器分析模块
 *
 * 提供页面分析、登录检测等业务层分析功能。
 * 这些功能从 browser-core 分离，作为可选的业务层扩展。
 */

// 页面分析
export { PageAnalyzer } from './page-analyzer';
export type {
  PageType,
  PageStructure,
  KeyElementsCount,
  LoginStatusSummary,
  PageSummary,
} from './page-analyzer';
