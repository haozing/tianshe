/**
 * WebContentsView 管理器
 * 特性：
 * - 最多管理 15 个 WebContentsView
 * - 手动生命周期管理（无自动回收）
 * - 每个 View 独立 partition（会话隔离）
 * - 支持 CDP 调试协议
 */

import { WebContentsView, WebContents, app } from 'electron';
import type { Session, Rectangle } from 'electron';
import fs from 'fs';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { loadWebContentsURL } from './webcontents-navigation';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';
import {
  ACTIVITY_BAR_WIDTH,
  ACTIVITY_BAR_WIDTH_EXPANDED,
  DEFAULT_MAX_POOL_SIZE,
  DEFAULT_SPLIT_SIZE,
  MIN_VIEW_SIZE,
} from '../constants/layout';
import { CLOUD_WORKBENCH_VIEW_ID } from '../constants/cloud';
import { LayoutCalculator } from './layout-calculator';
import {
  buildPluginLayoutInfo,
  calculateDockedPluginPageBounds,
  calculateMainWindowPluginLayout,
  type PluginLayoutInfo,
} from './plugin-layout';
import type { JSPluginManager } from '../core/js-plugin/manager';
import type { ActivityBarViewContribution } from '../types/js-plugin';
import {
  fingerprintManager,
  generateFullStealthScript,
  generateCDPCommands,
  generateDebuggerHidingCommands,
  buildLowEntropyClientHintsHeaders,
  buildHighEntropyClientHintsHeaders,
  buildAcceptLanguageHeaderValue,
  type LowEntropyClientHintsHeaders,
  type HighEntropyClientHintsHeaders,
  type StealthOptions,
  type StealthConfig,
} from '../core/stealth';
import { attachNavigationGuards } from '../core/browser-core/navigation-guard';
import { getSessionWebRequestHub } from '../core/browser-core/web-request-hub';
import { maybeOpenInternalBrowserDevTools } from './internal-browser-devtools';

/**
 * WebContents 扩展接口（包含未在官方类型中定义的方法）
 */
interface WebContentsWithDestroy extends WebContents {
  destroy(): void;
}

interface WebContentsWithBackgroundThrottling extends WebContents {
  setBackgroundThrottling(enabled: boolean): void;
}

/**
 * 类型守卫：检查 WebContents 是否有 destroy 方法
 */
function hasDestroyMethod(wc: WebContents): wc is WebContentsWithDestroy {
  return typeof (wc as WebContentsWithDestroy).destroy === 'function';
}

function hasBackgroundThrottling(wc: WebContents): wc is WebContentsWithBackgroundThrottling {
  return typeof (wc as WebContentsWithBackgroundThrottling).setBackgroundThrottling === 'function';
}

const stealthDebugLogPath = path.join(app.getPath('userData'), 'stealth-debug.log');

function stealthDebug(message: string): void {
  if (!AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) return;
  try {
    console.log(message);
  } catch {
    // ignore
  }
  try {
    fs.appendFileSync(stealthDebugLogPath, message + '\n');
  } catch {
    // ignore
  }
}

type MutableWebContentsViewInfo = Omit<WebContentsViewInfo, 'view' | 'partition' | 'metadata'> & {
  view: WebContentsView | null;
  partition: string | null;
  metadata?: ViewMetadata | null;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function mergeRequestHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
  value: string
): void {
  headers[key] = value;
  const lower = key.toLowerCase();
  if (lower !== key && lower in headers) {
    delete headers[lower];
  }
}

type HighEntropyHintEntry = {
  headers: HighEntropyClientHintsHeaders;
  expiresAt?: number;
};

type StealthNetworkOverrides = {
  acceptLanguage: string;
  clientHints: LowEntropyClientHintsHeaders;
  highEntropyHints: HighEntropyClientHintsHeaders;
  highEntropyByOrigin: Map<string, HighEntropyHintEntry>;
};

function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.join(',');
    if (typeof value === 'string') return value;
    return null;
  }
  return null;
}

function parseAcceptCH(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^"+|"+$/g, ''));
}

function parseAcceptCHLifetime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch (_e) {
    return null;
  }
}

function boundsAlmostEqual(
  actual: Rectangle,
  desired: { x: number; y: number; width: number; height: number },
  tolerance: number = 1
): boolean {
  return (
    Math.abs(actual.x - desired.x) <= tolerance &&
    Math.abs(actual.y - desired.y) <= tolerance &&
    Math.abs(actual.width - desired.width) <= tolerance &&
    Math.abs(actual.height - desired.height) <= tolerance
  );
}

function filterHighEntropyHints(
  headers: HighEntropyClientHintsHeaders,
  requested: string[]
): HighEntropyClientHintsHeaders {
  if (!requested.length) return {};
  const requestedSet = new Set(
    requested.map((token) =>
      token
        .trim()
        .replace(/^"+|"+$/g, '')
        .toLowerCase()
    )
  );
  const filtered: HighEntropyClientHintsHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (requestedSet.has(key.toLowerCase())) {
      filtered[key as keyof HighEntropyClientHintsHeaders] = value;
    }
  }
  return filtered;
}

/**
 * View 边界
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OFFSCREEN_BOUNDS: ViewBounds = {
  x: 10000,
  y: 0,
  width: 1920,
  height: 1080,
};

const SHARED_PLUGIN_PAGE_VIEW_ID = 'plugin-page:shared';
const SHARED_PLUGIN_PAGE_PARTITION = 'persist:plugin-page-shared';

/**
 * 视图显示模式
 * - fullscreen: 全屏显示（占满内容区域）
 * - offscreen: 离屏显示（不可见，用于后台自动化）
 * - popup: 弹窗显示（在独立弹窗窗口中）
 * - docked-right: 固定停靠到主窗口右栏（用于 helpers.profile.launch 可见视图）
 */
export type ViewDisplayMode = 'fullscreen' | 'offscreen' | 'popup' | 'docked-right';

type MainWorkspaceBounds = {
  windowInfo: { width: number; height: number; activityBarWidth: number };
  fullBounds: ViewBounds;
  pluginBounds: ViewBounds;
  contentTopInset: number;
  rightDockBounds?: ViewBounds;
};

type RightDockedPoolViewState = {
  viewId: string;
  size: number | string;
  pluginId?: string;
};

type PluginDockLayoutState = {
  viewId: string;
  size: number | string;
};

/**
 * 视图来源
 * - plugin: 插件创建（pageView/tempView）
 * - mcp: MCP 会话创建
 * - pool: 浏览器池创建（通过 helpers.profile.launch）
 * - account: 账户登录创建
 */
export type ViewSource = 'plugin' | 'mcp' | 'pool' | 'account';

/**
 * 视图分离作用域
 * - all: 分离指定窗口下的所有视图
 * - automation: 仅分离自动化视图（非插件视图）
 * - plugin: 仅分离插件视图
 */
export type ViewDetachScope = 'all' | 'automation' | 'plugin';

/**
 * View 元数据
 */
export interface ViewMetadata {
  label?: string; // 按钮显示名称
  icon?: string; // 按钮图标（可选）
  order?: number; // 排序
  color?: string; // 颜色标识
  pluginId?: string; // 所属插件ID（用于JSON插件）
  temporary?: boolean; // 🆕 是否为临时视图（用于动态创建的视图）
  profileId?: string; // 🆕 关联的 Profile ID（用于关闭时更新状态）
  /** 🆕 视图显示模式（用于统一 resize 管理） */
  displayMode?: ViewDisplayMode;
  /** 🆕 视图来源（用于区分不同来源的视图） */
  source?: ViewSource;
  /**
   * ?? WebContents 安全策略（按 view/source 可配置）
   *
   * 默认策略：
   * - 所有视图默认启用 webSecurity，禁止混合内容，不移除 CSP
   * - 少数内部兼容场景必须通过 metadata.security 显式放宽
   */
  security?: {
    webSecurity?: boolean;
    allowRunningInsecureContent?: boolean;
    disableCSP?: boolean;
    allowedPermissions?: string[];
  };
  /**
   * 🆕 反检测配置
   * v2.1: 使用 StealthConfig 类型，支持完整的指纹字段
   */
  stealth?: StealthConfig;
  /** 是否自动打开该视图的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
}

/**
 * View 注册配置
 */
export interface ViewRegistration {
  id: string;
  partition: string;
  url?: string;
  metadata?: ViewMetadata;
}

/**
 * WebContentsView 信息
 */
export interface WebContentsViewInfo {
  id: string;
  view: WebContentsView;
  partition: string;
  /** 附加到的窗口 ID (e.g., "main", "popup-xxx") */
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

/**
 * WebContentsView 管理器
 */
export class WebContentsViewManager {
  private registry: Map<string, ViewRegistration> = new Map(); // View 注册表（无限制）
  private pool: Map<string, WebContentsViewInfo> = new Map(); // 实际的 View 池（有限制）
  private viewActivationTasks: Map<string, Promise<WebContentsViewInfo>> = new Map();
  private maxSize: number;
  private pluginPageViewLoads = new Map<string, Promise<void>>();
  private pluginPageViewContributions = new Map<string, ActivityBarViewContribution>();
  private pluginPageViewCurrentPluginByView = new Map<string, string>();
  private sharedPluginPageViewLoadQueue: Promise<void> = Promise.resolve();

  private stealthNetworkOverridesByPartition: Map<string, StealthNetworkOverrides> = new Map();
  private stealthNetworkHookedPartitions: Set<string> = new Set();
  private stealthDebuggerMessageHandlers: Map<
    string,
    (event: unknown, method: string, params: unknown) => void
  > = new Map();
  private navigationGuardCleanupByViewId: Map<string, () => void> = new Map();

  private securityOverridesByPartition: Map<string, { disableCSP: boolean }> = new Map();
  private securityHookedPartitions: Set<string> = new Set();

  // 🆕 资源统计追踪
  private stats = {
    created: 0,
    destroyed: 0,
    failed: 0,
  };

  // 🆕 视图状态管理（用于插件执行）
  private viewStates = new Map<
    string,
    {
      status: 'idle' | 'reserved' | 'busy' | 'error';
      reservedBy?: string; // 保留视图的数据集ID
      reservedAt?: number; // 保留时间戳
      errorMessage?: string; // 错误信息（如果状态为 error）
    }
  >();

  // ✨ 插件管理器引用（用于获取插件 manifest 配置）
  private pluginManager?: JSPluginManager;

  // 🆕 Activity Bar 宽度（用于计算 WebContentsView 的 x 偏移和可用宽度）
  // 默认使用“展开态”宽度（与前端默认 isActivityBarCollapsed=false 保持一致）
  private activityBarWidth = ACTIVITY_BAR_WIDTH_EXPANDED;

  // 🧪 开发调试：检查 view 的实际 bounds / viewport，定位“日志变了但界面不变”的问题
  private viewportDebugTimers = new Map<string, NodeJS.Timeout>();
  private lastViewportDebugKey = new Map<string, string>();

  // 🆕 视图关闭回调（用于 Profile 状态同步）
  private viewClosedCallback?: (viewId: string, metadata?: ViewMetadata) => void;

  // 🆕 右栏停靠视图（固定用于 helpers.profile.launch() 可见模式）
  private rightDockedPoolView: RightDockedPoolViewState | null = null;

  // 🆕 当前激活的插件（用于按插件恢复右栏布局）
  private activePluginId: string | null = null;

  // 🆕 每个插件最近一次的右栏布局状态
  private pluginDockLayouts = new Map<string, PluginDockLayoutState>();

  private resolveStealthConfig(partition: string, metadata?: ViewMetadata): StealthConfig | null {
    const base = metadata?.stealth;
    if (base && base.enabled === false) {
      return base;
    }

    const profileKey = typeof metadata?.profileId === 'string' ? metadata.profileId.trim() : '';
    const derivedProfileKey =
      profileKey ||
      (partition.startsWith('persist:profile-') ? partition.slice('persist:profile-'.length) : '');
    const identityKey =
      typeof base?.identityKey === 'string' && base.identityKey.trim()
        ? base.identityKey.trim()
        : derivedProfileKey || partition;

    if (base) {
      return { ...base, enabled: true, identityKey };
    }

    return { enabled: true, identityKey };
  }

  private ensureStealthNetworkHooks(session: Session, partition: string): void {
    if (this.stealthNetworkHookedPartitions.has(partition)) {
      return;
    }
    this.stealthNetworkHookedPartitions.add(partition);
    const requestHub = getSessionWebRequestHub(session);

    requestHub.subscribeBeforeSendHeaders((details, callback) => {
      const overrides = this.stealthNetworkOverridesByPartition.get(partition);
      if (!overrides || !details.url.startsWith('http')) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }

      const requestHeaders = { ...details.requestHeaders } as Record<string, string | string[]>;

      mergeRequestHeader(requestHeaders, 'Accept-Language', overrides.acceptLanguage);

      for (const [key, value] of Object.entries(overrides.clientHints)) {
        mergeRequestHeader(requestHeaders, key, value);
      }

      const origin = getOrigin(details.url);
      if (origin) {
        const highEntropyEntry = overrides.highEntropyByOrigin.get(origin);
        if (highEntropyEntry) {
          if (highEntropyEntry.expiresAt && highEntropyEntry.expiresAt <= Date.now()) {
            overrides.highEntropyByOrigin.delete(origin);
          } else {
            for (const [key, value] of Object.entries(highEntropyEntry.headers)) {
              if (typeof value === 'string') {
                mergeRequestHeader(requestHeaders, key, value);
              }
            }
          }
        }
      }

      if (
        AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders &&
        details.resourceType === 'mainFrame'
      ) {
        const acceptLanguage = requestHeaders['Accept-Language'];
        const secChUa = requestHeaders['Sec-CH-UA'];
        const secChUaPlatform = requestHeaders['Sec-CH-UA-Platform'];
        const secChUaPlatformVersion = requestHeaders['Sec-CH-UA-Platform-Version'];
        stealthDebug(
          `[Stealth][Network] partition=${partition} url=${details.url} Accept-Language=${String(
            acceptLanguage
          )} Sec-CH-UA=${String(secChUa)} Sec-CH-UA-Platform=${String(
            secChUaPlatform
          )} Sec-CH-UA-Platform-Version=${String(secChUaPlatformVersion)}`
        );
      }

      callback({ requestHeaders });
    });

