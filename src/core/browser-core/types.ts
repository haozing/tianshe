/**
 * 浏览器核心类型定义
 *
 * 用于页面快照、选择器生成、网络监控等功能
 *
 * 此文件是 browser-core 模块的基础类型定义，
 * 被 js-plugin 和 ai-dev 共同使用。
 */

import type { PageSummary } from '../browser-analysis/page-analyzer';

/**
 * 页面快照
 * 大模型用于理解页面结构，获取推荐的选择器
 */
export interface PageSnapshot {
  /** 当前页面 URL */
  url: string;

  /** 页面标题 */
  title: string;

  /** 可交互元素列表 */
  elements: SnapshotElement[];

  /** 智能页面摘要（包含页面类型、意图、关键元素等） */
  summary?: PageSummary;

  /** 网络请求记录（如果启用了网络监控） */
  network?: NetworkEntry[];

  /** 网络请求摘要（智能统计和分类） */
  networkSummary?: {
    total: number;
    byType: Record<string, number>;
    byMethod: Record<string, number>;
    failed: Array<{ url: string; status: number; method: string }>;
    slow: Array<{ url: string; duration: number; method: string }>;
    apiCalls: NetworkEntry[];
  };

  /** 控制台消息（如果启用了控制台监控） */
  console?: ConsoleMessage[];
}

/**
 * 快照中的元素信息
 */
export interface SnapshotElement {
  /** HTML 标签名 */
  tag: string;

  /** ARIA 角色 */
  role: string;

  /** 可访问名称（按钮文字、链接文本等） */
  name: string;

  /** 文本内容 */
  text?: string;

  /** 输入框的值 */
  value?: string;

  /** 占位符文本 */
  placeholder?: string;

  /** 是否被选中（复选框/单选框） */
  checked?: boolean;

  /** 是否禁用 */
  disabled?: boolean;

  /**
   * 元素属性（帮助大模型理解元素，用于自行构建选择器）
   * 大模型可基于这些属性构建选择器，并使用 browser_validate_selector 验证
   */
  attributes?: {
    id?: string;
    class?: string;
    name?: string;
    type?: string;
    href?: string;
    src?: string;
    'data-testid'?: string;
    'aria-label'?: string;
  };

  /** 推荐优先使用的选择器 */
  preferredSelector?: string;

  /** 可供大模型兜底尝试的选择器候选 */
  selectorCandidates?: string[];

  /** Opaque reference token for follow-up MCP actions */
  elementRef?: string;

  /** Whether any visible portion of the element intersects the current viewport */
  inViewport?: boolean;

  /** 元素边界（视口坐标） */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * 网络请求记录
 */
export interface NetworkEntry {
  /** 请求 ID */
  id: string;

  /** 请求 URL */
  url: string;

  /** HTTP 方法 */
  method: string;

  /** 资源类型 */
  resourceType: string;

  /** 稳定分类，供 LLM/MCP 过滤使用 */
  classification: 'document' | 'api' | 'static' | 'media' | 'other';

  /** HTTP 状态码 */
  status?: number;

  /** 状态文本 */
  statusText?: string;

  /** 请求头 */
  requestHeaders?: Record<string, string>;

  /** 响应头 */
  responseHeaders?: Record<string, string>;

  /** 请求体 */
  requestBody?: string;

  /** 响应体（可能很大，谨慎使用） */
  responseBody?: string;

  /** 请求开始时间 */
  startTime: number;

  /** 请求结束时间 */
  endTime?: number;

  /** 请求耗时（毫秒） */
  duration?: number;

  /** 错误信息 */
  error?: string;
}

/**
 * 控制台消息
 */
export interface ConsoleMessage {
  /** 日志级别 */
  level: 'verbose' | 'info' | 'warning' | 'error';

  /** 消息内容 */
  message: string;

  /** 来源文件 */
  source?: string;

  /** 行号 */
  line?: number;

  /** 时间戳 */
  timestamp: number;
}

/**
 * 快照选项
 */
export interface SnapshotOptions {
  /** 等待特定元素出现后再快照 */
  waitFor?: string;

  /** 等待超时时间（毫秒） */
  timeout?: number;

  /** 是否包含智能摘要 */
  includeSummary?: boolean;

  /**
   * 是否包含网络请求记录
   * - true: 包含全部网络请求
   * - 'smart': 仅包含 API 请求
   * - false: 不包含
   */
  includeNetwork?: boolean | 'smart';

  /** 是否包含控制台消息 */
  includeConsole?: boolean;

  /** 元素过滤模式 */
  elementsFilter?: 'all' | 'interactive';
}

/**
 * 点击选项
 */
export interface ClickOptions {
  /** 等待超时时间（毫秒） */
  timeout?: number;

  /** 强制点击（不检查可见性） */
  force?: boolean;

  /** 点击前延迟（毫秒） */
  delay?: number;

