/**
 * Profile Namespace - 浏览器配置访问和池化浏览器管理
 *
 * v2 架构：为插件提供访问和管理浏览器 Profile 的完整能力
 *
 * 重要：本命名空间运行在主进程，直接调用服务而非通过 IPC
 *
 * 职责分离：
 * - 平台提供能力（CRUD Profile、启动/释放浏览器）
 * - 插件决定如何使用（选择、批量、自动等）
 *
 * @example
 * // 列出所有可用配置
 * const profiles = await helpers.profile.list();
 *
 * // 获取单个配置
 * const profile = await helpers.profile.get('profile-id');
 *
 * // 创建新配置（v2.1 新增）
 * const newProfile = await helpers.profile.create({
 *   name: '店铺账号',
 *   tags: ['自动创建'],
 * });
 *
 * // 更新配置（v2.1 新增）
 * await helpers.profile.update(newProfile.id, { name: '新名称' });
 *
 * // 删除配置（v2.1 新增）
 * await helpers.profile.delete(newProfile.id);
 *
 * // 启动浏览器（默认独占当前 Profile 的 live session）
 * const handle = await helpers.profile.launch('profile-id');
 * await handle.browser.goto('https://example.com');
 * await handle.release(); // 释放回池
 */

import type {
  BrowserProfile,
  ProfileListParams,
  CreateProfileParams,
  UpdateProfileParams,
  FingerprintConfig,
} from '../../../types/profile';
import type { ProfileService } from '../../../main/duckdb/profile-service';
import type { ProfileGroupService } from '../../../main/duckdb/profile-group-service';
import type { WebContentsViewManager } from '../../../main/webcontentsview-manager';
import type { WindowManager } from '../../../main/window-manager';
import type { BrowserInterface } from '../../../types/browser-interface';
import type { BrowserRuntimeDescriptor } from '../../../types/browser-interface';
import {
  getBrowserPoolManager,
  showBrowserView,
  hideBrowserView,
  showBrowserViewInPopup,
  closeBrowserPopup,
} from '../../browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../browser-pool/profile-live-session-lease';
import type { AutomationEngine, BrowserHandle, ReleaseOptions } from '../../browser-pool/types';
import {
  getPresetById,
  getDefaultFingerprint,
  FINGERPRINT_PRESET_OPTIONS,
} from '../../../constants/fingerprint-defaults';
import { mergeFingerprintConfig } from '../../../constants/fingerprint-defaults';
import {
  buildProfileResourceKey,
  resourceCoordinator,
} from '../../resource-coordinator';
import { generateVariant, applyPreset as applyPresetConfig } from '../../../main/profile/presets';
import { fingerprintManager } from '../../stealth';
import { validateFingerprintConfig } from '../../fingerprint/fingerprint-validation';
import {
  getStaticEngineRuntimeDescriptor,
} from '../../browser-pool/engine-capability-registry';

const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS = {
  session: 'browser.getCookies(filter?), browser.setCookie(cookie), browser.clearCookies(), browser.getUserAgent()',
  cdp: 'browser.startNetworkCapture(options), browser.getNetworkEntries(filter), browser.waitForResponse(urlPattern, timeout)',
  capture: 'browser.screenshot(options), browser.screenshotDetailed(options), browser.snapshot(options)',
} as const;

type PluginBrowserBlockedProperty = keyof typeof PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS;

function createPrivateBrowserApiError(property: PluginBrowserBlockedProperty): Error {
  const migration = PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS[property];
  const error = new Error(
    `browser.${property} is not available in plugin runtime. Migrate to ${migration}.`
  ) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.name = 'PluginBrowserApiError';
  error.code = 'PLUGIN_BROWSER_PRIVATE_API_BLOCKED';
  error.details = {
    property,
    migration,
  };
  return error;
}

function createPluginBrowserFacade(browser: BrowserInterface): BrowserInterface {
  const target: Record<string, unknown> = {};
  const hasCapability =
    typeof browser.hasCapability === 'function'
      ? browser.hasCapability.bind(browser)
      : (_name: string) => false;

  const bindMethod = <K extends keyof BrowserInterface>(name: K): void => {
    const value = browser[name];
    if (typeof value === 'function') {
      target[name as string] = (value as Function).bind(browser);
    } else if (value !== undefined) {
      target[name as string] = value;
    }
  };

  bindMethod('describeRuntime');
  target.hasCapability = hasCapability;
  bindMethod('goto');
  bindMethod('back');
  bindMethod('forward');
  bindMethod('reload');
  bindMethod('getCurrentUrl');
  bindMethod('title');
  bindMethod('snapshot');
  bindMethod('click');
  bindMethod('type');
  bindMethod('select');
  bindMethod('waitForSelector');
  bindMethod('getText');
  bindMethod('getAttribute');
  bindMethod('search');
  bindMethod('evaluate');
  bindMethod('evaluateWithArgs');
  bindMethod('screenshot');
  bindMethod('screenshotDetailed');
  bindMethod('getCookies');
  bindMethod('setCookie');
  bindMethod('clearCookies');
  bindMethod('getUserAgent');
  bindMethod('startNetworkCapture');
  bindMethod('stopNetworkCapture');
  bindMethod('getNetworkEntries');
  bindMethod('getNetworkSummary');
  bindMethod('clearNetworkEntries');
  bindMethod('waitForResponse');
  bindMethod('startConsoleCapture');
  bindMethod('stopConsoleCapture');
  bindMethod('getConsoleMessages');
  bindMethod('clearConsoleMessages');
  bindMethod('show');
  bindMethod('hide');
  bindMethod('clickAtNormalized');
  bindMethod('dragNormalized');
  bindMethod('moveToNormalized');
  bindMethod('scrollAtNormalized');
  bindMethod('clickText');
  bindMethod('findTextNormalized');
  bindMethod('findTextNormalizedDetailed');
  bindMethod('findText');
  bindMethod('textExists');
  bindMethod('recognizeText');
  bindMethod('setDownloadBehavior');
  bindMethod('listDownloads');
  bindMethod('waitForDownload');
  bindMethod('cancelDownload');
  bindMethod('waitForDialog');
  bindMethod('handleDialog');
  bindMethod('listTabs');
  bindMethod('createTab');
  bindMethod('activateTab');
  bindMethod('closeTab');
  if (hasCapability('emulation.identity')) {
    bindMethod('setEmulationIdentity');
    bindMethod('clearEmulation');
  }
  if (hasCapability('emulation.viewport')) {
    bindMethod('setViewportEmulation');
  }
  bindMethod('enableRequestInterception');
  bindMethod('disableRequestInterception');
  bindMethod('getInterceptedRequests');
  bindMethod('clearInterceptedRequests');
  bindMethod('waitForInterceptedRequest');
  bindMethod('continueRequest');
  bindMethod('fulfillRequest');
  bindMethod('failRequest');
  bindMethod('setWindowOpenPolicy');
  bindMethod('getWindowOpenPolicy');
  bindMethod('clearWindowOpenPolicy');

  if (browser.native) {
    target.native = browser.native;
  }

  if (typeof browser.withAbortSignal === 'function') {
    target.withAbortSignal = (signal: AbortSignal) =>
      createPluginBrowserFacade(browser.withAbortSignal!(signal));
  }

  return new Proxy(target as unknown as BrowserInterface, {
    get(currentTarget, prop, receiver) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        throw createPrivateBrowserApiError(prop as PluginBrowserBlockedProperty);
      }
      return Reflect.get(currentTarget, prop, receiver);
    },
    has(currentTarget, prop) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        return false;
      }
      return Reflect.has(currentTarget, prop);
    },
    ownKeys(currentTarget) {
      return Reflect.ownKeys(currentTarget).filter(
        (key) =>
          typeof key !== 'string' ||
          !Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, key)
      );
    },
    getOwnPropertyDescriptor(currentTarget, prop) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(currentTarget, prop);
    },
  });
}

