/**
 * Raw Namespace - 核心原生 Electron API
 *
 * 提供对 WebContents 核心方法的直接访问
 */

import type { WebContents, PrintToPDFOptions } from 'electron';

/**
 * 鼠标按钮类型
 */
export type MouseButton = 'left' | 'right' | 'middle';

/**
 * 键盘修饰键
 */
export type KeyModifier = 'shift' | 'control' | 'alt' | 'meta' | 'isKeypad' | 'isAutoRepeat';

/**
 * 输入事件类型
 */
export interface MouseInputEvent {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave' | 'contextMenu';
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  movementX?: number;
  movementY?: number;
  modifiers?: KeyModifier[];
}

export interface MouseWheelEvent {
  type: 'mouseWheel';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers?: KeyModifier[];
}

export interface KeyboardInputEvent {
  type: 'keyDown' | 'keyUp' | 'char';
  keyCode: string;
  modifiers?: KeyModifier[];
}

/**
 * 原生点击选项
 */
export interface NativeClickOptions {
  button?: MouseButton;
  clickCount?: number;
  /** mouseDown 和 mouseUp 之间的延迟（毫秒） */
  delay?: number;
  /** 修饰键 */
  modifiers?: KeyModifier[];
}

/**
 * 原生输入选项
 */
export interface NativeTypeOptions {
  /** 每个字符之间的延迟（毫秒） */
  delay?: number;
  /** 延迟变化范围（随机性） */
  delayVariance?: number;
}

/**
 * 截图选项
 */
export interface CaptureOptions {
  /** 截取区域 */
  rect?: { x: number; y: number; width: number; height: number };
  /** 输出格式 */
  format?: 'png' | 'jpeg';
  /** JPEG 质量（0-100） */
  quality?: number;
}

/**
 * 获取 WebContents 的接口
 */
export interface WebContentsProvider {
  getWebContents(): WebContents;
}

/**
 * RawNamespace - 核心原生 API 命名空间
 *
 * 仅保留 WebContents API，其他 API 已迁移到 SimpleBrowser 子命名空间：
 * - browser.native (原 helpers.raw.input)
 * - browser.getCookies()/setCookie()/clearCookies()/getUserAgent()
 * - browser.screenshot()/screenshotDetailed()/snapshot()
 */
export class RawNamespace {
  /** WebContents API */
  public readonly webContents: WebContentsAPI;

  constructor(private pluginId: string) {
    this.webContents = new WebContentsAPI(pluginId);
  }
}

/**
 * WebContents API
 *
 * 直接访问 WebContents 的核心方法
 */
export class WebContentsAPI {
  constructor(private pluginId: string) {}

  /**
   * 执行 JavaScript 代码
   */
  async executeJavaScript<T = any>(provider: WebContentsProvider, code: string): Promise<T> {
    const webContents = provider.getWebContents();
    return webContents.executeJavaScript(code);
  }

  /**
   * 注入 CSS
   */
  async insertCSS(provider: WebContentsProvider, css: string): Promise<string> {
    const webContents = provider.getWebContents();
    return webContents.insertCSS(css);
  }

  /**
   * 移除注入的 CSS
   */
  async removeInsertedCSS(provider: WebContentsProvider, key: string): Promise<void> {
    const webContents = provider.getWebContents();
    await webContents.removeInsertedCSS(key);
  }

  /**
   * 获取当前 URL
   */
  getURL(provider: WebContentsProvider): string {
    const webContents = provider.getWebContents();
    return webContents.getURL();
  }

  /**
   * 获取页面标题
   */
  getTitle(provider: WebContentsProvider): string {
    const webContents = provider.getWebContents();
    return webContents.getTitle();
  }

  /**
   * 是否正在加载
   */
  isLoading(provider: WebContentsProvider): boolean {
    const webContents = provider.getWebContents();
    return webContents.isLoading();
  }

  /**
   * 是否可以后退
   */
  canGoBack(provider: WebContentsProvider): boolean {
    const webContents = provider.getWebContents();
    return webContents.canGoBack();
  }

  /**
   * 是否可以前进
   */
  canGoForward(provider: WebContentsProvider): boolean {
    const webContents = provider.getWebContents();
    return webContents.canGoForward();
  }

  /**
   * 刷新页面
   */
  reload(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.reload();
  }

  /**
   * 强制刷新（忽略缓存）
   */
  reloadIgnoringCache(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.reloadIgnoringCache();
  }

  /**
   * 停止加载
   */
  stop(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.stop();
  }

  /**
   * 后退
   */
  goBack(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.goBack();
  }

  /**
   * 前进
   */
  goForward(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.goForward();
  }

  /**
   * 设置缩放因子
   */
  setZoomFactor(provider: WebContentsProvider, factor: number): void {
    const webContents = provider.getWebContents();
    webContents.setZoomFactor(factor);
  }

  /**
   * 获取缩放因子
   */
  getZoomFactor(provider: WebContentsProvider): number {
    const webContents = provider.getWebContents();
    return webContents.getZoomFactor();
  }

  /**
   * 设置缩放级别
   */
  setZoomLevel(provider: WebContentsProvider, level: number): void {
    const webContents = provider.getWebContents();
    webContents.setZoomLevel(level);
  }

  /**
   * 获取缩放级别
   */
  getZoomLevel(provider: WebContentsProvider): number {
    const webContents = provider.getWebContents();
    return webContents.getZoomLevel();
  }

  /**
   * 插入文本
   */
  async insertText(provider: WebContentsProvider, text: string): Promise<void> {
    const webContents = provider.getWebContents();
    await webContents.insertText(text);
  }

  /**
   * 全选
   */
  selectAll(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.selectAll();
  }

  /**
   * 复制
   */
  copy(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.copy();
  }

  /**
   * 粘贴
   */
  paste(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.paste();
  }

  /**
   * 剪切
   */
  cut(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.cut();
  }

  /**
   * 撤销
   */
  undo(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.undo();
  }

  /**
   * 重做
   */
  redo(provider: WebContentsProvider): void {
    const webContents = provider.getWebContents();
    webContents.redo();
  }

  /**
   * 页面查找
   */
  findInPage(
    provider: WebContentsProvider,
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
  ): number {
    const webContents = provider.getWebContents();
    return webContents.findInPage(text, options);
  }

  /**
   * 停止页面查找
   */
  stopFindInPage(
    provider: WebContentsProvider,
    action: 'clearSelection' | 'keepSelection' | 'activateSelection'
  ): void {
    const webContents = provider.getWebContents();
    webContents.stopFindInPage(action);
  }

  /**
   * 设置静音
   */
  setAudioMuted(provider: WebContentsProvider, muted: boolean): void {
    const webContents = provider.getWebContents();
    webContents.setAudioMuted(muted);
  }

  /**
   * 是否静音
   */
  isAudioMuted(provider: WebContentsProvider): boolean {
    const webContents = provider.getWebContents();
    return webContents.isAudioMuted();
  }

  /**
   * 打印到 PDF
   */
  async printToPDF(provider: WebContentsProvider, options?: PrintToPDFOptions): Promise<Buffer> {
    const webContents = provider.getWebContents();
    return webContents.printToPDF(options || {});
  }
}