    requestHub.subscribeHeadersReceived((details, callback) => {
      const overrides = this.stealthNetworkOverridesByPartition.get(partition);
      if (!overrides || !details.url.startsWith('http')) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const acceptCH = getHeaderValue(details.responseHeaders, 'accept-ch');
      if (!acceptCH) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const requested = parseAcceptCH(acceptCH);
      if (requested.length === 0) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const origin = getOrigin(details.url);
      if (!origin) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const filtered = filterHighEntropyHints(overrides.highEntropyHints, requested);
      if (Object.keys(filtered).length > 0) {
        const lifetimeValue = getHeaderValue(details.responseHeaders, 'accept-ch-lifetime');
        const lifetime = parseAcceptCHLifetime(lifetimeValue);
        const expiresAt = lifetime ? Date.now() + lifetime * 1000 : undefined;
        overrides.highEntropyByOrigin.set(origin, { headers: filtered, expiresAt });
        if (AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) {
          stealthDebug(
            `[Stealth][CH] partition=${partition} origin=${origin} accept-ch=${acceptCH}`
          );
        }
      }

      callback({ responseHeaders: details.responseHeaders });
    });
  }

  private ensureSecurityHooks(session: Session, partition: string): void {
    if (this.securityHookedPartitions.has(partition)) {
      return;
    }
    this.securityHookedPartitions.add(partition);
    const requestHub = getSessionWebRequestHub(session);

    requestHub.subscribeHeadersReceived((details, callback) => {
      const overrides = this.securityOverridesByPartition.get(partition);
      if (!overrides || !overrides.disableCSP || !details.url.startsWith('http')) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const responseHeaders = { ...(details.responseHeaders || {}) } as Record<
        string,
        string | string[]
      >;
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['Content-Security-Policy'];

      callback({ responseHeaders });
    });
  }

  private resolveSecurityPolicy(metadata?: ViewMetadata): {
    webSecurity: boolean;
    allowRunningInsecureContent: boolean;
    disableCSP: boolean;
  } {
    const defaults = {
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableCSP: false,
    };

    const overrides = metadata?.security || {};
    return {
      webSecurity:
        typeof overrides.webSecurity === 'boolean' ? overrides.webSecurity : defaults.webSecurity,
      allowRunningInsecureContent:
        typeof overrides.allowRunningInsecureContent === 'boolean'
          ? overrides.allowRunningInsecureContent
          : defaults.allowRunningInsecureContent,
      disableCSP:
        typeof overrides.disableCSP === 'boolean' ? overrides.disableCSP : defaults.disableCSP,
    };
  }

  private resolveViewPreloadPath(metadata?: ViewMetadata): string | undefined {
    if (metadata?.source !== 'plugin') {
      return undefined;
    }
    return path.join(app.getAppPath(), 'dist', 'preload', 'webcontents-view.js');
  }

  private resolveAllowedPermissions(metadata?: ViewMetadata): Set<string> {
    const values = Array.isArray(metadata?.security?.allowedPermissions)
      ? metadata.security.allowedPermissions
      : [];
    return new Set(
      values
        .map((permission) => String(permission || '').trim())
        .filter((permission) => permission.length > 0)
    );
  }

  private async applyStealthToWebContentsInternal(
    viewId: string,
    webContents: WebContents,
    partition: string,
    metadata?: ViewMetadata
  ): Promise<void> {
    const existingNavigationGuardCleanup = this.navigationGuardCleanupByViewId.get(viewId);
    if (existingNavigationGuardCleanup) {
      existingNavigationGuardCleanup();
    }
    this.navigationGuardCleanupByViewId.set(
      viewId,
      attachNavigationGuards(webContents, {
        onBlocked: ({ eventName, protocol, url }) => {
          console.warn(
            `  ⛔ [NavigationGuard] Blocked ${eventName} for unsupported protocol ${protocol}: ${url}`
          );
        },
      })
    );

    const stealthConfig = this.resolveStealthConfig(partition, metadata);
    if (!stealthConfig?.enabled) {
      return;
    }

    const fingerprintKey =
      typeof stealthConfig.identityKey === 'string' && stealthConfig.identityKey.trim()
        ? stealthConfig.identityKey.trim()
        : partition;
    const fingerprint = fingerprintManager.getFingerprint(fingerprintKey, stealthConfig);
    const acceptLanguage = buildAcceptLanguageHeaderValue(fingerprint.languages);

    stealthDebug(
      `[Stealth][Config] view=${viewId} partition=${partition} ` +
        `profileId=${metadata?.profileId || ''} source=${metadata?.source || ''} ` +
        `config.languages=${JSON.stringify(stealthConfig.languages || null)} ` +
        `config.noise=${JSON.stringify({
          canvas: stealthConfig.canvasNoise,
          canvasLevel: stealthConfig.canvasNoiseLevel,
          audio: stealthConfig.audioNoise,
          audioLevel: stealthConfig.audioNoiseLevel,
          webgl: stealthConfig.webglNoise,
        })} ` +
        `fp.languages=${JSON.stringify(fingerprint.languages)} ` +
        `fp.noise=${JSON.stringify({
          canvas: fingerprint.canvas?.noise,
          canvasLevel: fingerprint.canvas?.noiseLevel,
          audio: fingerprint.audio?.noise,
          audioLevel: fingerprint.audio?.noiseLevel,
          webgl: fingerprint.webglNoise,
        })} ` +
        `acceptLanguage=${acceptLanguage}`
    );
    webContents.session.setUserAgent(fingerprint.userAgent, acceptLanguage);

    const clientHints = buildLowEntropyClientHintsHeaders(fingerprint);
    const highEntropyHints = buildHighEntropyClientHintsHeaders(fingerprint);
    this.stealthNetworkOverridesByPartition.set(partition, {
      acceptLanguage,
      clientHints,
      highEntropyHints,
      highEntropyByOrigin: new Map(),
    });
    this.ensureStealthNetworkHooks(webContents.session, partition);
    console.log(`  🥷 [Stealth] HTTP User-Agent set: ${fingerprint.userAgent.substring(0, 50)}...`);

    // 🎯 CDP-first: 使用 CDP 命令 + JS 脚本注入（确保 JS/网络层一致）
    // 注意：Electron 启动参数 --disable-blink-features=AutomationControlled 已在 index.ts 中设置

    // 构建 StealthOptions：确保 CDP/JS 注入与 network 使用相同的开关与参数
    // 右栏/分栏布局依赖真实 viewport 跟随 setBounds 变化：
    // 对自动化视图禁用 CDP DeviceMetrics 固定尺寸，仅保留 screen/devicePixelRatio 的指纹伪装。
    const dynamicViewportSource =
      metadata?.source === 'pool' || metadata?.source === 'mcp' || metadata?.source === 'account';
    const mobileUserAgent = /\bMobile\b|\bAndroid\b|\biPhone\b|\biPad\b/i.test(
      fingerprint.userAgent
    );
    const disableFixedDeviceMetrics = dynamicViewportSource && !mobileUserAgent;
    const stealthOptions: StealthOptions = {
      canvasNoise:
        typeof stealthConfig.canvasNoise === 'boolean' ? stealthConfig.canvasNoise : undefined,
      canvasNoiseLevel:
        typeof stealthConfig.canvasNoiseLevel === 'number'
          ? stealthConfig.canvasNoiseLevel
          : undefined,
      audioNoise:
        typeof stealthConfig.audioNoise === 'boolean' ? stealthConfig.audioNoise : undefined,
      audioNoiseLevel:
        typeof stealthConfig.audioNoiseLevel === 'number'
          ? stealthConfig.audioNoiseLevel
          : undefined,
      webglNoise:
        typeof stealthConfig.webglNoise === 'boolean' ? stealthConfig.webglNoise : undefined,
      touchEvents: stealthConfig.touchSupport ?? false,
      deviceMetrics: disableFixedDeviceMetrics ? false : undefined,
    };

    const cdpCommands = [
      ...generateCDPCommands(fingerprint, stealthOptions),
      ...generateDebuggerHidingCommands(),
    ];

    const debugStealth = AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders;
    const script = (() => {
      const base = generateFullStealthScript(fingerprint, stealthOptions);
      if (!debugStealth) return base;

      const expected = {
        languages: fingerprint.languages,
        timezone: fingerprint.timezone,
        devicePixelRatio:
          typeof fingerprint.pixelRatio === 'number' && fingerprint.pixelRatio > 0
            ? fingerprint.pixelRatio
            : 1,
        noise: {
          canvas: stealthOptions.canvasNoise ?? fingerprint.canvas?.noise ?? true,
          canvasLevel: stealthOptions.canvasNoiseLevel ?? fingerprint.canvas?.noiseLevel ?? 0.1,
          audio: stealthOptions.audioNoise ?? fingerprint.audio?.noise ?? false,
          audioLevel: stealthOptions.audioNoiseLevel ?? fingerprint.audio?.noiseLevel ?? 0.01,
          webgl: stealthOptions.webglNoise ?? fingerprint.webglNoise ?? false,
        },
      };

      return (
        base +
        `\n;(()=>{try{Object.defineProperty(globalThis,'__airpaStealthExpected',{value:${JSON.stringify(
          expected
        )},configurable:true});}catch(_e){}})();\n`
      );
    })();

    // 先加载 about:blank 确保渲染进程完全初始化
    // 否则 CDP 命令可能永远挂起（渲染进程未就绪无法响应）
    await webContents.loadURL('about:blank');
    console.log(`  📄 [Stealth] Loaded about:blank to initialize renderer for view: ${viewId}`);

    // 立即尝试 CDP 注入（同步执行，不使用 setTimeout）
    let cdpInjected = false;
    try {
      const debuggerApi = webContents.debugger as unknown as {
        attach: (protocolVersion?: string) => void;
        sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
        on: (
          event: 'message',
          listener: (event: unknown, method: string, params: unknown) => void
        ) => void;
        removeListener: (
          event: 'message',
          listener: (event: unknown, method: string, params: unknown) => void
        ) => void;
      };

      // 1. 附加调试器（允许复用已被其他地方占用的 debugger）
      try {
        debuggerApi.attach('1.3');
        console.log(`  🔌 [Stealth] CDP debugger attached for view: ${viewId}`);
      } catch (attachError) {
        const msg = getErrorMessage(attachError);
        if (msg.toLowerCase().includes('already attached')) {
          console.log(`  🔌 [Stealth] CDP debugger already attached, reusing for view: ${viewId}`);
        } else {
          throw attachError;
        }
      }

      // Ensure cross-process iframes inherit stealth scripts and emulation overrides.
      let subTargetMessageId = 0;
      const sendToTarget = async (
        sessionId: string,
        method: string,
        params?: Record<string, unknown>
      ): Promise<void> => {
        const message = JSON.stringify({ id: ++subTargetMessageId, method, params });
        await debuggerApi.sendCommand('Target.sendMessageToTarget', { sessionId, message });
      };

      const applyStealthToTarget = async (
        sessionId: string,
        targetInfo?: { type?: string; targetId?: string; url?: string }
      ): Promise<void> => {
        const targetLabel = `${targetInfo?.type || 'unknown'} ${targetInfo?.targetId || sessionId}`;
        let commandFailures = 0;

        try {
          await sendToTarget(sessionId, 'Page.enable');
        } catch {
          commandFailures++;
        }

        for (const command of cdpCommands) {
          try {
            await sendToTarget(sessionId, command.method, command.params);
          } catch {
            commandFailures++;
          }
        }

        try {
          await sendToTarget(sessionId, 'Page.addScriptToEvaluateOnNewDocument', {
            source: script,
          });
          if (debugStealth) {
            console.log(
              `  ✅ [Stealth] Subtarget injected: ${targetLabel} (failures=${commandFailures})`
            );
          }
        } catch (error) {
          if (debugStealth) {
            console.warn(`  ⚠️ [Stealth] Subtarget injection failed: ${targetLabel}`, error);
          }
        }
      };

      const handleTargetAttached = (_event: unknown, method: string, params: unknown) => {
        if (method !== 'Target.attachedToTarget') return;
        if (!params || typeof params !== 'object') return;

        const payload = params as { sessionId?: unknown; targetInfo?: unknown };
        if (typeof payload.sessionId !== 'string') return;
        if (!payload.targetInfo || typeof payload.targetInfo !== 'object') return;

        const targetInfo = payload.targetInfo as {
          type?: unknown;
          targetId?: unknown;
          url?: unknown;
        };
        const type = targetInfo.type;
        if (type !== 'iframe' && type !== 'page' && type !== 'frame') return;

        void applyStealthToTarget(payload.sessionId, {
          type,
          targetId: typeof targetInfo.targetId === 'string' ? targetInfo.targetId : undefined,
          url: typeof targetInfo.url === 'string' ? targetInfo.url : undefined,
        });
      };

      const existingHandler = this.stealthDebuggerMessageHandlers.get(viewId);
      if (existingHandler) {
        debuggerApi.removeListener('message', existingHandler);
      }
      debuggerApi.on('message', handleTargetAttached);
      this.stealthDebuggerMessageHandlers.set(viewId, handleTargetAttached);

      try {
        await debuggerApi.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (error) {
        if (debugStealth) {
          console.warn(`  ⚠️ [Stealth] Target auto-attach failed:`, error);
        }
      }

      // 2. 启用 Page 和 Emulation 域
      await debuggerApi.sendCommand('Page.enable');
      console.log(`  📄 [Stealth] Page domain enabled for view: ${viewId}`);

      // 3. 🎯 CDP-first: 执行 CDP 伪装命令（时区、UA+Client Hints、地理位置、设备指标）
      let cdpSuccessCount = 0;
      let cdpFailCount = 0;

      for (const command of cdpCommands) {
        try {
          await debuggerApi.sendCommand(command.method, command.params);
          cdpSuccessCount++;
        } catch (err) {
          cdpFailCount++;
          // 某些 CDP 命令可能不支持，静默处理
          console.log(`  ⚠️ [Stealth] CDP command ${command.method} failed: ${err}`);
        }
      }

      console.log(
        `  🎯 [Stealth] CDP commands executed: ${cdpSuccessCount} succeeded, ${cdpFailCount} failed`
      );

      // 4. 注入 JS 脚本到每个新文档（补充 CDP 无法实现的功能）
      await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
      });
      cdpInjected = true;
      console.log(`  ✅ [Stealth] CDP script injection configured for view: ${viewId}`);
    } catch (cdpError) {
      const cdpErrorMessage = getErrorMessage(cdpError);
      const cdpErrorLower = cdpErrorMessage.toLowerCase();
      if (
        cdpErrorLower.includes('already attached') ||
        cdpErrorLower.includes('another debugger') ||
        (cdpErrorLower.includes('debugger') && cdpErrorLower.includes('attach'))
      ) {
        console.log(
          `  [Stealth] CDP attach failed (debugger occupied). Close DevTools/other debugger and retry.`
        );
      }
      // CDP 失败不影响视图创建，回退方案会在导航时生效
      console.log(`  ⚠️ [Stealth] CDP injection failed, using fallback: ${cdpError}`);
    }