/**
 * 启动选项
 */
export interface LaunchOptions {
  /** 获取策略：any-任意可用、fresh-优先新建、reuse-优先复用 */
  strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
  /** strategy=specific 时使用 */
  browserId?: string;
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 初始 URL */
  url?: string;
  signal?: AbortSignal;
  /** 是否可见，默认 false（隐藏模式，浏览器在离屏位置运行） */
  visible?: boolean;
  /**
   * visible=true 时的布局模式，默认 right-docked（固定右栏）。
   * 仅 Electron 内嵌视图模式有效；Extension 外部窗口路径会忽略该选项。
   * 若 options 未传，会读取插件级配置：
   * - profile.launch.visibleLayout
   * - profileLaunchVisibleLayout
   */
  visibleLayout?: 'right-docked' | 'fullscreen';
  /**
   * visibleLayout=right-docked 时右栏宽度（像素或百分比，如 520, '40%'）。
   * 仅 Electron 内嵌视图模式有效；Extension 外部窗口路径会忽略该选项。
   * 若 options 未传，会读取插件级配置：
   * - profile.launch.rightDockSize
   * - profileLaunchRightDockSize
   */
  rightDockSize?: number | string;
  /** 自动化引擎（默认 'electron'） */
  engine?: AutomationEngine;
}

/**
 * 弹窗启动选项
 */
export interface LaunchPopupOptions {
  /** 获取策略：any-任意可用、fresh-优先新建、reuse-优先复用 */
  strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
  /** strategy=specific 时使用 */
  browserId?: string;
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 初始 URL */
  url?: string;
  signal?: AbortSignal;
  /** 自动化引擎（默认 'electron'） */
  engine?: AutomationEngine;
  /** 弹窗标题，仅 Electron 内嵌弹窗有效 */
  title?: string;
  /** 弹窗宽度，默认 1200，仅 Electron 内嵌弹窗有效 */
  width?: number;
  /** 弹窗高度，默认 800，仅 Electron 内嵌弹窗有效 */
  height?: number;
  /** 是否自动打开当前弹窗浏览器的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
  /** 弹窗关闭时的回调；Extension 外部窗口路径下在调用 closePopup() 时触发 */
  onClose?: () => void;
}

/**
 * 弹窗浏览器句柄（扩展 BrowserHandle）
 */
export interface PopupBrowserHandle extends BrowserHandle {
  /** 弹窗 ID；Extension 外部窗口路径下格式为 external:<browserId> */
  popupId: string;
  /** 关闭弹窗；Extension 外部窗口路径下等价于隐藏窗口 */
  closePopup: () => void;
}

export interface WithLeaseRunContext {
  browser: BrowserHandle['browser'];
  browserId: string;
  sessionId: string;
  engine: AutomationEngine;
  viewId?: string;
  release: (options?: ReleaseOptions) => Promise<void>;
  renew: (extensionMs?: number) => Promise<void>;
}

export interface WithLeaseOptions extends LaunchOptions {
  resourceWaitTimeoutMs?: number;
  autoRenew?: boolean;
  renewIntervalMs?: number;
  renewExtensionMs?: number;
  release?: ReleaseOptions;
}

interface ManagedProfileLease {
  handle: BrowserHandle;
  refCount: number;
  renewTimer: NodeJS.Timeout | null;
  released: boolean;
  release: (options?: ReleaseOptions) => Promise<void>;
  renew: (extensionMs?: number) => Promise<void>;
}

/**
 * 指纹生成选项（暴露给插件）
 */
export interface GenerateFingerprintOptions {
  /** 操作系统 */
  os?: 'windows' | 'macos' | 'linux';
  /** 浏览器 */
  browser?: 'chrome' | 'firefox' | 'edge';
  /** 浏览器最小版本 */
  browserMinVersion?: number;
  /** 浏览器最大版本 */
  browserMaxVersion?: number;
  /** 设备类型 */
  device?: 'desktop' | 'mobile';
  /** 语言列表 */
  locales?: string[];
  /** 屏幕宽度范围 */
  screenWidth?: { min?: number; max?: number };
  /** 屏幕高度范围 */
  screenHeight?: { min?: number; max?: number };
}

function normalizeLocaleList(locales?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLocale of Array.isArray(locales) ? locales : []) {
    const locale = String(rawLocale || '').trim();
    if (!locale || seen.has(locale)) {
      continue;
    }
    seen.add(locale);
    out.push(locale);
  }
  return out;
}

function parseFingerprintVersionMajor(version: string | undefined): number | null {
  const major = Number.parseInt(String(version || '').split('.')[0] || '', 10);
  return Number.isFinite(major) && major > 0 ? major : null;
}

function resolveDimensionWithinRange(
  current: number,
  range?: { min?: number; max?: number }
): number | undefined {
  if (!range) {
    return undefined;
  }

  const min =
    typeof range.min === 'number' && Number.isFinite(range.min) && range.min > 0
      ? Math.round(range.min)
      : undefined;
  const max =
    typeof range.max === 'number' && Number.isFinite(range.max) && range.max > 0
      ? Math.round(range.max)
      : undefined;
  const lower = min ?? max ?? Math.max(1, Math.round(current));
  const upper = max ?? min ?? Math.max(lower, Math.round(current));
  if (lower > upper) {
    return lower;
  }

  const safeCurrent = Math.max(lower, Math.min(upper, Math.round(current)));
  if (lower === upper) {
    return lower;
  }
  const span = upper - lower;
  const offset = Math.min(span, Math.abs(safeCurrent - lower));
  return lower + Math.floor(Math.random() * (offset + 1));
}

/**
 * 指纹验证结果
 */
export interface FingerprintValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 警告信息列表 */
  warnings: string[];
}

/**
 * 预设信息（简化版，用于列表展示）
 */
export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  os: string;
  browser: string;
}

/**
 * Profile 命名空间
 */
