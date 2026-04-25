/**
 * 页面分析器
 * 用于提取页面摘要信息，让大模型快速理解页面
 */

import type { SnapshotElement } from '../browser-core/types';

/**
 * 支持的页面类型
 */
export type PageType =
  | 'login' // 登录页
  | 'register' // 注册页
  | 'search' // 搜索页
  | 'search-results' // 搜索结果页
  | 'list' // 列表页
  | 'detail' // 详情页
  | 'form' // 表单页
  | 'dashboard' // 仪表板
  | 'profile' // 个人资料页
  | 'settings' // 设置页
  | 'checkout' // 结账页
  | 'article' // 文章页
  | 'landing' // 落地页
  | 'unknown'; // 未知类型

/**
 * 页面结构信息
 */
export interface PageStructure {
  hasHeader: boolean;
  hasNavigation: boolean;
  hasMainContent: boolean;
  hasSidebar: boolean;
  hasFooter: boolean;
  mainHeading?: string;
  sections?: Array<{ heading: string; elementCount: number }>;
}

/**
 * 关键元素统计
 */
export interface KeyElementsCount {
  forms: number;
  textInputs: number;
  passwordInputs: number;
  checkboxes: number;
  radioButtons: number;
  selectBoxes: number;
  buttons: number;
  links: number;
  images: number;
}

/**
 * 登录状态摘要（用于页面分析）
 */
export interface LoginStatusSummary {
  /** 是否可能需要登录 */
  mayNeedLogin: boolean;
  /** 页面是否为登录/注册页 */
  isAuthPage: boolean;
  /** 检测到的登录相关元素 */
  authElements: {
    hasLoginForm: boolean;
    hasPasswordField: boolean;
    hasLoginButton: boolean;
    hasLogoutButton: boolean;
    hasUserMenu: boolean;
  };
  /** 建议 */
  suggestion?: string;
}

/**
 * 页面摘要
 */
export interface PageSummary {
  // 页面类型
  pageType: PageType;
  confidence: number;

  // 页面意图
  intent: string;

  // 页面结构
  structure: PageStructure;

  // 关键元素统计
  keyElements: KeyElementsCount;

  // 主要操作（包含 attributes 供构建选择器）
  primaryActions: Array<{
    type: string;
    text: string;
    attributes?: SnapshotElement['attributes'];
  }>;

  // 主要输入字段（包含 attributes 供构建选择器）
  primaryInputs: Array<{
    label: string;
    type: string;
    attributes?: SnapshotElement['attributes'];
    required: boolean;
    value?: string;
  }>;

  // 次要链接
  secondaryLinks: Array<{
    text: string;
    href: string;
  }>;

  // 登录状态摘要
  loginStatus?: LoginStatusSummary;
}

/**
 * 页面分析器
 */
export class PageAnalyzer {
  /**
   * 分析页面并生成摘要
   */
  static analyze(elements: SnapshotElement[], structure?: PageStructure): PageSummary {
    // 1. 识别页面类型
    const pageTypeResult = this.detectPageType(elements);

    // 2. 统计关键元素
    const keyElementsCount = this.countKeyElements(elements);

    // 3. 提取关键元素
    const keyElements = this.extractKeyElements(elements);

    // 4. 生成页面意图
    const intent = this.generateIntent(pageTypeResult.type, keyElements, keyElementsCount);

    return {
      pageType: pageTypeResult.type,
      confidence: pageTypeResult.confidence,
      intent,
      structure: structure || this.getDefaultStructure(),
      keyElements: keyElementsCount,
      ...keyElements,
    };
  }