  /**
   * 人类化点击配置（模拟真人鼠标移动轨迹）
   *
   * @example
   * human: {
   *   enabled: true,
   *   moveDuration: 800, // 鼠标移动 800ms
   *   curve: 'bezier',   // 贝塞尔曲线轨迹
   *   overshoot: true    // 轻微过冲
   * }
   */
  human?: {
    /** 是否启用人类化 */
    enabled: boolean;

    /** 鼠标移动耗时（毫秒） */
    moveDuration?: number;

    /** 轨迹曲线类型 */
    curve?: 'linear' | 'bezier';

    /** 是否过冲（鼠标移动稍微超过目标再回拉） */
    overshoot?: boolean;
  };
}

/**
 * 输入选项
 */
export interface TypeOptions {
  /** 等待超时时间（毫秒） */
  timeout?: number;

  /** 按键间隔（毫秒），模拟人类输入 */
  delay?: number;

  /** 输入前先清空 */
  clear?: boolean;

  /**
   * 人类化打字配置（模拟真人打字行为）
   *
   * @example
   * human: {
   *   enabled: true,
   *   minDelay: 50,     // 最小按键间隔 50ms
   *   maxDelay: 150,    // 最大按键间隔 150ms
   *   typoRate: 0.02    // 2% 打字错误率
   * }
   */
  human?: {
    /** 是否启用人类化 */
    enabled: boolean;

    /** 最小按键间隔（毫秒） */
    minDelay?: number;

    /** 最大按键间隔（毫秒） */
    maxDelay?: number;

    /** 打字错误率（0-1，0 = 无错误，1 = 全部错误） */
    typoRate?: number;
  };
}

/**
 * 等待选择器选项
 */
export interface WaitForSelectorOptions {
  /** 等待状态 */
  state?: 'attached' | 'visible' | 'hidden';

  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 网络捕获选项
 */
export interface NetworkCaptureOptions {
  /** URL 过滤正则表达式 */
  urlFilter?: string;

  /** 是否捕获请求/响应体 */
  captureBody?: boolean;

  /** 最大记录数 */
  maxEntries?: number;

  /** 开始新一轮抓包前是否清空已有记录 */
  clearExisting?: boolean;
}

/**
 * Cookie 类型
 */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

// ========== 新窗口拦截 ==========

/**
 * 新窗口打开行为
 */
export type WindowOpenAction = 'deny' | 'allow' | 'same-window';

/**
 * 新窗口打开规则
 *
 * @example
 * // 匹配特定域名
 * { match: 'jinritemai.com', action: 'same-window' }
 *
 * // 使用正则表达式
 * { match: /compass\.jinritemai\.com/, action: 'same-window' }
 *
 * // 使用通配符模式
 * { match: '*douyin*', action: 'same-window' }
 */
export interface WindowOpenRule {
  /**
   * URL 匹配模式
   * - string: 包含匹配（支持 * 通配符）
   * - RegExp: 正则匹配
   */
  match: string | RegExp;

  /** 匹配后的行为 */
  action: WindowOpenAction;
}

/**
 * 新窗口打开策略
 *
 * 控制页面中 window.open() 或 target="_blank" 链接的行为
 *
 * @example
 * // 所有新窗口都在当前页面打开
 * { default: 'same-window' }
 *
 * // 拒绝所有新窗口，但特定域名在当前页面打开
 * {
 *   default: 'deny',
 *   rules: [
 *     { match: '*jinritemai.com*', action: 'same-window' },
 *     { match: '*compass*', action: 'same-window' },
 *   ]
 * }
 *
 * // 允许所有新窗口，但拒绝 about:blank
 * {
 *   default: 'allow',
 *   rules: [
 *     { match: 'about:blank', action: 'deny' },
 *   ]
 * }
 */
export interface WindowOpenPolicy {
  /**
   * 默认行为（规则未匹配时使用）
   * - 'deny': 拒绝打开新窗口
   * - 'allow': 允许打开新窗口
   * - 'same-window': 在当前窗口打开（导航）
   */
  default: WindowOpenAction;

  /**
   * 规则列表（按顺序匹配，先匹配先生效）
   */
  rules?: WindowOpenRule[];
}

/**
 * 新窗口打开详情（传递给事件处理器）
 */
export interface WindowOpenDetails {
  /** 目标 URL */
  url: string;

  /** 窗口名称（target 属性） */
  frameName: string;

  /**
   * 打开方式
   * - 'default': 默认行为
   * - 'foreground-tab': 前台标签页
   * - 'background-tab': 后台标签页
   * - 'new-window': 新窗口
   * - 'save-to-disk': 下载
   * - 'other': 其他
   */
  disposition:
    | 'default'
    | 'foreground-tab'
    | 'background-tab'
    | 'new-window'
    | 'save-to-disk'
    | 'other';

  /** 来源 URL */
  referrer: string;
}
