import type { WebContentsView } from 'electron';
import type { StealthConfig } from '../core/stealth';

/**
 * View 边界
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OFFSCREEN_BOUNDS: ViewBounds = {
  x: 10000,
  y: 0,
  width: 1920,
  height: 1080,
};

/**
 * 视图显示模式
 * - fullscreen: 全屏显示（占满内容区域）
 * - offscreen: 离屏显示（不可见，用于后台自动化）
 * - popup: 弹窗显示（在独立弹窗窗口中）
 * - docked-right: 固定停靠到主窗口右栏（用于 helpers.profile.launch 可见视图）
 */
export type ViewDisplayMode = 'fullscreen' | 'offscreen' | 'popup' | 'docked-right';
export type ViewSource = 'plugin' | 'mcp' | 'pool' | 'account';
export type ViewDetachScope = 'all' | 'automation' | 'plugin';

export interface ViewMetadata {
  label?: string;
  icon?: string;
  order?: number;
  color?: string;
  pluginId?: string;
  temporary?: boolean;
  profileId?: string;
  displayMode?: ViewDisplayMode;
  source?: ViewSource;
  security?: {
    webSecurity?: boolean;
    allowRunningInsecureContent?: boolean;
    disableCSP?: boolean;
    allowedPermissions?: string[];
  };
  stealth?: StealthConfig;
  openDevTools?: boolean;
}

export interface ViewRegistration {
  id: string;
  partition: string;
  url?: string;
  metadata?: ViewMetadata;
}

export interface WebContentsViewInfo {
  id: string;
  view: WebContentsView;
  partition: string;
  attachedTo?: string;
  bounds?: ViewBounds;
  createdAt: number;
  lastAccessedAt: number;
  metadata?: ViewMetadata;
}

export interface DetachScopedViewsOptions {
  windowId?: string;
  scope?: ViewDetachScope;
  preserveDockedRight?: boolean;
}