  /**
   * 识别页面类型
   */
  private static detectPageType(elements: SnapshotElement[]): {
    type: PageType;
    confidence: number;
  } {
    // 登录页特征
    const hasPasswordInput = elements.some((e) => e.attributes?.type === 'password');
    const hasUsernameInput = elements.some(
      (e) =>
        /用户名|邮箱|账号|username|email|account/i.test(e.name || '') ||
        e.attributes?.name === 'username' ||
        e.attributes?.name === 'email' ||
        /用户名|邮箱|账号/i.test(e.placeholder || '')
    );
    const hasLoginButton = elements.some(
      (e) => e.role === 'button' && /登录|login|sign in/i.test(e.name || e.text || '')
    );

    if (hasPasswordInput && hasUsernameInput && hasLoginButton) {
      return {
        type: 'login',
        confidence: 0.95,
      };
    }

    // 注册页特征
    const passwordInputCount = elements.filter((e) => e.attributes?.type === 'password').length;
    const hasRegisterButton = elements.some(
      (e) => e.role === 'button' && /注册|register|sign up/i.test(e.name || e.text || '')
    );

    if (passwordInputCount >= 2 && hasRegisterButton) {
      return {
        type: 'register',
        confidence: 0.9,
      };
    }

    // 搜索页特征
    const hasSearchInput = elements.some(
      (e) =>
        e.role === 'searchbox' ||
        e.attributes?.type === 'search' ||
        /搜索|search/i.test(e.placeholder || '')
    );
    const hasSearchButton = elements.some(
      (e) => e.role === 'button' && /搜索|search/i.test(e.name || e.text || '')
    );

    if (hasSearchInput && hasSearchButton) {
      return {
        type: 'search',
        confidence: 0.9,
      };
    }

    // 列表页特征（大量链接）
    const linkCount = elements.filter((e) => e.role === 'link').length;
    const buttonCount = elements.filter((e) => e.role === 'button').length;

    if (linkCount > 20 && buttonCount < 5) {
      return {
        type: 'list',
        confidence: 0.8,
      };
    }

    // 表单页特征（多个输入框）
    const inputCount = elements.filter(
      (e) => e.role === 'textbox' || e.role === 'combobox' || e.role === 'checkbox'
    ).length;

    if (inputCount >= 5 && buttonCount >= 1) {
      return {
        type: 'form',
        confidence: 0.85,
      };
    }

    // 详情页特征（内容密集，少量交互）
    if (linkCount < 10 && buttonCount < 5 && inputCount < 3) {
      return {
        type: 'detail',
        confidence: 0.7,
      };
    }

    return {
      type: 'unknown',
      confidence: 0.5,
    };
  }

  /**
   * 统计关键元素
   */
  private static countKeyElements(elements: SnapshotElement[]): KeyElementsCount {
    return {
      forms: elements.filter((e) => e.tag === 'form').length,
      textInputs: elements.filter((e) => e.role === 'textbox' && e.attributes?.type !== 'password')
        .length,
      passwordInputs: elements.filter((e) => e.attributes?.type === 'password').length,
      checkboxes: elements.filter((e) => e.role === 'checkbox').length,
      radioButtons: elements.filter((e) => e.role === 'radio').length,
      selectBoxes: elements.filter((e) => e.role === 'combobox' || e.role === 'listbox').length,
      buttons: elements.filter((e) => e.role === 'button').length,
      links: elements.filter((e) => e.role === 'link').length,
      images: elements.filter((e) => e.role === 'img').length,
    };
  }

  /**
   * 提取关键元素
   */
  private static extractKeyElements(elements: SnapshotElement[]) {
    // 主要操作（按钮）
    const primaryActions = elements
      .filter((e) => e.role === 'button' && e.tag === 'button')
      .filter((e) => !e.disabled)
      .map((e) => ({
        type: e.attributes?.type || 'button',
        text: e.name || e.text || '',
        // 提供属性信息供大模型构建选择器
        attributes: e.attributes,
      }))
      .slice(0, 5); // 最多 5 个

    // 主要输入字段
    const primaryInputs = elements
      .filter((e) => e.role === 'textbox' || e.attributes?.type === 'password')
      .map((e) => ({
        label: e.name || e.placeholder || '',
        type: e.attributes?.type || 'text',
        // 提供属性信息供大模型构建选择器
        attributes: e.attributes,
        required: !e.disabled,
        value: e.value || '',
      }))
      .slice(0, 10); // 最多 10 个

    // 次要链接
    const secondaryLinks = elements
      .filter((e) => e.role === 'link')
      .map((e) => ({
        text: e.name || e.text || '',
        href: e.attributes?.href || '',
      }))
      .slice(0, 10); // 最多 10 个

    return {
      primaryActions,
      primaryInputs,
      secondaryLinks,
    };
  }

  /**
   * 生成页面意图
   */
  private static generateIntent(
    pageType: PageType,
    keyElements: {
      primaryInputs: Array<{ label: string }>;
      secondaryLinks: Array<any>;
    },
    stats: KeyElementsCount
  ): string {
    switch (pageType) {
      case 'login':
        return `用户需要输入${keyElements.primaryInputs
          .map((i) => i.label)
          .filter(Boolean)
          .join('和')}进行登录`;

      case 'register':
        return `用户需要填写注册信息（${keyElements.primaryInputs.length} 个字段）创建新账号`;

      case 'search':
        return '用户可以在此页面搜索内容';

      case 'list':
        return `页面展示了 ${stats.links}+ 个项目的列表`;

      case 'form':
        return `用户需要填写表单（${keyElements.primaryInputs.length} 个字段）`;

      case 'detail':
        return '页面展示了详细信息';

      default:
        return '页面内容未明确识别';
    }
  }

  /**
   * 获取默认结构
   */
  private static getDefaultStructure(): PageStructure {
    return {
      hasHeader: false,
      hasNavigation: false,
      hasMainContent: false,
      hasSidebar: false,
      hasFooter: false,
    };
  }
}