export class ProfileNamespace {
  private readonly pluginConfigKeys = {
    visibleLayout: ['profile.launch.visibleLayout', 'profileLaunchVisibleLayout'] as const,
    rightDockSize: ['profile.launch.rightDockSize', 'profileLaunchRightDockSize'] as const,
  };

  constructor(
    private pluginId: string,
    private profileService: ProfileService,
    private groupService: ProfileGroupService,
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager,
    private getPluginConfig?: (key: string) => Promise<any>
  ) {}

  describeEngineRuntime(engine: AutomationEngine = 'electron'): BrowserRuntimeDescriptor {
    return getStaticEngineRuntimeDescriptor(engine);
  }

  listEngineRuntimes(): Record<AutomationEngine, BrowserRuntimeDescriptor> {
    return {
      electron: getStaticEngineRuntimeDescriptor('electron'),
      extension: getStaticEngineRuntimeDescriptor('extension'),
      ruyi: getStaticEngineRuntimeDescriptor('ruyi'),
    };
  }

  private normalizeVisibleLayout(value: unknown): 'right-docked' | 'fullscreen' | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'right-docked' ||
      normalized === 'right_docked' ||
      normalized === 'docked-right'
    ) {
      return 'right-docked';
    }
    if (normalized === 'fullscreen' || normalized === 'full') {
      return 'fullscreen';
    }
    return undefined;
  }

  private normalizeRightDockSize(value: unknown): number | string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return undefined;
  }

  private async readPluginConfigValue<T>(
    keys: readonly string[],
    parser: (value: unknown) => T | undefined
  ): Promise<T | undefined> {
    if (!this.getPluginConfig) return undefined;

    for (const key of keys) {
      try {
        const raw = await this.getPluginConfig(key);
        const parsed = parser(raw);
        if (parsed !== undefined) {
          return parsed;
        }
      } catch (error) {
        console.warn(`[Profile.launch] Failed to read plugin config "${key}":`, error);
      }
    }

    return undefined;
  }

  private async resolveVisibleLayout(
    options?: LaunchOptions
  ): Promise<'right-docked' | 'fullscreen'> {
    return (
      options?.visibleLayout ??
      (await this.readPluginConfigValue(
        this.pluginConfigKeys.visibleLayout,
        this.normalizeVisibleLayout.bind(this)
      )) ??
      'right-docked'
    );
  }

  private async resolveRightDockSize(
    options?: LaunchOptions
  ): Promise<number | string | undefined> {
    return (
      options?.rightDockSize ??
      (await this.readPluginConfigValue(
        this.pluginConfigKeys.rightDockSize,
        this.normalizeRightDockSize.bind(this)
      ))
    );
  }

  private async applyHandleVisibility(
    handle: BrowserHandle,
    visible: boolean,
    state: {
      visibleLayout: 'right-docked' | 'fullscreen';
      rightDockSize?: number | string;
    }
  ): Promise<void> {
    if (handle.viewId) {
      if (visible) {
        const shown = showBrowserView(handle.viewId, this.viewManager, this.windowManager, {
          windowId: 'main',
          source: 'pool',
          layout: state.visibleLayout === 'fullscreen' ? 'fullscreen' : 'docked-right',
          rightDockSize: state.rightDockSize,
          pluginId: this.pluginId,
        });
        if (!shown) {
          throw new Error(
            `[Profile.launch] Failed to show browser view ${handle.viewId} (layout=${state.visibleLayout})`
          );
        }
      } else {
        hideBrowserView(handle.viewId, this.viewManager);
      }
      return;
    }

    // 非 Electron 引擎：尝试使用 BrowserInterface.show/hide
    if (visible && typeof handle.browser.show === 'function') {
      await handle.browser.show();
    } else if (!visible && typeof handle.browser.hide === 'function') {
      await handle.browser.hide();
    }
  }

  private attachVisibilityControlsToHandle(
    handle: BrowserHandle,
    state: {
      visibleLayout: 'right-docked' | 'fullscreen';
      rightDockSize?: number | string;
    }
  ): BrowserHandle {
    const originalShow =
      typeof handle.browser.show === 'function'
        ? handle.browser.show.bind(handle.browser)
        : undefined;
    const originalHide =
      typeof handle.browser.hide === 'function'
        ? handle.browser.hide.bind(handle.browser)
        : undefined;
    const originalRelease = handle.release.bind(handle);

    handle.browser.show = async () => {
      if (!handle.viewId) {
        if (originalShow) {
          await originalShow();
        }
        return;
      }

      await this.applyHandleVisibility(handle, true, state);
      if (originalShow) {
        // Electron 引擎下保留 focus 行为
        await originalShow().catch(() => undefined);
      }
    };

    handle.browser.hide = async () => {
      if (!handle.viewId) {
        if (originalHide) {
          await originalHide();
        }
        return;
      }

      await this.applyHandleVisibility(handle, false, state);
      if (originalHide) {
        await originalHide().catch(() => undefined);
      }
    };

    handle.release = async (releaseOptions?: ReleaseOptions) => {
      if (handle.viewId) {
        // 释放前统一回收可见布局，避免残留 dock/split 影响后续切换
        await this.applyHandleVisibility(handle, false, state).catch(() => undefined);
      } else if (originalHide) {
        await originalHide().catch(() => undefined);
      }
      return originalRelease(releaseOptions);
    };

    return handle;
  }

  private wrapBrowserHandle(handle: BrowserHandle): BrowserHandle {
    return {
      ...handle,
      browser: createPluginBrowserFacade(handle.browser),
      release: handle.release.bind(handle),
      renew: handle.renew.bind(handle),
    };
  }

  private wrapPopupBrowserHandle(handle: PopupBrowserHandle): PopupBrowserHandle {
    return {
      ...this.wrapBrowserHandle(handle),
      popupId: handle.popupId,
      closePopup: handle.closePopup.bind(handle),
    };
  }

  /**
   * 在单个 callback 内独占使用某个 profile 的 live browser session。
   *
   * 注意：
   * - 同一 `profileId` 默认串行执行；如果已有持有者，新的 `withLease()` 会进入资源队列等待。
   * - 如果同一个 profile 仍被 `launchPopup()` 持有，另一个动作里再次 `withLease()` 往往会表现为“长时间无响应”。
   *   这种场景应复用现有 popup browser，或先释放 popup handle，再发起新的 `withLease()`。
   */
  async withLease<T>(
    profileId: string,
    options: WithLeaseOptions | undefined,
    handler: (ctx: WithLeaseRunContext) => Promise<T>
  ): Promise<T> {
    const normalizedProfileId = String(profileId || '').trim();
    if (!normalizedProfileId) {
      throw new Error('profileId is required');
    }

    const resourceKey = buildProfileResourceKey(normalizedProfileId);
    const resourceWaitTimeoutMs =
      typeof options?.resourceWaitTimeoutMs === 'number' && options.resourceWaitTimeoutMs > 0
        ? options.resourceWaitTimeoutMs
        : DEFAULT_RESOURCE_WAIT_TIMEOUT_MS;
    const releaseOptions: ReleaseOptions = {
      navigateTo: 'about:blank',
      ...(options?.release || {}),
    };

    const runWithLease = async (): Promise<T> => {
      const context = resourceCoordinator.getCurrentContext();
      const existingLease = context?.profileLeases.get(normalizedProfileId) as
        | ManagedProfileLease
        | undefined;

      if (existingLease) {
        existingLease.refCount += 1;
        try {
          return await handler({
            browser: existingLease.handle.browser,
            browserId: existingLease.handle.browserId,
            sessionId: existingLease.handle.sessionId,
            engine: existingLease.handle.engine,
            viewId: existingLease.handle.viewId,
            release: existingLease.release,
            renew: existingLease.renew,
          });
        } finally {
          existingLease.refCount -= 1;
        }
      }

      const profile = await this.profileService.get(normalizedProfileId);
      const lockTimeoutMs =
        typeof profile?.lockTimeoutMs === 'number' && profile.lockTimeoutMs > 0
          ? profile.lockTimeoutMs
          : 120000;
      const renewIntervalMs =
        typeof options?.renewIntervalMs === 'number' && options.renewIntervalMs > 0
          ? options.renewIntervalMs
          : Math.max(10000, Math.min(60000, Math.floor(lockTimeoutMs / 2)));

      const handle = await this.launch(normalizedProfileId, {
        ...options,
        timeout: options?.timeout ?? resourceWaitTimeoutMs,
        signal: options?.signal,
      });

      const releaseHandle = async (overrideReleaseOptions?: ReleaseOptions) => {
        if (lease.released) return;
        lease.released = true;
        if (lease.renewTimer) {
          clearInterval(lease.renewTimer);
          lease.renewTimer = null;
        }
        context?.profileLeases.delete(normalizedProfileId);
        await handle.release({
          ...releaseOptions,
          ...(overrideReleaseOptions || {}),
        });
      };

      const lease: ManagedProfileLease = {
        handle,
        refCount: 1,
        renewTimer: null,
        released: false,
        release: releaseHandle,
        renew: async (extensionMs?: number) => {
          if (lease.released) return;
          await handle.renew(extensionMs);
        },
      };
      context?.profileLeases.set(normalizedProfileId, lease);

      if (options?.autoRenew !== false) {
        lease.renewTimer = setInterval(() => {
          void handle.renew(options?.renewExtensionMs).catch(() => undefined);
        }, renewIntervalMs);
        lease.renewTimer.unref?.();
      }

      try {
        return await handler({
          browser: handle.browser,
          browserId: handle.browserId,
          sessionId: handle.sessionId,
          engine: handle.engine,
          viewId: handle.viewId,
          release: lease.release,
          renew: lease.renew,
        });
      } finally {
        lease.refCount -= 1;
        if (lease.refCount <= 0 && !lease.released) {
          await lease.release();
        }
      }
    };

    const currentContext = resourceCoordinator.getCurrentContext();
    if (currentContext?.heldKeys.has(resourceKey)) {
      return await runWithLease();
    }

    return await resourceCoordinator.runExclusive(
      [resourceKey],
      {
        ownerToken: currentContext?.ownerToken,
        timeoutMs: resourceWaitTimeoutMs,
        signal: options?.signal,
      },
      runWithLease
    );
  }

  /**
   * 列出浏览器配置
   *
   * @param params 过滤参数
   * @returns 配置列表
   *
   * @example
   * // 列出所有配置
   * const all = await helpers.profile.list();
   *
   * // 按分组筛选
   * const grouped = await helpers.profile.list({ groupId: 'group-id' });
   *
   * // 只获取空闲状态的配置
   * const idle = await helpers.profile.list({ status: 'idle' });
   */
  async list(params?: ProfileListParams): Promise<BrowserProfile[]> {
    return this.profileService.list(params);
  }

  /**
   * 获取单个浏览器配置
   *
   * @param id 配置 ID
   * @returns 配置详情，不存在返回 null
   *
   * @example
   * const profile = await helpers.profile.get('profile-id');
   * if (profile) {
   *   console.log(`配置名称: ${profile.name}`);
   *   console.log(`代理: ${profile.proxy?.host || '直连'}`);
   * }
   */
  async get(id: string): Promise<BrowserProfile | null> {
    return this.profileService.get(id);
  }

  /**
   * 创建新的浏览器配置
   *
   * 允许插件动态创建 Profile，用于需要自动管理浏览器配置的场景。
   *
   * @param params 创建参数
   * @returns 创建的 Profile
   *
   * @example
   * // 创建基本配置
   * const profile = await helpers.profile.create({
   *   name: '店铺账号-001',
   * });
   *
   * @example
   * // 创建带代理的配置
   * const profile = await helpers.profile.create({
   *   name: '代理账号',
   *   proxy: {
   *     type: 'http',
   *     host: '127.0.0.1',
   *     port: 8080,
   *   },
   * });
   *
   * @example
   * // 创建带自定义指纹的配置
   * const profile = await helpers.profile.create({
   *   name: '自定义指纹',
   *   fingerprint: {
   *     timezone: 'Asia/Shanghai',
   *     language: 'zh-CN',
   *     languages: ['zh-CN', 'en-US'],
   *   },
   *   tags: ['自动创建', '店铺'],
   *   notes: '由插件自动创建',
   * });
   */
  async create(params: CreateProfileParams): Promise<BrowserProfile> {
    console.log(`[Profile] Creating profile for plugin ${this.pluginId}: ${params.name}`);
    const profile = await this.profileService.create(params);
    console.log(`[Profile] Profile created: ${profile.id} (${profile.name})`);
    return profile;
  }

  /**
   * 更新浏览器配置
   *
   * @param id Profile ID
   * @param params 更新参数（部分更新）
   * @returns 更新后的 Profile
   *
   * @example
   * // 更新名称
   * const profile = await helpers.profile.update('profile-id', {
   *   name: '新名称',
   * });
   *
   * @example
   * // 更新代理配置
   * const profile = await helpers.profile.update('profile-id', {
   *   proxy: {
   *     type: 'socks5',
   *     host: '192.168.1.1',
   *     port: 1080,
   *   },
   * });
   *
   * @example
   * // 清除代理
   * const profile = await helpers.profile.update('profile-id', {
   *   proxy: null,
   * });
   */
  async update(id: string, params: UpdateProfileParams): Promise<BrowserProfile> {
    console.log(`[Profile] Updating profile for plugin ${this.pluginId}: ${id}`);
    const profile = await this.profileService.update(id, params);

    const runtimeChanged = params.fingerprint !== undefined || params.engine !== undefined;

    if (runtimeChanged) {
      try {
        fingerprintManager.clearCache(profile.id);
      } catch {
        // ignore
      }

      try {
        fingerprintManager.clearCache(profile.partition);
      } catch {
        // ignore
      }

      try {
        const poolManager = getBrowserPoolManager();
        const destroyedCount = await poolManager.destroyProfileBrowsers(id);
        if (destroyedCount > 0) {
          console.log(
            `[Profile] Runtime fields changed, destroyed ${destroyedCount} browser(s) for profile: ${id}`
          );
        }
      } catch {
        // ignore
      }
    }

    console.log(`[Profile] Profile updated: ${profile.id}`);
    return profile;
  }

  /**
   * 删除浏览器配置
   *
   * 注意：
   * - 无法删除正在使用的配置（status === 'active'）
   * - 无法删除系统内置配置（isSystem === true）
   * - 删除操作不可逆
   *
   * @param id Profile ID
   * @throws 如果配置正在使用或为系统配置
   *
   * @example
   * // 删除配置
   * await helpers.profile.delete('profile-id');
   *
   * @example
   * // 安全删除（先检查状态）
   * const profile = await helpers.profile.get('profile-id');
   * if (profile && profile.status === 'idle' && !profile.isSystem) {
   *   await helpers.profile.delete('profile-id');
   * }
   */
  async delete(id: string): Promise<void> {
    console.log(`[Profile] Deleting profile for plugin ${this.pluginId}: ${id}`);
    // 与 UI 删除行为保持一致：保留账号并解除平台绑定，避免出现悬空绑定
    await this.profileService.deleteWithCascade(id);
    console.log(`[Profile] Profile deleted: ${id}`);
  }

  /**
   * 检查配置是否可用
   *
   * 注意：此方法只反映当前 profile 是否尚未持有 live browser instance，
   * 不保证当前一定能立刻拿到默认的 `exclusive-live` handle。
   * 若同一 profile 已有活跃持有者，`launch()` 仍可能排队等待。
   *
   * @param id 配置 ID
   * @returns 是否可用
   *
   * @example
   * if (await helpers.profile.isAvailable('profile-id')) {
   *   const handle = await helpers.profile.launch('profile-id');
   * } else {
   *   helpers.ui.warn('配置当前已被占用');
   * }
   */
  async isAvailable(id: string): Promise<boolean> {
    try {
      const poolManager = getBrowserPoolManager();
      const stats = await poolManager.getProfileStats(id);
      if (!stats) return false;

      return stats.browserCount === 0;
    } catch {
      // 如果池未初始化，回退到原始检查
      return this.profileService.isAvailable(id);
    }
  }

  /**
   * 获取配置统计信息
   *
   * @returns 统计数据
   *
   * @example
   * const stats = await helpers.profile.getStats();
   * console.log(`共 ${stats.total} 个配置`);
   * console.log(`${stats.idle} 个空闲, ${stats.active} 个运行中`);
   */
  async getStats(): Promise<{
    total: number;
    idle: number;
    active: number;
    error: number;
  }> {
    return this.profileService.getStats();
  }

  /**
   * 列出分组
   *
   * @returns 分组树
   *
   * @example
   * const groups = await helpers.profile.listGroups();
   * for (const group of groups) {
   *   console.log(`${group.name}: ${group.profileCount} 个配置`);
   * }
   */
  async listGroups(): Promise<any[]> {
    return this.groupService.listTree();
  }

  /**
   * 启动浏览器（通过浏览器池）
   *
   * 此方法支持：
   * - 框架层默认按 profile 串行 live session，避免同一登录态被多个调用方同时写入
   * - 每个 Profile 固定只保留一个 live browser instance
   * - 支持浏览器复用（空闲浏览器可被重新锁定）
   * - 当前 Profile 已被占用时自动排队等待
   * - 插件停止时自动释放浏览器
   *
   * @param profileId Profile ID
   * @param options 启动选项
   * @returns 浏览器句柄（包含 browser 和 release 方法）
   *
   * @example
   * // 基本用法
   * const handle = await helpers.profile.launch('profile-id');
   * try {
   *   await handle.browser.goto('https://example.com');
   *   const title = await handle.browser.title();
   *   console.log(title);
   * } finally {
   *   await handle.release(); // 重要：使用完毕必须释放
   * }
   *
   * @example
   * // 并发使用多个浏览器（跨 profile）
   * const handles = await Promise.all([
   *   helpers.profile.launch('profile-1'),
   *   helpers.profile.launch('profile-2'),
   * ]);
   *
   * // 并行操作
   * await Promise.all(handles.map(async (h) => {
   *   await h.browser.goto('https://example.com');
   * }));
   *
   * // 全部释放
   * await Promise.all(handles.map(h => h.release()));
   */
  async launch(profileId: string, options?: LaunchOptions): Promise<BrowserHandle> {
    const poolManager = getBrowserPoolManager();
    const profileLease = await acquireProfileLiveSessionLease(profileId, {
      timeoutMs: options?.timeout || 30000,
      signal: options?.signal,
    });

    // 🔍 诊断日志：获取浏览器前的池状态
    const preStats = await poolManager.getStats();
    const queueStats = poolManager.getWaitQueueStats();
    console.log(
      `[Profile.launch] 🔍 获取浏览器前状态:`,
      `总数=${preStats.totalBrowsers}, 空闲=${preStats.idleBrowsers}, 锁定=${preStats.lockedBrowsers}, 等待队列=${queueStats.totalWaiting}`,
      `| plugin=${this.pluginId}, profile=${profileId}, timeout=${options?.timeout || 30000}ms`
    );

    const acquireStartTime = Date.now();

    // 获取浏览器句柄（source 使用 'internal' 表示插件内部调用）
    let handle: BrowserHandle;
    try {
      handle = await poolManager.acquire(
        profileId,
        {
          strategy: options?.strategy || 'any',
          browserId: options?.browserId,
          timeout: options?.timeout || 30000,
          signal: options?.signal,
          engine: options?.engine,
        },
        'internal',
        this.pluginId
      );
    } catch (error) {
      await profileLease?.release().catch(() => undefined);
      // 🔍 诊断日志：获取失败时的池状态
      const failStats = await poolManager.getStats();
      const failQueueStats = poolManager.getWaitQueueStats();
      const browsers = poolManager.listBrowsers();
      console.error(
        `[Profile.launch] ❌ 获取浏览器失败:`,
        `耗时=${Date.now() - acquireStartTime}ms`,
        `| 当前状态: 总数=${failStats.totalBrowsers}, 空闲=${failStats.idleBrowsers}, 锁定=${failStats.lockedBrowsers}, 等待=${failQueueStats.totalWaiting}`
      );
      console.error(
        `[Profile.launch] 📋 浏览器列表:`,
        browsers.map((b) => `${b.id.slice(0, 8)}(${b.status},profile=${b.sessionId})`).join(', ')
      );
      throw error;
    }

    const acquireDuration = Date.now() - acquireStartTime;
    console.log(
      `[Profile.launch] ✅ 获取浏览器成功: browser=${handle.browserId.slice(0, 8)}, 耗时=${acquireDuration}ms`
    );

    try {
      // 如果指定了初始 URL，导航到该 URL
      if (options?.url) {
        await handle.browser.goto(options.url);
      }

      // 根据 visible 参数控制浏览器显示/隐藏（默认隐藏）
      const visibilityState = {
        visibleLayout: await this.resolveVisibleLayout(options),
        rightDockSize: await this.resolveRightDockSize(options),
      };
      await this.applyHandleVisibility(handle, options?.visible === true, visibilityState);
      handle = this.attachVisibilityControlsToHandle(handle, visibilityState);
      handle = attachProfileLiveSessionLease(handle, profileLease);

      console.log(
        `[Profile] Browser launched for plugin ${this.pluginId}: profile=${profileId}, browser=${handle.browserId}`
      );

      return this.wrapBrowserHandle(handle);
    } catch (error) {
      await handle.release({ destroy: true }).catch(() => undefined);
      await profileLease?.release().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 获取 Profile 的浏览器使用情况
   *
   * @param profileId Profile ID
   * @returns 使用统计
   *
   * @example
   * const usage = await helpers.profile.getUsage('profile-id');
   * console.log(`当前使用: ${usage.browserCount}/${usage.quota}（固定单实例）`);
   * console.log(`空闲: ${usage.idleCount}, 锁定: ${usage.lockedCount}`);
   */
  async getUsage(profileId: string): Promise<{
    quota: number;
    browserCount: number;
    idleCount: number;
    lockedCount: number;
    waitingCount: number;
  } | null> {
    try {
      const poolManager = getBrowserPoolManager();
      return poolManager.getProfileStats(profileId);
    } catch {
      return null;
    }
  }

  /**
   * 启动浏览器并在弹窗中显示
   *
   * 这是用于需要用户交互场景的主要方法，例如：
   * - 手动登录
   * - 人机验证
   * - 查看浏览器状态
   *
   * 注意：
   * - Electron 路径会创建应用内弹窗，支持 title/width/height/onClose。
   * - Extension 路径会前置外部窗口；popupId 为 external:<browserId>，closePopup() 会隐藏窗口。
   * - `launchPopup()` 会持续持有该 profile 的 live-session lease，直到 handle 被 `release()`。
   *   如果弹窗保持打开，不要再从另一个动作里对同一 `profileId` 发起新的 `withLease()`，
   *   否则后者会排队等待，看起来像“界面卡住”。这类场景应复用当前 popup browser，
   *   或先关闭并释放 popup handle。
   *
   * @param profileId Profile ID
   * @param options 启动选项
   * @returns 弹窗浏览器句柄
   *
   * @example
   * // 基本用法
   * const handle = await helpers.profile.launchPopup('profile-id', {
   *   url: 'https://example.com/login',
   *   title: '登录 Example',
   * });
   *
   * // 等待用户操作后关闭弹窗
   * handle.closePopup();
   *
   * // 释放浏览器
   * await handle.release();
   *
   * @example
   * // 带关闭回调
   * const handle = await helpers.profile.launchPopup('profile-id', {
   *   url: 'https://example.com/login',
   *   onClose: () => {
   *     console.log('用户关闭了弹窗');
   *   },
   * });
   */
  async launchPopup(profileId: string, options?: LaunchPopupOptions): Promise<PopupBrowserHandle> {
    const poolManager = getBrowserPoolManager();
    const acquireOptions = {
      strategy: options?.strategy || 'any',
      browserId: options?.browserId,
      timeout: options?.timeout || 30000,
      signal: options?.signal,
      engine: options?.engine,
    };
    const tryAdoptExistingHandle = async () =>
      await poolManager.adoptSamePluginLockedBrowser(
        profileId,
        {
          ...acquireOptions,
          requireViewId: false,
        },
        'internal',
        this.pluginId
      );

    let reusedLease: Awaited<ReturnType<typeof acquireProfileLiveSessionLease>> | null = null;
    let reusedHandle: BrowserHandle | null = null;
    try {
      reusedLease = await acquireProfileLiveSessionLease(profileId, {
        timeoutMs: options?.timeout || 30000,
        signal: options?.signal,
      });
    } catch (error) {
      reusedHandle = await tryAdoptExistingHandle();
      if (!reusedHandle) {
        throw error;
      }
    }

    if (!reusedHandle) {
      try {
        reusedHandle = await poolManager.acquire(profileId, acquireOptions, 'internal', this.pluginId);
      } catch (error) {
        await reusedLease?.release().catch(() => undefined);
        reusedHandle = await tryAdoptExistingHandle();
        if (!reusedHandle) {
          throw error;
        }
      }
    }

    try {
      const initialUrl = options?.url || '';
      if (initialUrl) {
        await reusedHandle.browser.goto(initialUrl);
      }

      const viewId = reusedHandle.viewId;
      if (!viewId) {
        const showBrowser = reusedHandle.browser.show;
        if (typeof showBrowser === 'function') {
          let externalClosed = false;
          await showBrowser.call(reusedHandle.browser);
          return this.wrapPopupBrowserHandle(
            attachProfileLiveSessionLease(
              {
                ...reusedHandle,
                popupId: `external:${reusedHandle.browserId}`,
                closePopup: () => {
                  if (externalClosed) return;
                  externalClosed = true;

                  void (async () => {
                    if (typeof reusedHandle.browser.hide === 'function') {
                      await reusedHandle.browser.hide().catch(() => undefined);
                    }

                    if (options?.onClose) {
                      try {
                        options.onClose();
                      } catch (error) {
                        console.error(
                          '[Profile.launchPopup] Error in external popup onClose callback',
                          error
                        );
                      }
                    }
                  })();
                },
              },
              reusedLease
            )
          );
        }
        throw new Error(`Browser ${reusedHandle.browserId} has no associated viewId`);
      }

      let defaultTitle = 'Browser';
      if (initialUrl) {
        try {
          defaultTitle = new URL(initialUrl).hostname;
        } catch {
          // ignore URL parse failure
        }
      }

      const popupId = showBrowserViewInPopup(viewId, this.viewManager, this.windowManager, {
        title: options?.title || defaultTitle,
        width: options?.width || 1200,
        height: options?.height || 800,
        openDevTools: options?.openDevTools,
        onClose: options?.onClose,
      });

      if (!popupId) {
        throw new Error(`Failed to create popup for browser ${reusedHandle.browserId}`);
      }

      const popupIdValue = popupId;
      console.log(
        `[Profile] Browser launched in popup for plugin ${this.pluginId}: profile=${profileId}, browser=${reusedHandle.browserId}, popup=${popupIdValue}`
      );

      return this.wrapPopupBrowserHandle(
        attachProfileLiveSessionLease(
          {
            ...reusedHandle,
            popupId: popupIdValue,
            closePopup: () => {
              closeBrowserPopup(popupIdValue, this.windowManager);
            },
          },
          reusedLease
        )
      );
    } catch (error) {
      await reusedHandle?.release({ destroy: true }).catch(() => undefined);
      await reusedLease?.release().catch(() => undefined);
      throw error;
    }

    /*
    const profileLease = await acquireProfileLiveSessionLease(profileId, {
      timeoutMs: options?.timeout || 30000,
      signal: options?.signal,
    });

    // 获取浏览器句柄
    let handle: BrowserHandle;
    try {
      handle = await poolManager.acquire(
        profileId,
        {
          strategy: options?.strategy || 'any',
          browserId: options?.browserId,
          timeout: options?.timeout || 30000,
          signal: options?.signal,
          engine: options?.engine,
        },
        'internal',
        this.pluginId
      );
    } catch (error) {
      await profileLease?.release().catch(() => undefined);
      throw error;
    }

    try {
      // 如果指定了初始 URL，导航到该 URL
      if (options?.url) {
        await handle.browser.goto(options.url);
      }

      const viewId = handle.viewId;

      if (!viewId) {
        // 非 Electron 引擎没有 viewId，直接前置外部窗口即可（headed）
        if (typeof handle.browser.show === 'function') {
          let externalClosed = false;
          await handle.browser.show();
          return this.wrapPopupBrowserHandle(
            attachProfileLiveSessionLease(
              {
                ...handle,
                popupId: `external:${handle.browserId}`,
                closePopup: () => {
                  if (externalClosed) return;
                  externalClosed = true;

                  void (async () => {
                    if (typeof handle.browser.hide === 'function') {
                      await handle.browser.hide().catch(() => undefined);
                    }

                    if (options?.onClose) {
                      try {
                        options.onClose();
                      } catch (error) {
                        console.error(
                          '[Profile.launchPopup] Error in external popup onClose callback',
                          error
                        );
                      }
                    }
                  })();
                },
              },
              profileLease
            )
          );
        }
        throw new Error(`Browser ${handle.browserId} has no associated viewId`);
      }

      // 提取域名用于默认标题
      let defaultTitle = 'Browser';
      if (options?.url) {
        try {
          defaultTitle = new URL(options.url).hostname;
        } catch {
          // 忽略 URL 解析错误
        }
      }

      // 在弹窗中显示浏览器
      const popupId = showBrowserViewInPopup(viewId, this.viewManager, this.windowManager, {
        title: options?.title || defaultTitle,
        width: options?.width || 1200,
        height: options?.height || 800,
        openDevTools: options?.openDevTools,
        onClose: options?.onClose,
      });

      if (!popupId) {
        throw new Error(`Failed to create popup for browser ${handle.browserId}`);
      }

      console.log(
        `[Profile] Browser launched in popup for plugin ${this.pluginId}: profile=${profileId}, browser=${handle.browserId}, popup=${popupId}`
      );

      // 返回扩展的句柄
      return this.wrapPopupBrowserHandle(
        attachProfileLiveSessionLease(
          {
            ...handle,
            popupId,
            closePopup: () => {
              closeBrowserPopup(popupId, this.windowManager);
            },
          },
          profileLease
        )
      );
    } catch (error) {
      await handle.release({ destroy: true }).catch(() => undefined);
      await profileLease?.release().catch(() => undefined);
      throw error;
    }
    */
  }

  // =====================================================
  // 指纹管理 API（v2.2 新增）
  // =====================================================

  /**
   * 生成随机指纹配置
   *
   * 使用 fingerprint-generator 库动态生成真实的浏览器指纹。
   * 生成的指纹可以直接用于创建或更新 Profile。
   *
   * @param options 生成选项
   * @returns 生成的指纹配置
   *
   * @example
   * // 生成默认指纹（基于当前系统）
   * const fingerprint = await helpers.profile.generateFingerprint();
   *
   * @example
   * // 生成 Windows Chrome 指纹
   * const fingerprint = await helpers.profile.generateFingerprint({
   *   os: 'windows',
   *   browser: 'chrome',
   *   browserMinVersion: 120,
   * });
   *
   * @example
   * // 生成指定语言和屏幕尺寸的指纹
   * const fingerprint = await helpers.profile.generateFingerprint({
   *   locales: ['en-US', 'en'],
   *   screenWidth: { min: 1920, max: 2560 },
   *   screenHeight: { min: 1080, max: 1440 },
   * });
   *
   * @example
   * // 用生成的指纹创建 Profile
   * const fingerprint = await helpers.profile.generateFingerprint({ os: 'windows' });
   * const profile = await helpers.profile.create({
   *   name: '随机指纹配置',
   *   fingerprint,
   * });
   */
  async generateFingerprint(
    options?: GenerateFingerprintOptions
  ): Promise<Partial<FingerprintConfig>> {
    if (options?.device === 'mobile') {
      throw new Error(
        'profile.generateFingerprint currently supports desktop native fingerprint presets only.'
      );
    }

    const matchingPresets = FINGERPRINT_PRESET_OPTIONS.filter((preset) => {
      if (options?.os && preset.os.toLowerCase() !== options.os) {
        return false;
      }
      if (options?.browser && preset.browser.toLowerCase() !== options.browser) {
        return false;
      }

      const major = parseFingerprintVersionMajor(preset.config.identity.hardware.browserVersion);
      if (options?.browserMinVersion !== undefined && (major === null || major < options.browserMinVersion)) {
        return false;
      }
      if (options?.browserMaxVersion !== undefined && (major === null || major > options.browserMaxVersion)) {
        return false;
      }

      return true;
    });

    if (matchingPresets.length === 0) {
      throw new Error('No canonical fingerprint preset matches the requested constraints.');
    }

    const selectedPreset =
      matchingPresets[Math.floor(Math.random() * Math.max(1, matchingPresets.length))];
    let fingerprint = generateVariant(selectedPreset.config);

    const locales = normalizeLocaleList(options?.locales);
    const nextWidth = resolveDimensionWithinRange(
      fingerprint.identity.display.width,
      options?.screenWidth
    );
    const nextHeight = resolveDimensionWithinRange(
      fingerprint.identity.display.height,
      options?.screenHeight
    );

    fingerprint = mergeFingerprintConfig(fingerprint, {
      identity: {
        region:
          locales.length > 0
            ? {
                primaryLanguage: locales[0],
                languages: locales,
              }
            : undefined,
        display:
          nextWidth || nextHeight
            ? {
                width: nextWidth ?? fingerprint.identity.display.width,
                height: nextHeight ?? fingerprint.identity.display.height,
                availWidth: nextWidth ?? fingerprint.identity.display.availWidth,
                availHeight: nextHeight
                  ? Math.max(0, nextHeight - 40)
                  : fingerprint.identity.display.availHeight,
              }
            : undefined,
      },
    });

    console.log(
      `[Profile] Generated canonical fingerprint preset ${selectedPreset.id} for plugin ${this.pluginId}`
    );
    return fingerprint;
  }

  /**
   * 获取指纹预设列表
   *
   * 返回系统内置的指纹预设，可用于快速应用常见配置。
   *
   * @returns 预设列表
   *
   * @example
   * const presets = await helpers.profile.getPresets();
   * for (const preset of presets) {
   *   console.log(`${preset.name} - ${preset.description}`);
   * }
   *
   * @example
   * // 按 OS 过滤预设
   * const presets = await helpers.profile.getPresets();
   * const windowsPresets = presets.filter(p => p.os === 'windows');
   */
  async getPresets(): Promise<PresetInfo[]> {
    return FINGERPRINT_PRESET_OPTIONS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      os: preset.os.toLowerCase(),
      browser: preset.browser.toLowerCase(),
    }));
  }

  /**
   * 获取预设的完整指纹配置
   *
   * @param presetId 预设 ID
   * @returns 预设的完整指纹配置，不存在返回 null
   *
   * @example
   * const config = await helpers.profile.getPresetConfig('windows-chrome-120');
   * if (config) {
   *   await helpers.profile.update(profileId, { fingerprint: config });
   * }
   */
  async getPresetConfig(presetId: string): Promise<FingerprintConfig | null> {
    const preset = getPresetById(presetId);
    if (!preset) {
      return null;
    }
    return applyPresetConfig(presetId);
  }

  /**
   * 将预设应用到 Profile
   *
   * 直接将指定预设的指纹配置应用到 Profile。
   *
   * @param profileId Profile ID
   * @param presetId 预设 ID
   * @returns 更新后的 Profile
   * @throws 如果预设不存在
   *
   * @example
   * // 应用 Windows Chrome 120 预设
   * const profile = await helpers.profile.applyPreset('profile-id', 'windows-chrome-120');
   *
   * @example
   * // 应用 macOS M1 预设
   * const profile = await helpers.profile.applyPreset('profile-id', 'macos-chrome-m1');
   */
  async applyPreset(profileId: string, presetId: string): Promise<BrowserProfile> {
    const preset = getPresetById(presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${presetId}`);
    }

    const fingerprint = applyPresetConfig(presetId);

    console.log(
      `[Profile] Applying preset ${presetId} to profile ${profileId} for plugin ${this.pluginId}`
    );

    return this.update(profileId, { fingerprint });
  }

  /**
   * 随机化 Profile 的指纹
   *
   * 基于现有指纹配置生成轻微变体，主要调整：
   * - CPU 核心数（4/6/8/12/16）
   * - 设备内存（4/8/16/32 GB）
   * - 屏幕分辨率（多种常见分辨率）
   *
   * 适用于需要避免指纹完全相同的场景。
   *
   * @param profileId Profile ID
   * @returns 更新后的 Profile
   *
   * @example
   * // 随机化单个 Profile
   * const profile = await helpers.profile.randomizeFingerprint('profile-id');
   *
   * @example
   * // 批量随机化
   * const profiles = await helpers.profile.list();
   * for (const p of profiles) {
   *   await helpers.profile.randomizeFingerprint(p.id);
   * }
   */
  async randomizeFingerprint(profileId: string): Promise<BrowserProfile> {
    const profile = await this.profileService.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    // 基于现有指纹生成变体
    const baseFingerprint = profile.fingerprint || getDefaultFingerprint(profile.engine);
    const variant = generateVariant(baseFingerprint);

    console.log(
      `[Profile] Randomizing fingerprint for profile ${profileId} by plugin ${this.pluginId}`
    );

    return this.update(profileId, { fingerprint: variant });
  }

  /**
   * 生成全新的随机指纹并应用到 Profile
   *
   * 与 randomizeFingerprint 不同，此方法会完全重新生成指纹，
   * 包括 User-Agent、WebGL 等所有字段。
   *
   * @param profileId Profile ID
   * @param options 生成选项
   * @returns 更新后的 Profile
   *
   * @example
   * // 生成并应用全新指纹
   * const profile = await helpers.profile.regenerateFingerprint('profile-id');
   *
   * @example
   * // 生成指定 OS 的全新指纹
   * const profile = await helpers.profile.regenerateFingerprint('profile-id', {
   *   os: 'windows',
   *   browser: 'chrome',
   * });
   */
  async regenerateFingerprint(
    profileId: string,
    options?: GenerateFingerprintOptions
  ): Promise<BrowserProfile> {
    const fingerprint = await this.generateFingerprint(options);

    console.log(
      `[Profile] Regenerating fingerprint for profile ${profileId} by plugin ${this.pluginId}`
    );

    return this.update(profileId, { fingerprint });
  }

  /**
   * 验证指纹配置
   *
   * 检查指纹配置的一致性和合理性，包括：
   * - User-Agent 与 Platform 是否匹配
   * - WebGL Vendor 与 Renderer 是否匹配
   * - 硬件配置是否在合理范围内
   * - 屏幕分辨率是否合理
   *
   * @param config 指纹配置
   * @returns 验证结果
   *
   * @example
   * const result = await helpers.profile.validateFingerprint({
   *   userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...',
   *   platform: 'MacIntel', // 不匹配！
   * });
   * if (!result.valid) {
   *   console.log('指纹配置有问题:', result.warnings);
   * }
   *
   * @example
   * // 在更新前验证
   * const newFingerprint = { ... };
   * const validation = await helpers.profile.validateFingerprint(newFingerprint);
   * if (validation.valid) {
   *   await helpers.profile.update(profileId, { fingerprint: newFingerprint });
   * } else {
   *   helpers.ui.warn('指纹配置不一致: ' + validation.warnings.join(', '));
   * }
   */
  async validateFingerprint(
    config: Partial<FingerprintConfig>
  ): Promise<FingerprintValidationResult> {
    const inferredEngine =
      config.identity?.hardware?.browserFamily === 'firefox'
        ? 'ruyi'
        : config.identity?.hardware?.browserFamily === 'electron'
          ? 'electron'
          : 'extension';
    const result = validateFingerprintConfig(
      mergeFingerprintConfig(getDefaultFingerprint(inferredEngine), config),
      inferredEngine
    );

    return {
      valid: result.valid,
      warnings: result.warnings,
    };
  }

  /**
   * 获取默认指纹配置
   *
   * 返回系统默认的指纹配置（Windows 10 + Chrome 120）。
   *
   * @returns 默认指纹配置
   *
   * @example
   * const defaultFp = await helpers.profile.getDefaultFingerprint();
   * console.log('默认 UA:', defaultFp.userAgent);
   */
  async getDefaultFingerprint(engine: AutomationEngine = 'electron'): Promise<FingerprintConfig> {
    return getDefaultFingerprint(engine);
  }
}