    if (!cdpInjected) {
      // 回退方案1：使用 will-navigate 事件（比 did-start-navigation 更早）
      webContents.on('will-navigate', async (_event, url) => {
        if (url === 'about:blank' || url.startsWith('devtools://')) return;

        try {
          await webContents.executeJavaScript(script);
          console.log(`  ✅ [Stealth] Script injected on will-navigate for view: ${viewId}`);
        } catch (_error) {
          // will-navigate 可能太早导致失败，静默处理
        }
      });

      // 回退方案2：使用 did-start-navigation 事件注入（作为保险）
      webContents.on('did-start-navigation', async (_event, url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        if (url === 'about:blank' || url.startsWith('devtools://')) return;

        try {
          await webContents.executeJavaScript(script);
          console.log(`  ✅ [Stealth] Script injected on navigation for view: ${viewId}`);
        } catch (error) {
          console.error(`  ❌ [Stealth] Navigation injection failed for view ${viewId}:`, error);
        }
      });
    }
  }

  constructor(
    private windowManager: WindowManager,
    maxSize: number = DEFAULT_MAX_POOL_SIZE
  ) {
    this.maxSize = maxSize;
    // ✅ 不在构造函数中自动设置 resize 监听器
    // 由外部在窗口创建完成后调用 setupWindowResizeListener()
  }

  /**
   * ✨ 设置插件管理器引用
   */
  setPluginManager(pluginManager: JSPluginManager): void {
    this.pluginManager = pluginManager;
  }

  /**
   * 🆕 设置视图关闭回调（用于 Profile 状态同步）
   */
  setViewClosedCallback(callback: (viewId: string, metadata?: ViewMetadata) => void): void {
    this.viewClosedCallback = callback;
  }

  /**
   * 🆕 同步 Activity Bar 折叠状态（影响所有 WebContentsView 的布局）
   *
   * 说明：WebContentsView 叠加在 renderer 上方，必须避开 Activity Bar 区域，否则会遮挡左侧菜单。
   */
  setActivityBarCollapsed(isCollapsed: boolean): void {
    const width = isCollapsed ? ACTIVITY_BAR_WIDTH : ACTIVITY_BAR_WIDTH_EXPANDED;
    this.setActivityBarWidth(width);
  }

  /**
   * 🆕 同步 Activity Bar 实际宽度（px）
   *
   * 用于解决“前端侧边栏展开/收起时，插件 WebContentsView 未跟随更新导致遮挡”的问题。
   *
   * 注意：
   * - WebContentsView 的布局完全由主进程 bounds 决定，不会自动跟随 renderer 的 flex 布局。
   * - 建议由 renderer 通过 ResizeObserver 上报真实宽度，避免 Tailwind/rem/缩放差异导致的偏移误差。
   */
  setActivityBarWidth(widthPx: number): void {
    const raw = Number(widthPx);
    if (!Number.isFinite(raw)) {
      return;
    }

    const mainWindow = this.windowManager.getMainWindowV3();
    const contentBounds = mainWindow?.getContentBounds();
    const maxWidth = contentBounds ? Math.max(contentBounds.width - MIN_VIEW_SIZE, 1) : undefined;

    const normalized = Math.max(1, Math.round(raw));
    const clamped = maxWidth !== undefined ? Math.min(normalized, maxWidth) : normalized;

    if (clamped === this.activityBarWidth) {
      return;
    }

    this.activityBarWidth = clamped;

    // ActivityBar 宽度变化不会触发窗口 resize，需要主动触发布局刷新
    this.handleWindowResize(contentBounds);
  }

  /**
   * 🆕 获取当前 Activity Bar 宽度（px）
   */
  getActivityBarWidth(): number {
    return this.activityBarWidth;
  }

  /**
   * 获取 View 当前的“期望 bounds”（即最近一次 setBounds 的目标值）
   *
   * 说明：WebContentsView 的实际 bounds 可能会被系统布局覆盖，这里返回我们维护的 desired bounds。
   */
  getViewBounds(viewId: string): ViewBounds | undefined {
    return this.pool.get(viewId)?.bounds;
  }

  /**
   * 注册 View 配置（不立即创建实际的 View）
   */
  registerView(registration: ViewRegistration): void {
    const existing = this.registry.get(registration.id);
    if (existing) {
      // 🆕 如果是临时视图，允许覆盖更新
      if (existing.metadata?.temporary || registration.metadata?.temporary) {
        console.log(`📝 Updating temporary view registration: ${registration.id}`);
        this.registry.set(registration.id, registration);
      } else {
        console.warn(`⚠️  View already registered: ${registration.id}, skipping update`);
      }
    } else {
      this.registry.set(registration.id, registration);
      console.log(`✅ View registered: ${registration.id} (registry: ${this.registry.size})`);
    }
  }

  /**
   * 激活 View（确保在池中，按需创建）
   */
  async activateView(viewId: string): Promise<WebContentsViewInfo> {
    const perfStart = Date.now();

    // 如果已在池中，更新访问时间并返回
    const cachedView = this.pool.get(viewId);
    if (cachedView) {
      cachedView.lastAccessedAt = Date.now();
      console.log(
        `♻️  [Performance] View reused from pool: ${viewId} (instant, no creation needed)`
      );

      this.ensurePluginPageViewLoaded(viewId, cachedView).catch((error) => {
        console.error(`❌ Failed to ensure plugin page view loaded: ${viewId}`, error);
      });

      return cachedView;
    }

    // 否则根据注册信息创建
    const registration = this.registry.get(viewId);
    if (!registration) {
      throw new Error(`View not registered: ${viewId}`);
    }

    const pendingActivation = this.viewActivationTasks.get(viewId);
    if (pendingActivation) {
      console.log(`⏳ [Performance] View activation already in progress: ${viewId}`);
      const viewInfo = await pendingActivation;
      viewInfo.lastAccessedAt = Date.now();
      return viewInfo;
    }

    console.log(`🆕 [Performance] Activating new view: ${viewId}...`);
    const activationTask = this.createViewFromRegistration(registration);
    this.viewActivationTasks.set(viewId, activationTask);

    try {
      const result = await activationTask;
      const duration = Date.now() - perfStart;
      console.log(`⏱️  [Performance] View activation completed: ${viewId} in ${duration}ms`);
      this.ensurePluginPageViewLoaded(viewId, result).catch((error) => {
        console.error(`❌ Failed to ensure plugin page view loaded: ${viewId}`, error);
      });
      return result;
    } finally {
      if (this.viewActivationTasks.get(viewId) === activationTask) {
        this.viewActivationTasks.delete(viewId);
      }
    }
  }

  private parsePluginPageViewId(
    viewId: string
  ): { pluginId: string; activityBarViewId: string } | null {
    if (!viewId.startsWith('plugin-page:')) return null;
    if (viewId === SHARED_PLUGIN_PAGE_VIEW_ID) return null;
    const rest = viewId.slice('plugin-page:'.length);
    const firstSep = rest.indexOf(':');
    if (firstSep <= 0) return null;
    const pluginId = rest.slice(0, firstSep);
    const activityBarViewId = rest.slice(firstSep + 1);
    if (!pluginId || !activityBarViewId) return null;
    return { pluginId, activityBarViewId };
  }

  private async ensurePluginPageViewLoaded(
    viewId: string,
    viewInfo: WebContentsViewInfo
  ): Promise<void> {
    const parsed = this.parsePluginPageViewId(viewId);
    if (!parsed) return;

    await this.loadPluginPageIntoView({
      viewId,
      pluginId: parsed.pluginId,
      expectedActivityBarViewId: parsed.activityBarViewId,
      forceReload: false,
      viewInfo,
    });
  }

  async loadPluginPageView(viewId: string, pluginId: string): Promise<void> {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      throw new Error('pluginId is required');
    }

    if (viewId === SHARED_PLUGIN_PAGE_VIEW_ID) {
      const task = this.sharedPluginPageViewLoadQueue.then(() =>
        this.loadPluginPageIntoView({
          viewId,
          pluginId: normalizedPluginId,
          forceReload: true,
        })
      );
      this.sharedPluginPageViewLoadQueue = task.catch(() => undefined);
      await task;
      return;
    }

