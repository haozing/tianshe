/**
 * Browser Pool 端口接口
 *
 * 用于消除 core→main 的 C 类类型导入。
 * 定义 core 层所需的视图/窗口管理能力的最小子集。
 */

import type { BrowserWindow, WebContents } from 'electron';
import type { ViewBounds } from '../layout/layout-calculator';

// =====================================================
// 视图显示模式
// =====================================================

export type ViewDisplayMode = 'fullscreen' | 'offscreen' | 'popup' | 'docked-right';

// =====================================================
// 视图来源
// =====================================================

export type ViewSource = 'plugin' | 'mcp' | 'pool' | 'account';

// =====================================================
// 弹窗配置
// =====================================================

export interface PopupWindowConfig {
  title?: string;
  width?: number;
  height?: number;
  center?: boolean;
  parent?: BrowserWindow;
  modal?: boolean;
  openDevTools?: boolean;
  onClose?: () => void;
}

// =====================================================
// 窗口管理器端口
// =====================================================

export interface IWindowManager {
  getMainWindowV3(): BrowserWindow | undefined;
  getWindowById(id: string): BrowserWindow | undefined;
  createPopupWindow(popupId: string, config?: PopupWindowConfig): BrowserWindow;
  setPopupViewId(popupId: string, viewId: string): void;
  closeWindowById(id: string): void;
}

// =====================================================
// WebContentsView 管理器端口
// =====================================================

export interface IWebContentsViewManager {
  getActivityBarWidth(): number;
  attachView(viewId: string, windowId: string, bounds: ViewBounds): void;
  attachViewOffscreen(viewId: string, windowId?: string): boolean;
  detachView(viewId: string): void;
  getView(viewId: string): { view: any; attachedTo?: string; bounds?: { x: number; y: number; width: number; height: number }; lastAccessedAt?: number } | undefined;
  updateBounds(viewId: string, bounds: ViewBounds): void;
  setViewDisplayMode(viewId: string, displayMode: ViewDisplayMode): boolean;
  setViewSource(viewId: string, source: ViewSource): boolean;
  setRightDockedPoolView(viewId: string, size: number | string | undefined, pluginId?: string): boolean;
  clearRightDockedPoolView(viewId?: string): boolean;
  cleanupPluginViews(pluginId: string): Promise<void> | void;
  registerPluginPageView(pluginId: string, viewConfig: any): string;
  applyStealthToWebContents(
    viewId: string,
    webContents: WebContents,
    partition: string,
    options: any
  ): Promise<void>;
  detachStealthFromWebContents(viewId: string, webContents: WebContents): void;
}