    await this.loadPluginPageIntoView({
      viewId,
      pluginId: normalizedPluginId,
      forceReload: true,
    });
  }

  private buildPluginPageInjectionScript(pluginId: string, apiList: string[]): string {
    return `
      (function() {
        console.log('🚀 [Plugin Page] Injecting plugin API for: ${pluginId}');
        console.log('📋 [Plugin Page] API list:', ${JSON.stringify(apiList)});

        // 确保 pluginAPI 对象存在
        if (!window.pluginAPI) {
          console.warn('⚠️ window.pluginAPI not found, creating it');
          window.pluginAPI = { datasetId: null };
        }

        // 为插件创建命名空间
        window.pluginAPI['${pluginId}'] = {};

        // 动态创建 API 方法包装器
        const apiList = ${JSON.stringify(apiList)};
        for (const apiName of apiList) {
          window.pluginAPI['${pluginId}'][apiName] = async function(...args) {
            // 通过 electronAPI 调用插件 API
            // ✅ 展开 args 数组，因为 callPluginAPI 期望可变参数
            const response = await window.electronAPI.jsPlugin.callPluginAPI('${pluginId}', apiName, ...args);
            // ✅ 解包 IPC 响应：{ success: true, result: {...} } -> {...}
            if (response.success) {
              return response.result;
            } else {
              throw new Error(response.error || 'API call failed');
            }
          };
        }

        console.log('✅ [Plugin Page] Plugin API injected successfully');
        console.log('📦 [Plugin Page] API namespace:', Object.keys(window.pluginAPI['${pluginId}']));

        // 触发自定义事件，通知页面 API 已就绪
        window.dispatchEvent(new CustomEvent('pluginAPIReady', {
          detail: { pluginId: '${pluginId}', apiList }
        }));
      })();
    `;
  }

  private async loadPluginPageIntoView(options: {
    viewId: string;
    pluginId: string;
    expectedActivityBarViewId?: string;
    forceReload: boolean;
    viewInfo?: WebContentsViewInfo;
  }): Promise<void> {
    const { viewId, pluginId, expectedActivityBarViewId, forceReload } = options;
    const viewInfo = options.viewInfo ?? this.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found in pool: ${viewId}`);
    }

    const currentUrl = viewInfo.view.webContents.getURL();
    const currentPlugin = this.pluginPageViewCurrentPluginByView.get(viewId);
    if (!forceReload && currentPlugin === pluginId && currentUrl && currentUrl !== 'about:blank') {
      return;
    }

    const loadKey = `${viewId}:${pluginId}:${forceReload ? 'force' : 'normal'}`;
    const existing = this.pluginPageViewLoads.get(loadKey);
    if (existing) {
      await existing;
      return;
    }

    const task = (async () => {
      const plugin = this.pluginManager?.getLoadedPlugin(pluginId);
      const viewConfig =
        this.pluginPageViewContributions.get(pluginId) ??
        plugin?.manifest?.contributes?.activityBarView;
      if (!viewConfig) {
        throw new Error(`Plugin ${pluginId} does not have an activityBarView contribution`);
      }
      if (expectedActivityBarViewId && viewConfig.id !== expectedActivityBarViewId) {
        console.warn(
          `⚠️  Plugin page view id mismatch for ${pluginId}: expected=${viewConfig.id}, got=${expectedActivityBarViewId}`
        );
      }

      if (!viewInfo.metadata) {
        viewInfo.metadata = {};
      }
      viewInfo.metadata.pluginId = pluginId;
      viewInfo.metadata.label = viewConfig.title;
      viewInfo.metadata.icon = viewConfig.icon;
      viewInfo.metadata.order = viewConfig.order;
      this.activePluginId = pluginId;

      const registration = this.registry.get(viewId);
      if (registration?.metadata) {
        registration.metadata.pluginId = pluginId;
        registration.metadata.label = viewConfig.title;
        registration.metadata.icon = viewConfig.icon;
        registration.metadata.order = viewConfig.order;
      }

      console.log(`🌐 Loading plugin page view: ${viewId} (plugin=${pluginId})`);

      let apiList: string[] = [];
      try {
        apiList = this.pluginManager?.getExposedAPIs(pluginId) || [];
      } catch (error) {
        console.warn(`⚠️ Failed to read exposed APIs for plugin ${pluginId}:`, error);
      }

      const injectionScript = this.buildPluginPageInjectionScript(pluginId, apiList);

      const onFinishLoad = async () => {
        try {
          console.log(`📡 Injecting plugin API for ${pluginId}:`, apiList);
          await viewInfo.view.webContents.executeJavaScript(injectionScript);
          console.log(`✅ Plugin API injected for ${pluginId}`);
        } catch (error) {
          console.error(`❌ Failed to inject plugin API for ${pluginId}:`, error);
        }
      };

      viewInfo.view.webContents.once('did-finish-load', onFinishLoad);

      try {
        if (viewConfig.source.type === 'local') {
          const pluginPath = plugin?.path || this.getPluginPath(pluginId);
          const filePath = path.resolve(pluginPath, viewConfig.source.path);
          if (!fs.existsSync(filePath)) {
            throw new Error(`Plugin page not found: ${filePath}`);
          }
          await viewInfo.view.webContents.loadFile(filePath);
        } else {
          await loadWebContentsURL(viewInfo.view.webContents, viewConfig.source.path, {
            waitUntil: 'domcontentloaded',
            onRecoverableAbort: (targetUrl) => {
              console.log(
                `ℹ [loadPluginPageView] Ignoring recoverable ERR_ABORTED for ${targetUrl}`
              );
            },
          });
        }
      } catch (error) {
        viewInfo.view.webContents.removeListener('did-finish-load', onFinishLoad);
        throw error;
      }

      this.pluginPageViewCurrentPluginByView.set(viewId, pluginId);
      console.log(`✅ Plugin page view loaded: ${viewId} (plugin=${pluginId})`);
    })();

    this.pluginPageViewLoads.set(loadKey, task);
    try {
      await task;
    } finally {
      this.pluginPageViewLoads.delete(loadKey);
    }
  }

  /**
   * 🆕 对现有 WebContents 应用 Stealth 伪装
   */
  async applyStealthToWebContents(
    viewId: string,
    webContents: WebContents,
    partition: string,
    metadata?: ViewMetadata
  ): Promise<void> {
    await this.applyStealthToWebContentsInternal(viewId, webContents, partition, metadata);
  }

  /**
   * 🆕 清理 WebContents 的 Stealth debugger 监听
   */
  detachStealthFromWebContents(viewId: string, webContents: WebContents): void {
    const navigationGuardCleanup = this.navigationGuardCleanupByViewId.get(viewId);
    if (navigationGuardCleanup) {
      navigationGuardCleanup();
      this.navigationGuardCleanupByViewId.delete(viewId);
    }

    const handler = this.stealthDebuggerMessageHandlers.get(viewId);
    if (handler) {
      if (!webContents.isDestroyed()) {
        webContents.debugger.removeListener('message', handler);
      }
      this.stealthDebuggerMessageHandlers.delete(viewId);
    }

    if (!webContents.isDestroyed() && webContents.debugger?.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.warn(`  ⚠️ Failed to detach debugger (non-critical):`, message, error);
      }
    }
  }

  /**
   * 创建 WebContentsView（内部方法）
   */
  private async createViewFromRegistration(
    registration: ViewRegistration
  ): Promise<WebContentsViewInfo> {
    const viewId = registration.id;

    // 1. 检查是否已在池中
    const cachedView = this.pool.get(viewId);
    if (cachedView) {
      return cachedView;
    }

    // 2. 检查池是否已满，拒绝新激活请求
    if (this.pool.size >= this.maxSize) {
      const activeViews = Array.from(this.pool.keys()).join(', ');
      throw new Error(
        `WebContentsView pool is full (${this.maxSize}/${this.maxSize}). Cannot activate "${viewId}".\n` +
          `Active views: [${activeViews}]\n` +
          `Please close an existing view first:\n` +
          `  - Call: await viewManager.closeView('viewId')\n` +
          `  - Or call: await viewManager.deleteView('viewId')\n` +
          `  - Or use UI to close unused views`
      );
    }

    // 3. 创建 WebContentsView
    const viewCreateStart = Date.now();

    // 自动化目标页不注入主应用 preload，避免远程页面获得完整 electronAPI。
    // 插件页使用窄桥接 preload，只暴露插件 API 调用能力。
    const preloadPath = this.resolveViewPreloadPath(registration.metadata);
    const securityPolicy = this.resolveSecurityPolicy(registration.metadata);
    console.log(`📦 View preload script path: ${preloadPath || '(none)'}`);

    const view = new WebContentsView({
      webPreferences: {
        partition: registration.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: securityPolicy.webSecurity,
        allowRunningInsecureContent: securityPolicy.allowRunningInsecureContent,
        ...(preloadPath ? { preload: preloadPath } : {}),
      },
    });
    console.log(`  ⏱️  WebContentsView object created in ${Date.now() - viewCreateStart}ms`);

    // 🛡️ 监控 bounds-changed：某些平台/窗口动画/布局阶段可能会在我们 setBounds 之后再次覆盖 view 的 bounds。
    // 当检测到与期望的 bounds 不一致时，补偿性地再 setBounds 一次，确保视觉上能跟随 resize/maximize/unmaximize。
    // 这里不依赖 updateBounds 的“即时校验”，因为覆盖可能发生在后续的 layout pass。
    view.on('bounds-changed', () => {
      const info = this.pool.get(viewId);
      if (!info?.attachedTo || !info.bounds) return;

      try {
        const actual = view.getBounds();
        const desired = info.bounds;
        if (boundsAlmostEqual(actual, desired)) return;

        if (isDevelopmentMode()) {
          console.warn(`⚠️ [bounds-changed] View bounds overwritten, reapplying: ${viewId}`, {
            desired,
            actual,
            attachedTo: info.attachedTo,
          });
        }

        setImmediate(() => {
          const latest = this.pool.get(viewId);
          if (!latest?.attachedTo || !latest.bounds) return;
          if (latest.view.webContents.isDestroyed()) return;
          try {
            latest.view.setBounds(latest.bounds);
          } catch {
            // ignore
          }
        });
      } catch (error) {
        if (isDevelopmentMode()) {
          console.warn(`⚠️ [bounds-changed] Failed to verify/reapply bounds for ${viewId}:`, error);
        }
      }
    });

    // ✅ 自动化视图：关闭后台节流，避免离屏/隐藏模式下 setTimeout/Promise 等被强制降速导致“卡住”
    try {
      const source = registration.metadata?.source;
      const shouldDisableThrottling = source === 'pool' || source === 'mcp' || source === 'account';
      if (shouldDisableThrottling && hasBackgroundThrottling(view.webContents)) {
        view.webContents.setBackgroundThrottling(false);
        console.log(
          `✅ [Performance] Disabled background throttling for view: ${viewId} (source=${source})`
        );
      }
    } catch (error) {
      console.warn(
        `⚠️ [Performance] Failed to set background throttling for view ${viewId}: ${getErrorMessage(error)}`
      );
    }

    // 🆕 Stealth Mode: 设置 HTTP User-Agent（必须在导航前设置）
    await this.applyStealthToWebContentsInternal(
      viewId,
      view.webContents,
      registration.partition,
      registration.metadata
    );

    // 🔍 调试：监听 console 消息来确认 preload 脚本加载
    view.webContents.on('console-message', (_event, _level, message) => {
      if (message.includes('Preload script loaded')) {
        console.log(`  ✅ Preload script loaded successfully for view: ${viewId}`);
      }
    });

    view.webContents.on('did-finish-load', () => {
      if (preloadPath) {
        view.webContents
          .executeJavaScript('typeof window.electronAPI')
          .then((result) => {
            console.log(`  🔍 window.electronAPI type: ${result} (view: ${viewId})`);
            if (result === 'undefined') {
              console.error(`  ❌ window.electronAPI is undefined! Preload may have failed.`);
            }
          })
          .catch((err) => {
            console.error(`  ❌ Failed to check window.electronAPI:`, err);
          });
      }

      if (AIRPA_RUNTIME_CONFIG.webview.debugStealthHeaders) {
        view.webContents
          .executeJavaScript(
            `(()=>({` +
              `language:navigator.language,` +
              `languages:navigator.languages,` +
              `userAgent:navigator.userAgent,` +
              `uaDataBrands:(navigator.userAgentData&&navigator.userAgentData.brands)||null,` +
              `airpaStealthExpected:(globalThis).__airpaStealthExpected||null,` +
              `devicePixelRatio:window.devicePixelRatio,` +
              `screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth},` +
              `webgl:(()=>{try{const c=document.createElement('canvas');const gl=c.getContext('webgl');if(!gl)return null;const ext=gl.getExtension('WEBGL_debug_renderer_info');const uVendor=ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null;const uRenderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;return {vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:uVendor,unmaskedRenderer:uRenderer,version:gl.getParameter(gl.VERSION),shading:gl.getParameter(gl.SHADING_LANGUAGE_VERSION)};}catch(_e){return {error:true};}})(),` +
              `languagesDescOwn:(()=>{const d=Object.getOwnPropertyDescriptor(navigator,'languages');return d?{configurable:!!d.configurable,enumerable:!!d.enumerable,hasGet:!!d.get,hasValue:('value'in d)}:null})(),` +
              `languagesDescProto:(()=>{const p=Object.getPrototypeOf(navigator);const d=p&&Object.getOwnPropertyDescriptor(p,'languages');return d?{configurable:!!d.configurable,enumerable:!!d.enumerable,hasGet:!!d.get,hasValue:('value'in d)}:null})()` +
              `}))()`
          )
          .then((info) => {
            stealthDebug(`[Stealth][JS] view=${viewId} ${JSON.stringify(info)}`);
          })
          .catch(() => {});
      }
    });

    const existingSecurity = this.securityOverridesByPartition.get(registration.partition);
    if (existingSecurity) {
      existingSecurity.disableCSP = existingSecurity.disableCSP || securityPolicy.disableCSP;
    } else {
      this.securityOverridesByPartition.set(registration.partition, {
        disableCSP: securityPolicy.disableCSP,
      });
    }
    this.ensureSecurityHooks(view.webContents.session, registration.partition);

    // 3.5.1 禁用地理位置权限请求（避免 googleapis.com 403 错误）
    const allowedPermissions = this.resolveAllowedPermissions(registration.metadata);
    const isPermissionAllowed = (permission: string) => allowedPermissions.has(permission);
    const logBlockedPermission = (permission: string) => {
      console.log(`🚫 Blocked permission request for view: ${viewId} (${permission})`);
    };

    view.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = isPermissionAllowed(permission);
      if (!allowed) {
        logBlockedPermission(permission);
      }
      callback(allowed);
    });
    view.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
      const allowed = isPermissionAllowed(permission);
      if (!allowed) {
        logBlockedPermission(permission);
      }
      return allowed;
    });

    // 3.6 根据全局/视图级配置自动打开 DevTools（便于调试脚本执行）
    if (
      maybeOpenInternalBrowserDevTools(view.webContents, {
        override: registration.metadata?.openDevTools,
        mode: 'detach',
      })
    ) {
      console.log(`🛠️  DevTools opened for view: ${viewId}`);
    }

    // 4. 跳过初始 URL 加载（性能优化）
    // 原因：避免重复加载。实际导航由 workflow 的 goto 操作完成
    // 如果需要预加载，应由 workflow 显式控制
    // if (registration.url) {
    //   await view.webContents.loadURL(registration.url);
    // }
    console.log(
      `🚀 WebContentsView created without initial URL load (will be loaded by workflow): ${viewId}`
    );

    // 5. 记录信息
    const viewInfo: WebContentsViewInfo = {
      id: viewId,
      view,
      partition: registration.partition,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      metadata: registration.metadata,
    };

    this.pool.set(viewId, viewInfo);

    // 🆕 更新统计
    this.stats.created++;

    console.log(
      `✅ WebContentsView created: ${viewId} (${this.pool.size}/${this.maxSize}, total created: ${this.stats.created})`
    );

    // 🆕 通知前端标签栏更新
    this.notifyViewCreated(viewId, registration);

    return viewInfo;
  }

  /**
   * 根据 pluginId 查找第一个可用的视图
   * @param pluginId 插件ID
   * @returns 视图ID，如果找不到则返回 null
   */
  findViewByPlugin(pluginId: string): string | null {
    // 1. 先在池中查找（优先使用已创建的视图）
    for (const [viewId, viewInfo] of this.pool.entries()) {
      if (viewInfo.metadata?.pluginId === pluginId) {
        return viewId;
      }
    }

    // 2. 在注册表中查找（返回第一个匹配的注册ID）
    for (const [viewId, registration] of this.registry.entries()) {
      if (registration.metadata?.pluginId === pluginId) {
        return viewId;
      }
    }

    return null;
  }

  /**
   * 附加 View 到窗口
   * @param viewId View ID
   * @param windowId 窗口 ID (e.g., "main", "popup-xxx")
   * @param bounds 视图边界
   */
  attachView(viewId: string, windowId: string, bounds: ViewBounds): void {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found: ${viewId}`);
    }

    const window = this.windowManager.getWindowById(windowId);
    if (!window) {
      throw new Error(`Window not found: ${windowId}`);
    }

    console.log(`📐 Attaching view with bounds:`, bounds);
    // 添加到窗口
    window.contentView.addChildView(viewInfo.view);

    // 先更新状态（避免 setBounds 同步触发 bounds-changed 时读到旧的 desired bounds）
    viewInfo.attachedTo = windowId;
    viewInfo.bounds = bounds;
    viewInfo.lastAccessedAt = Date.now();

    // 设置边界和可见性
    viewInfo.view.setBounds(bounds);
    viewInfo.view.setVisible(true);

    console.log(`✅ View attached: ${viewId} -> ${windowId}`);

    this.scheduleViewportDebug(viewId, 'attach');
  }

  /**
   * 分离 View
   */
  detachView(viewId: string): void {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo || !viewInfo.attachedTo) {
      return;
    }

    const wasMainWindow = viewInfo.attachedTo === 'main';
    const wasRightDocked = this.rightDockedPoolView?.viewId === viewId;

    // 先将视图移到离屏位置，确保不可见（双重保险）
    viewInfo.view.setBounds(OFFSCREEN_BOUNDS);

    const window = this.windowManager.getWindowById(viewInfo.attachedTo);
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(viewInfo.view);
    }

    viewInfo.attachedTo = undefined;
    viewInfo.bounds = undefined;

    if (wasRightDocked) {
      this.rightDockedPoolView = null;
      if (wasMainWindow) {
        this.handleWindowResize();
      }
    }
  }

  /**
   * 🆕 将视图附加到窗口的离屏位置
   *
   * 用于弹窗关闭后将视图移回主窗口但保持不可见的场景。
   * 与 attachView 的区别：
   * - attachView: 视图可见，bounds 由调用者指定
   * - attachViewOffscreen: 视图不可见，使用固定的离屏 bounds
   *
   * @param viewId 视图 ID
   * @param windowId 窗口 ID (默认 "main")
   */
  attachViewOffscreen(viewId: string, windowId: string = 'main'): boolean {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[attachViewOffscreen] View not found: ${viewId}`);
      return false;
    }

    const window = this.windowManager.getWindowById(windowId);
    if (!window || window.isDestroyed()) {
      console.warn(`[attachViewOffscreen] Window not found or destroyed: ${windowId}`);
      return false;
    }

    const offscreenBounds = { x: 10000, y: 0, width: 1920, height: 1080 };

    // 添加到窗口（如果还没有添加）
    // 注意：如果视图已经在该窗口中，addChildView 会自动忽略
    window.contentView.addChildView(viewInfo.view);

    // 设置离屏边界
    viewInfo.view.setBounds(offscreenBounds);
    viewInfo.view.setVisible(true); // 虽然在离屏位置，但保持 visible=true 以便渲染

    // 更新状态
    viewInfo.attachedTo = windowId;
    viewInfo.bounds = offscreenBounds;
    viewInfo.lastAccessedAt = Date.now();

    console.log(`✅ [attachViewOffscreen] View attached offscreen: ${viewId} -> ${windowId}`);
    return true;
  }

  /**
   * 分离所有 View
   * @param windowId 可选，指定窗口 ID 只分离该窗口的 View
   */
  detachAllViews(windowId?: string, options?: { preserveDockedRight?: boolean }): void {
    const preserveDockedRight = options?.preserveDockedRight === true;
    const dockedRightViewId = preserveDockedRight ? this.rightDockedPoolView?.viewId : undefined;

    let count = 0;
    for (const [id, info] of this.pool.entries()) {
      // 如果指定了 windowId，只分离该窗口的 View
      if (windowId === undefined || info.attachedTo === windowId) {
        if (dockedRightViewId && id === dockedRightViewId) {
          continue;
        }
        this.detachView(id);
        count++;
      }
    }
    console.log(`✅ Detached ${count} view(s)${windowId ? ` from ${windowId}` : ''}`);
  }

  /**
   * 按作用域分离 View
   *
   * 主要用于前端页面切换时的“精准清理”：
   * - automation: 清理自动化临时视图，不影响插件页面/插件分栏视图
   * - plugin: 清理插件视图
   * - all: 等同于 detachAllViews
   */
  detachScopedViews(options?: DetachScopedViewsOptions): void {
    const windowId = options?.windowId;
    const scope = options?.scope ?? 'automation';
    const preserveDockedRight = options?.preserveDockedRight === true;
    const dockedRightViewId = preserveDockedRight ? this.rightDockedPoolView?.viewId : undefined;

    if (scope === 'all') {
      this.detachAllViews(windowId, { preserveDockedRight });
      return;
    }

    let count = 0;
    for (const [id, info] of this.pool.entries()) {
      if (windowId !== undefined && info.attachedTo !== windowId) {
        continue;
      }
      if (dockedRightViewId && id === dockedRightViewId) {
        continue;
      }

      const isPluginOwned = this.isPluginOwnedView(id, info);
      if (scope === 'automation' && isPluginOwned) {
        continue;
      }
      if (scope === 'plugin' && !isPluginOwned) {
        continue;
      }

      this.detachView(id);
      count++;
    }

    console.log(`✅ Detached ${count} ${scope} view(s)${windowId ? ` from ${windowId}` : ''}`);
  }

  private isPluginOwnedView(viewId: string, viewInfo: WebContentsViewInfo): boolean {
    if (viewId.startsWith('plugin-page:') || viewId.startsWith('plugin-temp:')) {
      return true;
    }

    const source = viewInfo.metadata?.source;
    if (source === 'plugin') {
      return true;
    }

    return Boolean(viewInfo.metadata?.pluginId);
  }

  /**
   * 切换 View（分离旧的，附加新的）
   * @param viewId View ID
   * @param windowId 窗口 ID
   * @param bounds 视图边界
   */
  switchView(viewId: string, windowId: string, bounds: ViewBounds): void {
    // 找到当前附加到该窗口的所有 View 并分离
    for (const [id, info] of this.pool.entries()) {
      if (info.attachedTo === windowId) {
        this.detachView(id);
      }
    }

    // 附加新 View
    this.attachView(viewId, windowId, bounds);
  }

  /**
   * 更新 View 边界
   */
  updateBounds(viewId: string, bounds: ViewBounds): void {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found: ${viewId}`);
    }

    // 先记录“期望 bounds”，避免 setBounds 同步触发 bounds-changed 时读到旧值
    viewInfo.bounds = bounds;

    viewInfo.view.setBounds(bounds);

    // 某些平台/窗口动画场景下，setBounds 可能在同一帧被系统布局覆盖。
    // 开发模式下做一次轻量校验并补偿重试，便于定位“日志变了但界面不变”的问题。
    if (isDevelopmentMode()) {
      try {
        const actual = viewInfo.view.getBounds();
        if (!boundsAlmostEqual(actual, bounds)) {
          console.warn(`⚠️ [updateBounds] setBounds mismatch for ${viewId}:`, {
            requested: bounds,
            actual,
          });

          setImmediate(() => {
            const latest = this.pool.get(viewId);
            if (!latest || latest.view.webContents.isDestroyed()) return;
            latest.view.setBounds(bounds);
          });
        }
      } catch (error) {
        console.warn(`⚠️ [updateBounds] Failed to verify bounds for ${viewId}:`, error);
      }
    }

    viewInfo.lastAccessedAt = Date.now();
  }

  private scheduleViewportDebug(viewId: string, reason: string): void {
    if (!isDevelopmentMode()) return;

    const viewInfo = this.pool.get(viewId);
    if (!viewInfo?.attachedTo || !viewInfo.bounds) return;

    const viewType = this.getViewType(viewId);
    if (viewType !== 'page' && viewType !== 'temp') return;

    const prev = this.viewportDebugTimers.get(viewId);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
      this.viewportDebugTimers.delete(viewId);
      void this.logViewportDebug(viewId, reason);
    }, 150);

    this.viewportDebugTimers.set(viewId, timer);
  }

  private async logViewportDebug(viewId: string, reason: string): Promise<void> {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo?.attachedTo || !viewInfo.bounds) return;

    const view = viewInfo.view;
    if (view.webContents.isDestroyed()) return;

    const window = this.windowManager.getWindowById(viewInfo.attachedTo);
    const windowState =
      window && !window.isDestroyed()
        ? {
            contentBounds: window.getContentBounds(),
            isMaximized: window.isMaximized(),
            isFullScreen: window.isFullScreen(),
          }
        : undefined;

    let actualBounds: Rectangle | undefined;
    try {
      actualBounds = view.getBounds();
    } catch {
      actualBounds = undefined;
    }

    let viewport:
      | {
          innerWidth: number;
          innerHeight: number;
          clientWidth: number | null;
          clientHeight: number | null;
          dpr: number;
        }
      | { error: string }
      | undefined;

    try {
      viewport = (await view.webContents.executeJavaScript(
        `(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement?.clientWidth ?? null, clientHeight: document.documentElement?.clientHeight ?? null, dpr: window.devicePixelRatio }))()`,
        true
      )) as typeof viewport;
    } catch (error) {
      viewport = { error: getErrorMessage(error) };
    }

    const desired = viewInfo.bounds;
    const key = [
      desired.x,
      desired.y,
      desired.width,
      desired.height,
      actualBounds?.x ?? 'x',
      actualBounds?.y ?? 'y',
      actualBounds?.width ?? 'w',
      actualBounds?.height ?? 'h',
      viewport && 'innerWidth' in viewport ? viewport.innerWidth : 'iw',
      viewport && 'innerHeight' in viewport ? viewport.innerHeight : 'ih',
      windowState?.contentBounds.width ?? 'cw',
      windowState?.contentBounds.height ?? 'ch',
      windowState?.isMaximized ? 1 : 0,
      windowState?.isFullScreen ? 1 : 0,
      this.activityBarWidth,
    ].join(',');

    if (this.lastViewportDebugKey.get(viewId) === key) return;
    this.lastViewportDebugKey.set(viewId, key);

    console.log(`🧪 [viewport] ${viewId} (${reason})`, {
      pluginId: viewInfo.metadata?.pluginId,
      viewType: this.getViewType(viewId),
      activityBarWidth: this.activityBarWidth,
      desiredBounds: viewInfo.bounds,
      actualBounds,
      viewport,
      window: windowState,
    });
  }

  /**
   * 导航到指定 URL
   */
  async navigateView(viewId: string, url: string): Promise<void> {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      throw new Error(`View not found in pool: ${viewId}`);
    }

    await loadWebContentsURL(viewInfo.view.webContents, url, {
      waitUntil: 'domcontentloaded',
      onRecoverableAbort: (targetUrl) => {
        console.log(`ℹ [navigateView] Ignoring recoverable ERR_ABORTED for ${targetUrl}`);
      },
    });
    viewInfo.lastAccessedAt = Date.now();

    console.log(`✅ View navigated: ${viewId} -> ${url}`);
  }

  /**
   * 关闭 View（从池中移除，但保留注册信息）
   * 🔧 改进版本：完整的资源清理流程，避免内存泄漏
   */
  async closeView(viewId: string): Promise<void> {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`closeView: View not found in pool: ${viewId}`);
      return;
    }

    const removedDockPlugins = this.removePluginDockLayoutsByView(viewId);
    const currentPluginForView = this.pluginPageViewCurrentPluginByView.get(viewId);
    const wasRightDocked = this.rightDockedPoolView?.viewId === viewId;
    if (wasRightDocked) {
      this.rightDockedPoolView = null;
    }

    if (removedDockPlugins.length > 0) {
      console.log(
        `[closeView] Removed dock layout mapping for plugin(s): ${removedDockPlugins.join(', ')}`
      );
    }

    // 🆕 保存 metadata 用于回调（因为后面会被清空）
    const metadata = viewInfo.metadata ? { ...viewInfo.metadata } : undefined;

    console.log(`🧹 Starting cleanup for view: ${viewId}`);

    try {
      // ============================================
      // 第 1 步: 分离 View（如果已附加）
      // ============================================
      if (viewInfo.attachedTo) {
        this.detachView(viewId);
        console.log(`  ✓ View detached from window`);
      }

      // ============================================
      // 第 2 步: 关闭 debugger（如果已附加）
      // ============================================
      await this.safelyDetachDebugger(viewInfo);

      // ============================================
      // 第 3 步: 停止所有导航和加载
      // ============================================
      if (!viewInfo.view.webContents.isDestroyed()) {
        try {
          viewInfo.view.webContents.stop();
          console.log(`  ✓ Navigation stopped`);
        } catch (error) {
          console.warn(`  ⚠ Failed to stop navigation:`, error);
        }
      }

      // ============================================
      // 第 4 步: 销毁 WebContents（使用 setImmediate 延迟执行，避免崩溃）
      // ============================================
      await this.safelyDestroyWebContents(viewInfo);

      // ============================================
      // 第 5 步: 从池中移除并清理状态
      // ============================================
      this.pool.delete(viewId);
      this.viewStates.delete(viewId);
      this.pluginPageViewCurrentPluginByView.delete(viewId);
      if (currentPluginForView && this.activePluginId === currentPluginForView) {
        this.activePluginId = null;
      }
      const debugTimer = this.viewportDebugTimers.get(viewId);
      if (debugTimer) clearTimeout(debugTimer);
      this.viewportDebugTimers.delete(viewId);
      this.lastViewportDebugKey.delete(viewId);

      // ============================================
      // 第 6 步: 显式清空引用（帮助 GC）
      // ============================================
      // 注意：Electron 的 WebContentsView 没有 destroy() 方法
      // 我们只能清空引用，依赖 GC 回收
      const cleanupTarget = viewInfo as unknown as MutableWebContentsViewInfo;
      cleanupTarget.view = null;
      cleanupTarget.partition = null;
      cleanupTarget.metadata = null;

      this.stats.destroyed++;
      console.log(
        `✅ View cleaned up: ${viewId} (destroyed: ${this.stats.destroyed}, pool: ${this.pool.size}/${this.maxSize})`
      );

      // 🆕 通知前端标签栏更新
      this.notifyViewClosed(viewId);

      // 🆕 触发视图关闭回调（用于 Profile 状态同步）
      if (this.viewClosedCallback && metadata) {
        try {
          this.viewClosedCallback(viewId, metadata);
        } catch (callbackError) {
          console.error(`  ⚠ viewClosedCallback error:`, callbackError);
        }
      }

      if (wasRightDocked) {
        this.handleWindowResize();
      }
    } catch (error) {
      this.stats.failed++;
      console.error(`❌ Failed to cleanup view ${viewId}:`, error);
      throw error;
    }
  }

  /**
   * 🆕 安全地分离 debugger
   */
  private async safelyDetachDebugger(viewInfo: WebContentsViewInfo): Promise<void> {
    try {
      const { webContents } = viewInfo.view;

      const navigationGuardCleanup = this.navigationGuardCleanupByViewId.get(viewInfo.id);
      if (navigationGuardCleanup) {
        navigationGuardCleanup();
        this.navigationGuardCleanupByViewId.delete(viewInfo.id);
      }

      const handler = this.stealthDebuggerMessageHandlers.get(viewInfo.id);
      if (handler) {
        if (!webContents.isDestroyed()) {
          webContents.debugger.removeListener('message', handler);
        }
        this.stealthDebuggerMessageHandlers.delete(viewInfo.id);
      }

      if (webContents.isDestroyed()) {
        console.log(`  ⚠ WebContents already destroyed, skipping debugger detach`);
        return;
      }

      if (webContents.debugger?.isAttached()) {
        webContents.debugger.detach();
        console.log(`  ✓ Debugger detached`);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      // debugger.detach() 可能抛出异常，但不应阻止清理流程
      console.warn(`  ⚠ Failed to detach debugger (non-critical):`, message, error);
    }
  }

  /**
   * 🆕 安全地销毁 WebContents
   * 关键改进：使用 setImmediate 延迟执行，避免崩溃
   * 参考：Electron Issue #29626
   */
  private async safelyDestroyWebContents(viewInfo: WebContentsViewInfo): Promise<void> {
    return new Promise((resolve) => {
      try {
        const { webContents } = viewInfo.view;

        if (webContents.isDestroyed()) {
          console.log(`  ℹ WebContents already destroyed`);
          resolve();
          return;
        }

        // 关键修复：使用 setImmediate 延迟执行 destroy，避免崩溃
        // 参考：Electron Issue #29626
        // 原因：在同步上下文中立即 destroy WebContents 可能导致 Chromium 内部访问违规
        setImmediate(() => {
          try {
            if (!webContents.isDestroyed() && hasDestroyMethod(webContents)) {
              webContents.destroy();
              console.log(`  ✓ WebContents destroyed (delayed)`);
            } else if (!webContents.isDestroyed()) {
              console.warn(
                `  ⚠ WebContents.destroy() method not available in this Electron version`
              );
            }
            resolve();
          } catch (error: unknown) {
            console.warn(`  ⚠ Failed to destroy webContents:`, getErrorMessage(error), error);
            resolve(); // 继续执行，不抛出错误
          }
        });
      } catch (error: unknown) {
        console.warn(`  ⚠ Error in safelyDestroyWebContents:`, getErrorMessage(error), error);
        resolve();
      }
    });
  }

  /**
   * 完全删除 View（从注册表和池中都移除）
   */
  async deleteView(viewId: string): Promise<void> {
    // 先关闭池中的 View（若未激活则跳过，避免重复 close 产生噪音日志）
    if (this.pool.has(viewId)) {
      await this.closeView(viewId);
    }

    // 再从注册表中移除
    this.registry.delete(viewId);

    console.log(`✅ View deleted: ${viewId} (registry: ${this.registry.size})`);
  }

  /**
   * 获取 View 信息
   */
  getView(viewId: string): WebContentsViewInfo | undefined {
    const info = this.pool.get(viewId);
    if (info) {
      info.lastAccessedAt = Date.now();
    }
    return info;
  }

  /**
   * 列出所有已注册的 View（包括未激活的）
   */
  listRegisteredViews(): Array<{
    id: string;
    partition: string;
    metadata?: ViewMetadata;
    isActive: boolean;
  }> {
    return Array.from(this.registry.values()).map((reg) => ({
      id: reg.id,
      partition: reg.partition,
      metadata: reg.metadata,
      isActive: this.pool.has(reg.id),
    }));
  }

  /**
   * 列出池中的活跃 View
   */
  listActiveViews(): Array<{
    id: string;
    partition: string;
    attachedTo?: string;
    createdAt: number;
    lastAccessedAt: number;
    metadata?: ViewMetadata;
  }> {
    return Array.from(this.pool.values()).map((v) => ({
      id: v.id,
      partition: v.partition,
      attachedTo: v.attachedTo,
      createdAt: v.createdAt,
      lastAccessedAt: v.lastAccessedAt,
      metadata: v.metadata,
    }));
  }

  /**
   * 获取池状态
   */
  getPoolStatus(): {
    size: number;
    maxSize: number;
    isFull: boolean;
    views: string[];
  } {
    return {
      size: this.pool.size,
      maxSize: this.maxSize,
      isFull: this.pool.size >= this.maxSize,
      views: Array.from(this.pool.keys()),
    };
  }

  /**
   * 🆕 批量关闭多个 View
   */
  async closeMultipleViews(viewIds: string[]): Promise<{
    closed: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    const closed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of viewIds) {
      try {
        await this.closeView(id);
        closed.push(id);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        failed.push({ id, error: message });
        console.error(`Failed to close view ${id}:`, error);
      }
    }

    console.log(`✅ Batch close completed: ${closed.length} succeeded, ${failed.length} failed`);
    return { closed, failed };
  }

  /**
   * 🆕 关闭最旧的 N 个 View（基于 lastAccessedAt）
   */
  async closeOldestViews(count: number): Promise<string[]> {
    if (count <= 0) {
      return [];
    }

    // 按 lastAccessedAt 排序，最旧的在前
    const sorted = Array.from(this.pool.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    const toClose = sorted.slice(0, Math.min(count, sorted.length));
    const closed: string[] = [];

    for (const viewInfo of toClose) {
      try {
        await this.closeView(viewInfo.id);
        closed.push(viewInfo.id);
      } catch (error) {
        console.error(`Failed to close oldest view ${viewInfo.id}:`, error);
      }
    }

    console.log(`✅ Closed ${closed.length} oldest view(s): [${closed.join(', ')}]`);
    return closed;
  }

  /**
   * 🆕 获取内存使用估算
   */
  getMemoryUsage(): {
    estimatedMB: number;
    perViewMB: number;
    activeViews: number;
    maxViews: number;
    utilizationPercent: number;
  } {
    const perViewMB = 50; // 估算每个 View 约占用 50MB
    const estimatedMB = this.pool.size * perViewMB;
    const utilizationPercent = Math.round((this.pool.size / this.maxSize) * 100);

    return {
      estimatedMB,
      perViewMB,
      activeViews: this.pool.size,
      maxViews: this.maxSize,
      utilizationPercent,
    };
  }

  /**
   * 🆕 获取池的详细状态（增强版）
   */
  getDetailedPoolStatus(): {
    size: number;
    maxSize: number;
    available: number;
    isFull: boolean;
    utilizationPercent: number;
    views: Array<{
      id: string;
      partition: string;
      attachedTo?: string;
      createdAt: number;
      lastAccessedAt: number;
      ageSeconds: number;
    }>;
  } {
    const now = Date.now();
    const views = Array.from(this.pool.values()).map((v) => ({
      id: v.id,
      partition: v.partition,
      attachedTo: v.attachedTo,
      createdAt: v.createdAt,
      lastAccessedAt: v.lastAccessedAt,
      ageSeconds: Math.round((now - v.createdAt) / 1000),
    }));

    return {
      size: this.pool.size,
      maxSize: this.maxSize,
      available: this.maxSize - this.pool.size,
      isFull: this.pool.size >= this.maxSize,
      utilizationPercent: Math.round((this.pool.size / this.maxSize) * 100),
      views,
    };
  }

  /**
   * 🆕 激活插件的所有视图（用于插件安装后启动永久浏览器）
   * @param pluginId 插件ID
   */
  async activatePluginViews(pluginId: string): Promise<void> {
    console.log(`🚀 Activating all views for plugin: ${pluginId}`);

    const views = this.listRegisteredViews().filter((v) => v.metadata?.pluginId === pluginId);

    if (views.length === 0) {
      console.warn(`⚠️  No views found for plugin: ${pluginId}`);
      return;
    }

    console.log(`  📊 Found ${views.length} view(s) to activate`);

    for (const view of views) {
      try {
        await this.activateView(view.id);
        // 初始化视图状态为 idle
        this.viewStates.set(view.id, { status: 'idle' });
        console.log(`  ✅ Activated and marked as idle: ${view.id}`);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error(`  ❌ Failed to activate view ${view.id}:`, message, error);
        // 标记为错误状态
        this.viewStates.set(view.id, {
          status: 'error',
          errorMessage: message,
        });
      }
    }

    console.log(`✅ Plugin views activation completed for: ${pluginId}`);
  }

  /**
   * 🆕 保留视图（锁定视图给特定数据集使用）
   * @param viewIds 要保留的视图ID列表
   * @param datasetId 数据集ID
   * @returns 是否成功保留所有视图
   */
  reserveViews(viewIds: string[], datasetId: string): boolean {
    console.log(`🔒 Attempting to reserve ${viewIds.length} view(s) for dataset: ${datasetId}`);

    // 第一步：检查所有视图是否可用
    for (const viewId of viewIds) {
      const state = this.viewStates.get(viewId);

      if (!state) {
        console.warn(`  ❌ View ${viewId} has no state (not activated)`);
        return false;
      }

      if (state.status !== 'idle') {
        console.warn(
          `  ❌ View ${viewId} is not idle (current: ${state.status}, reserved by: ${state.reservedBy})`
        );
        return false;
      }
    }

    // 第二步：保留所有视图
    const now = Date.now();
    for (const viewId of viewIds) {
      this.viewStates.set(viewId, {
        status: 'reserved',
        reservedBy: datasetId,
        reservedAt: now,
      });
      console.log(`  ✅ Reserved: ${viewId}`);
    }

    console.log(`✅ Successfully reserved ${viewIds.length} view(s) for dataset: ${datasetId}`);
    return true;
  }

  /**
   * 🆕 释放视图（解除锁定）
   * @param datasetId 数据集ID
   */
  releaseViews(datasetId: string): void {
    console.log(`🔓 Releasing views for dataset: ${datasetId}`);

    let releasedCount = 0;
    for (const [viewId, state] of this.viewStates) {
      if (state.reservedBy === datasetId) {
        this.viewStates.set(viewId, { status: 'idle' });
        console.log(`  ✅ Released: ${viewId}`);
        releasedCount++;
      }
    }

    console.log(`✅ Released ${releasedCount} view(s) for dataset: ${datasetId}`);
  }

  /**
   * 🆕 获取插件的可用视图列表（用于UI选择）
   * @param pluginId 插件ID
   * @returns 视图列表及其状态
   */
  getAvailableViews(pluginId: string): Array<{
    id: string;
    label: string;
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    errorMessage?: string;
  }> {
    const views = this.listRegisteredViews().filter((v) => v.metadata?.pluginId === pluginId);

    return views.map((v) => {
      const state = this.viewStates.get(v.id) || { status: 'idle' };
      return {
        id: v.id,
        label: v.metadata?.label || v.id,
        status: state.status,
        reservedBy: state.reservedBy,
        errorMessage: state.errorMessage,
      };
    });
  }

  /**
   * 🆕 标记视图为忙碌状态
   * @param viewId 视图ID
   */
  markViewBusy(viewId: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      console.warn(`⚠️  Cannot mark busy: view ${viewId} has no state`);
      return;
    }

    this.viewStates.set(viewId, {
      ...state,
      status: 'busy',
    });
    console.log(`⏳ View marked as busy: ${viewId}`);
  }

  /**
   * 🆕 标记视图为空闲状态
   * @param viewId 视图ID
   */
  markViewIdle(viewId: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      console.warn(`⚠️  Cannot mark idle: view ${viewId} has no state`);
      return;
    }

    // 保持 reservedBy，只改变状态
    this.viewStates.set(viewId, {
      ...state,
      status: state.reservedBy ? 'reserved' : 'idle',
      errorMessage: undefined, // 清除错误信息
    });
    console.log(`✅ View marked as ${state.reservedBy ? 'reserved' : 'idle'}: ${viewId}`);
  }

  /**
   * 🆕 标记视图为错误状态
   * @param viewId 视图ID
   * @param errorMessage 错误信息
   */
  markViewError(viewId: string, errorMessage: string): void {
    const state = this.viewStates.get(viewId);
    if (!state) {
      console.warn(`⚠️  Cannot mark error: view ${viewId} has no state`);
      return;
    }

    this.viewStates.set(viewId, {
      ...state,
      status: 'error',
      errorMessage,
    });
    console.error(`❌ View marked as error: ${viewId} - ${errorMessage}`);
  }

  /**
   * 🆕 获取视图状态
   * @param viewId 视图ID
   * @returns 视图状态，如果不存在则返回 null
   */
  getViewStatus(viewId: string): {
    status: 'idle' | 'reserved' | 'busy' | 'error';
    reservedBy?: string;
    reservedAt?: number;
    errorMessage?: string;
  } | null {
    return this.viewStates.get(viewId) || null;
  }

  /**
   * 清理所有 View
   */
  async cleanup(): Promise<void> {
    const viewIds = Array.from(this.pool.keys());
    for (const viewId of viewIds) {
      await this.closeView(viewId);
    }
    this.registry.clear();
    this.viewStates.clear(); // 🆕 清理视图状态
    this.rightDockedPoolView = null;
    this.activePluginId = null;
    this.pluginDockLayouts.clear();
    this.pluginPageViewContributions.clear();
    this.pluginPageViewCurrentPluginByView.clear();
    this.sharedPluginPageViewLoadQueue = Promise.resolve();
    console.log('✅ All WebContentsViews cleaned up');
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    registered: number;
    active: number;
    maxSize: number;
    poolUtilization: string;
  } {
    return {
      registered: this.registry.size,
      active: this.pool.size,
      maxSize: this.maxSize,
      poolUtilization: `${this.pool.size}/${this.maxSize} (${Math.round((this.pool.size / this.maxSize) * 100)}%)`,
    };
  }

  /**
   * 获取当前活跃的 View 数量
   */
  getActiveViewCount(): number {
    return this.pool.size;
  }

  /**
   * 🆕 获取资源统计（包含泄漏风险检测）
   */
  getResourceStats(): {
    created: number;
    destroyed: number;
    failed: number;
    active: number;
    leakRisk: number; // 创建 - 销毁 - 活跃 = 可能泄漏的数量
  } {
    const leakRisk = this.stats.created - this.stats.destroyed - this.pool.size;
    return {
      ...this.stats,
      active: this.pool.size,
      leakRisk: Math.max(0, leakRisk),
    };
  }

  /**
   * 🆕 强制垃圾回收（仅用于调试和性能优化）
   * 注意：需要启动时使用 --expose-gc 标志
   */
  async forceGarbageCollection(): Promise<void> {
    if (global.gc) {
      console.log('🗑️  Forcing garbage collection...');
      global.gc();
      console.log('✅ Garbage collection completed');
    } else {
      console.warn('⚠️  Garbage collection not available (run with --expose-gc flag)');
    }
  }

  /**
   * 🆕 通知前端 View 已创建
   * 触发前端标签栏立即更新
   */
  private notifyViewCreated(viewId: string, registration: ViewRegistration): void {
    try {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        const viewData = {
          id: viewId,
          partition: registration.partition,
          metadata: registration.metadata,
        };
        mainWindow.webContents.send('plugin:view-created', viewData);
        console.log(`📢 Notified frontend: plugin:view-created for ${viewId}`);
      }
    } catch (error) {
      console.error(`❌ Failed to notify view created:`, error);
    }
  }

  /**
   * 🆕 通知前端 View 已关闭
   * 触发前端标签栏立即更新
   */
  private notifyViewClosed(viewId: string): void {
    try {
      const mainWindow = this.windowManager.getMainWindowV3();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('plugin:view-closed', { viewId });
        console.log(`📢 Notified frontend: plugin:view-closed for ${viewId}`);
      }
    } catch (error) {
      console.error(`❌ Failed to notify view closed:`, error);
    }
  }

  // ========== ✨ 插件 Activity Bar 视图管理方法 ==========

  /**
   * ✨ 为插件创建页面视图
   */
  async createPluginPageView(
    pluginId: string,
    viewConfig: ActivityBarViewContribution
  ): Promise<string> {
    const viewId = this.registerPluginPageView(pluginId, viewConfig);

    console.log(`🆕 Creating plugin page view: ${viewId}`);

    // 激活视图（创建实际的 WebContentsView）
    await this.activateView(viewId);

    // 确保页面已加载（createPluginPageView 保持旧语义：创建即加载）
    await this.loadPluginPageView(viewId, pluginId);

    console.log(`✅ Plugin page view created: ${viewId}`);
    return viewId;
  }

  private ensureSharedPluginPageViewRegistered(): string {
    if (this.registry.has(SHARED_PLUGIN_PAGE_VIEW_ID)) {
      return SHARED_PLUGIN_PAGE_VIEW_ID;
    }

    this.registerView({
      id: SHARED_PLUGIN_PAGE_VIEW_ID,
      partition: SHARED_PLUGIN_PAGE_PARTITION,
      metadata: {
        label: 'Plugin Shared View',
        temporary: false,
        source: 'plugin',
        stealth: { enabled: false },
      },
    });

    return SHARED_PLUGIN_PAGE_VIEW_ID;
  }

  /**
   * ✨ 注册插件页面视图（仅注册，不创建实际 WebContents）
   *
   * 用途：降低启动/常驻资源占用。真正的 WebContents 会在首次 show/activate 时创建并加载。
   */
  registerPluginPageView(pluginId: string, viewConfig: ActivityBarViewContribution): string {
    this.pluginPageViewContributions.set(pluginId, viewConfig);
    return this.ensureSharedPluginPageViewRegistered();
  }

  /**
   * ✨ 获取插件的所有视图ID
   */
  getPluginViews(pluginId: string): {
    pageViewId: string | null;
    tempViewIds: string[];
  } {
    const activeViewIds = Array.from(this.pool.keys());
    const registeredViewIds = Array.from(this.registry.keys());

    const hasSharedPage =
      this.pluginPageViewContributions.has(pluginId) &&
      (activeViewIds.includes(SHARED_PLUGIN_PAGE_VIEW_ID) ||
        registeredViewIds.includes(SHARED_PLUGIN_PAGE_VIEW_ID));
    const legacyPagePrefix = `plugin-page:${pluginId}:`;
    const tempPrefix = `plugin-temp:${pluginId}:`;

    const pageViewId = hasSharedPage
      ? SHARED_PLUGIN_PAGE_VIEW_ID
      : (activeViewIds.find((id) => id.startsWith(legacyPagePrefix)) ??
        registeredViewIds.find((id) => id.startsWith(legacyPagePrefix)) ??
        null);

    const tempViewIds = Array.from(
      new Set([
        ...activeViewIds.filter((id) => id.startsWith(tempPrefix)),
        ...registeredViewIds.filter((id) => id.startsWith(tempPrefix)),
      ])
    );

    return { pageViewId, tempViewIds };
  }

  /**
   * ✨ 获取视图类型
   * @param viewId 视图ID
   * @returns 视图类型：'page' | 'temp' | 'pool' | 'unknown'
   *
   * 类型说明：
   * - page: 插件主页面视图 (plugin-page:xxx)
   * - temp: 插件临时视图 (plugin-temp:xxx)
   * - pool: 浏览器池创建的视图 (pool:xxx) - MCP/插件/账户登录
   * - unknown: 未知类型
   */
  private getViewType(viewId: string): 'page' | 'temp' | 'pool' | 'unknown' {
    if (viewId.startsWith('plugin-page:')) return 'page';
    if (viewId.startsWith('plugin-temp:')) return 'temp';
    if (viewId.startsWith('pool:')) return 'pool';
    return 'unknown';
  }

  private removePluginDockLayoutsByView(viewId: string): string[] {
    const removed: string[] = [];
    for (const [pluginId, state] of this.pluginDockLayouts.entries()) {
      if (state.viewId === viewId) {
        this.pluginDockLayouts.delete(pluginId);
        removed.push(pluginId);
      }
    }
    return removed;
  }

  /**
   * 🆕 按插件恢复右栏布局
   *
   * 规则：
   * - 切换插件时，先隐藏旧插件的 docked-right 视图（保留映射，便于切回恢复）。
   * - 如果目标插件有记录的右栏视图，则恢复该视图。
   * - 如果没有记录，则插件页使用全宽布局。
   */
  applyPluginDockLayout(pluginId: string): void {
    const normalizedPluginId = pluginId.trim();
    if (!normalizedPluginId) {
      return;
    }

    this.activePluginId = normalizedPluginId;

    const currentDock = this.rightDockedPoolView;
    const desiredDock = this.pluginDockLayouts.get(normalizedPluginId);

    if (currentDock && currentDock.pluginId !== normalizedPluginId) {
      const currentDockView = this.pool.get(currentDock.viewId);
      if (currentDockView) {
        if (!currentDockView.metadata) currentDockView.metadata = {};
        currentDockView.metadata.displayMode = 'offscreen';
        if (currentDockView.attachedTo === 'main') {
          try {
            this.updateBounds(currentDock.viewId, OFFSCREEN_BOUNDS);
          } catch (error) {
            console.warn(
              `[applyPluginDockLayout] Failed to hide previous dock view ${currentDock.viewId}:`,
              error
            );
          }
        }
      }
      this.rightDockedPoolView = null;
    }

    if (!desiredDock) {
      this.handleWindowResize();
      return;
    }

    const desiredViewInfo = this.pool.get(desiredDock.viewId);
    if (!desiredViewInfo) {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
      return;
    }

    if (this.getViewType(desiredDock.viewId) !== 'pool') {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
      return;
    }

    if (desiredViewInfo.attachedTo && desiredViewInfo.attachedTo !== 'main') {
      this.detachView(desiredDock.viewId);
    }

    if (desiredViewInfo.attachedTo !== 'main') {
      const workspace = this.calculateMainWorkspaceBounds();
      if (!workspace) {
        return;
      }
      try {
        this.attachView(desiredDock.viewId, 'main', workspace.fullBounds);
      } catch (error) {
        console.warn(
          `[applyPluginDockLayout] Failed to attach dock view ${desiredDock.viewId} to main window:`,
          error
        );
        return;
      }
    }

    const restored = this.setRightDockedPoolView(
      desiredDock.viewId,
      desiredDock.size,
      normalizedPluginId
    );
    if (!restored) {
      this.pluginDockLayouts.delete(normalizedPluginId);
      if (this.rightDockedPoolView?.pluginId === normalizedPluginId) {
        this.rightDockedPoolView = null;
      }
      this.handleWindowResize();
    }
  }

  private calculateMainWorkspaceBounds(windowBounds?: Rectangle): MainWorkspaceBounds | null {
    const mainWindow = this.windowManager.getMainWindowV3();
    if (!mainWindow) return null;

    const contentBounds = windowBounds ?? mainWindow.getContentBounds();
    const baseLayout = calculateMainWindowPluginLayout(contentBounds, this.activityBarWidth);
    const { windowInfo, fullBounds, pluginBounds: fullscreenPluginBounds } = baseLayout;

    if (!this.rightDockedPoolView) {
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }

    const dockedViewInfo = this.pool.get(this.rightDockedPoolView.viewId);
    if (
      !dockedViewInfo ||
      dockedViewInfo.attachedTo !== 'main' ||
      dockedViewInfo.metadata?.displayMode !== 'docked-right'
    ) {
      this.rightDockedPoolView = null;
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }

    try {
      const splitResult = LayoutCalculator.calculateSplitLayout(
        {
          mode: 'split-right',
          size: this.rightDockedPoolView.size,
        },
        fullBounds
      );

      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: calculateDockedPluginPageBounds(
          splitResult.primary,
          baseLayout.rendererTopInset,
          baseLayout.contentTopInset
        ),
        contentTopInset: baseLayout.contentTopInset,
        rightDockBounds: splitResult.secondary,
      };
    } catch (error) {
      console.warn('⚠️ Failed to calculate right dock bounds, fallback to full layout:', error);
      return {
        windowInfo: {
          width: windowInfo.width,
          height: windowInfo.height,
          activityBarWidth: windowInfo.activityBarWidth,
        },
        fullBounds,
        pluginBounds: fullscreenPluginBounds,
        contentTopInset: baseLayout.contentTopInset,
      };
    }
  }

  /**
   * ✨ 清理插件的所有视图
   */
  async cleanupPluginViews(pluginId: string): Promise<void> {
    console.log(`🧹 Cleaning up views for plugin: ${pluginId}`);

    this.pluginPageViewContributions.delete(pluginId);

    const viewsToCleanup = Array.from(this.pool.keys()).filter((id) => {
      if (id === SHARED_PLUGIN_PAGE_VIEW_ID) return false;
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of viewsToCleanup) {
      await this.closeView(viewId);
    }

    // 同时清理注册表
    const registeredViewsToDelete = Array.from(this.registry.keys()).filter((id) => {
      if (id === SHARED_PLUGIN_PAGE_VIEW_ID) return false;
      return id.includes(`:${pluginId}:`);
    });

    for (const viewId of registeredViewsToDelete) {
      this.registry.delete(viewId);
    }

    if (this.pluginPageViewContributions.size === 0) {
      this.pluginPageViewCurrentPluginByView.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (this.pool.has(SHARED_PLUGIN_PAGE_VIEW_ID)) {
        await this.closeView(SHARED_PLUGIN_PAGE_VIEW_ID);
      }
      this.registry.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
    } else if (
      this.pluginPageViewCurrentPluginByView.get(SHARED_PLUGIN_PAGE_VIEW_ID) === pluginId
    ) {
      const sharedViewInfo = this.pool.get(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (sharedViewInfo?.attachedTo === 'main') {
        this.detachView(SHARED_PLUGIN_PAGE_VIEW_ID);
      }
      this.pluginPageViewCurrentPluginByView.delete(SHARED_PLUGIN_PAGE_VIEW_ID);
      if (this.activePluginId === pluginId) {
        this.activePluginId = null;
      }
    }

    console.log(`✅ Cleaned up ${viewsToCleanup.length} view(s) for plugin: ${pluginId}`);
  }

  /**
   * ✨ 设置窗口尺寸变化监听器（通过 window-manager 的回调机制）
   * @public 必须在主窗口创建完成后调用此方法
   * @returns 清理函数（取消注册回调），失败时返回 null
   */
  setupWindowResizeListener(): (() => void) | null {
    // 通过 window-manager 的回调机制注册监听器
    // 这样可以自动受益于防抖和全屏事件支持
    try {
      const unregister = this.windowManager.registerMainWindowResizeCallback((bounds) => {
        console.log(`📐 [WebContentsViewManager] Received size change notification:`, bounds);
        this.handleWindowResize(bounds);
      });

      console.log('✅ Window size change listener registered via window-manager');
      return unregister;
    } catch (error) {
      console.error('❌ Failed to register window size change listener:', error);
      return null;
    }
  }

  /**
   * ✨ 处理窗口 resize 事件
   *
   * 统一管理所有视图的 resize 响应：
   * - pageView: 插件主页面，始终占用插件可用区域
   * - temp: 临时视图，全屏显示
   * - pool: 浏览器池视图，根据 displayMode 决定是否更新
   */
  private handleWindowResize(windowBounds?: Rectangle): void {
    const workspace = this.calculateMainWorkspaceBounds(windowBounds);
    if (!workspace) return;

    const { windowInfo, fullBounds, pluginBounds, rightDockBounds } = workspace;

    console.log(`📐 Window content resized to: ${windowInfo.width}x${windowInfo.height}`);

    // 遍历所有已附加的视图
    this.pool.forEach((viewInfo, viewId) => {
      // 必须已附加到窗口
      if (!viewInfo.attachedTo) return;

      // 判断视图类型
      const viewType = this.getViewType(viewId);

      if (viewType === 'page') {
        // pageView：需要 pluginId
        if (!viewInfo.metadata?.pluginId) return;
        const pluginId = viewInfo.metadata.pluginId;

        // 插件页面始终使用主工作区（如果存在 docked-right 视图，则是 left 区域）
        this.updateBounds(viewId, pluginBounds);
        this.scheduleViewportDebug(viewId, 'window-resize');
        if (isDevelopmentMode()) {
          console.log(`✅ Updated pageView layout for plugin ${pluginId}:`, pluginBounds);
        } else {
          console.log(`✅ Updated pageView layout for plugin ${pluginId}`);
        }
      } else if (viewType === 'temp') {
        // 临时视图：直接更新为全屏
        this.updateBounds(viewId, fullBounds);
        this.scheduleViewportDebug(viewId, 'window-resize(temp)');
        console.log(`✅ Updated temporary view: ${viewId}`);
      } else if (viewType === 'pool') {
        // 🆕 浏览器池视图：根据 displayMode 决定是否更新
        const displayMode = viewInfo.metadata?.displayMode;

        switch (displayMode) {
          case 'fullscreen':
            // 工作台需要避开 Windows 标题栏按钮区域，其余 fullscreen 视图保持原布局
            this.updateBounds(
              viewId,
              viewId === CLOUD_WORKBENCH_VIEW_ID ? pluginBounds : fullBounds
            );
            console.log(`✅ Updated pool view (fullscreen): ${viewId}`);
            break;

          case 'offscreen':
            // 离屏模式：不需要更新，保持在离屏位置
            break;

          case 'popup':
            // 弹窗模式：由弹窗自己的 resize 监听器处理
            break;

          case 'docked-right':
            if (this.rightDockedPoolView?.viewId !== viewId) {
              console.warn(
                `⚠️ Pool view ${viewId} is marked as docked-right but not tracked as active dock view`
              );
              break;
            }

            if (!rightDockBounds) {
              console.warn(
                `⚠️ Right dock bounds not available for docked view ${viewId}, fallback to full bounds`
              );
              this.updateBounds(viewId, fullBounds);
              break;
            }

            this.updateBounds(viewId, rightDockBounds);
            console.log(`✅ Updated pool view (docked-right): ${viewId}`);
            break;

          default:
            // 🆕 displayMode 未设置：打印警告，默认不处理
            // 这通常表示旧代码创建的视图或状态不一致
            if (displayMode === undefined) {
              console.warn(`⚠️ Pool view ${viewId} has no displayMode set, skipping resize`);
            }
            break;
        }
      }
    });
  }

  /**
   * ✨ 计算插件主视图的边界（永远占满可用区域）
   */
  calculatePluginBounds(pluginId: string): ViewBounds | null {
    const workspace = this.calculateMainWorkspaceBounds();
    if (!workspace) {
      console.warn('⚠️ Main window not found');
      return null;
    }

    console.log(`✅ Calculated plugin bounds for plugin ${pluginId}:`, workspace.pluginBounds);
    return workspace.pluginBounds;
  }

  getPluginLayoutInfo(windowBounds?: Rectangle): PluginLayoutInfo | null {
    const workspace = this.calculateMainWorkspaceBounds(windowBounds);
    if (!workspace) {
      return null;
    }

    return buildPluginLayoutInfo({
      windowInfo: workspace.windowInfo,
      pluginBounds: workspace.pluginBounds,
      contentTopInset: workspace.contentTopInset,
    });
  }

  // ============================================
  // 🆕 统一视图管理 API（用于 MCP/插件/账户浏览器）
  // ============================================

  setRightDockedPoolView(
    viewId: string,
    size: number | string = DEFAULT_SPLIT_SIZE,
    pluginId?: string
  ): boolean {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[setRightDockedPoolView] View not found: ${viewId}`);
      return false;
    }

    if (this.getViewType(viewId) !== 'pool') {
      console.warn(`[setRightDockedPoolView] Only pool views can be docked-right: ${viewId}`);
      return false;
    }

    const normalizedPluginId =
      typeof pluginId === 'string' && pluginId.trim().length > 0 ? pluginId.trim() : undefined;

    const previousDockedViewId = this.rightDockedPoolView?.viewId;
    if (previousDockedViewId && previousDockedViewId !== viewId) {
      const previousDockedView = this.pool.get(previousDockedViewId);
      if (previousDockedView) {
        if (!previousDockedView.metadata) previousDockedView.metadata = {};
        previousDockedView.metadata.displayMode = 'offscreen';
        if (previousDockedView.attachedTo === 'main') {
          this.updateBounds(previousDockedViewId, OFFSCREEN_BOUNDS);
        }
      }
    }

    this.rightDockedPoolView = { viewId, size, pluginId: normalizedPluginId };
    if (normalizedPluginId) {
      this.pluginDockLayouts.set(normalizedPluginId, { viewId, size });
    }

    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.displayMode = 'docked-right';

    if (viewInfo.attachedTo === 'main') {
      this.handleWindowResize();
    }

    console.log(
      `✅ [setRightDockedPoolView] Docked right view set: ${viewId} (size=${String(size)}, plugin=${normalizedPluginId ?? 'none'})`
    );
    return true;
  }

  clearRightDockedPoolView(viewId?: string): boolean {
    if (!this.rightDockedPoolView) {
      return false;
    }

    if (viewId && this.rightDockedPoolView.viewId !== viewId) {
      return false;
    }

    const dockedState = this.rightDockedPoolView;
    const dockedViewId = dockedState.viewId;
    const dockedViewInfo = this.pool.get(dockedViewId);
    this.rightDockedPoolView = null;
    if (dockedState.pluginId) {
      this.pluginDockLayouts.delete(dockedState.pluginId);
    }

    if (
      dockedViewInfo &&
      dockedViewInfo.metadata?.displayMode === 'docked-right' &&
      dockedViewInfo.attachedTo === 'main'
    ) {
      dockedViewInfo.metadata.displayMode = 'offscreen';
      this.updateBounds(dockedViewId, OFFSCREEN_BOUNDS);
    }

    this.handleWindowResize();
    console.log(`✅ [clearRightDockedPoolView] Cleared docked right view: ${dockedViewId}`);
    return true;
  }

  getRightDockedPoolView(): RightDockedPoolViewState | null {
    if (!this.rightDockedPoolView) return null;
    return { ...this.rightDockedPoolView };
  }

  /**
   * 🆕 设置视图的显示模式
   *
   * 当浏览器池视图需要从离屏切换到全屏显示（或反之）时调用。
   * 这会更新视图的 displayMode 元数据，使其能够正确响应窗口 resize。
   *
   * @param viewId 视图 ID
   * @param displayMode 显示模式
   * @returns 是否成功设置
   */
  setViewDisplayMode(viewId: string, displayMode: ViewDisplayMode): boolean {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[setViewDisplayMode] View not found: ${viewId}`);
      return false;
    }

    const beforeDockedViewId = this.rightDockedPoolView?.viewId;

    if (displayMode === 'docked-right') {
      const currentDockedPluginId =
        this.rightDockedPoolView?.viewId === viewId ? this.rightDockedPoolView.pluginId : undefined;
      this.rightDockedPoolView = {
        viewId,
        size: this.rightDockedPoolView?.size ?? DEFAULT_SPLIT_SIZE,
        pluginId: currentDockedPluginId,
      };
    } else if (this.rightDockedPoolView?.viewId === viewId) {
      this.rightDockedPoolView = null;
    }

    // 更新元数据
    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.displayMode = displayMode;

    const afterDockedViewId = this.rightDockedPoolView?.viewId;
    const dockStateChanged = beforeDockedViewId !== afterDockedViewId;
    if (dockStateChanged && viewInfo.attachedTo === 'main') {
      this.handleWindowResize();
    }

    console.log(`✅ [setViewDisplayMode] Set displayMode=${displayMode} for view: ${viewId}`);
    return true;
  }

  /**
   * 🆕 设置视图的来源标记
   *
   * 标记视图是由哪个模块创建的，便于调试和资源追踪。
   *
   * @param viewId 视图 ID
   * @param source 视图来源
   * @returns 是否成功设置
   */
  setViewSource(viewId: string, source: ViewSource): boolean {
    const viewInfo = this.pool.get(viewId);
    if (!viewInfo) {
      console.warn(`[setViewSource] View not found: ${viewId}`);
      return false;
    }

    // 更新元数据
    if (!viewInfo.metadata) {
      viewInfo.metadata = {};
    }
    viewInfo.metadata.source = source;

    console.log(`✅ [setViewSource] Set source=${source} for view: ${viewId}`);
    return true;
  }

  /**
   * 🆕 获取视图的显示模式
   *
   * @param viewId 视图 ID
   * @returns 显示模式，如果视图不存在则返回 undefined
   */
  getViewDisplayMode(viewId: string): ViewDisplayMode | undefined {
    const viewInfo = this.pool.get(viewId);
    return viewInfo?.metadata?.displayMode;
  }

  /**
   * 🆕 获取所有指定显示模式的视图
   *
   * @param displayMode 显示模式
   * @returns 匹配的视图 ID 列表
   */
  getViewsByDisplayMode(displayMode: ViewDisplayMode): string[] {
    const result: string[] = [];
    this.pool.forEach((viewInfo, viewId) => {
      if (viewInfo.metadata?.displayMode === displayMode) {
        result.push(viewId);
      }
    });
    return result;
  }

  /**
   * 🆕 获取所有指定来源的视图
   *
   * @param source 视图来源
   * @returns 匹配的视图 ID 列表
   */
  getViewsBySource(source: ViewSource): string[] {
    const result: string[] = [];
    this.pool.forEach((viewInfo, viewId) => {
      if (viewInfo.metadata?.source === source) {
        result.push(viewId);
      }
    });
    return result;
  }

  /**
   * 获取插件路径（辅助方法）
   */
  private getPluginPath(pluginId: string): string {
    return path.join(app.getPath('userData'), 'js-plugins', pluginId);
  }
}
