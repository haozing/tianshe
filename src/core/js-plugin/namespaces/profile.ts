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
import type {
  IProfileService,
  IProfileGroupService,
} from '../../../types/service-interfaces';
import type {
  IWebContentsViewManager,
  IWindowManager,
} from '../../browser-pool/ports';
import type { InternalDevToolsOpener } from './window';
import type { BrowserRuntimeDescriptor } from '../../../types/browser-interface';
import type { AutomationEngine, BrowserHandle, ReleaseOptions } from '../../browser-pool/types';
import {
  getStaticEngineRuntimeDescriptor,
} from '../../browser-pool/engine-capability-registry';
import { ProfileCrudNamespace } from './profile-crud-namespace';
import {
  ProfileFingerprintNamespace,
  type FingerprintValidationResult,
  type GenerateFingerprintOptions,
  type PresetInfo,
} from './profile-fingerprint-namespace';
import { ProfileLaunchNamespace } from './profile-launch-namespace';

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

export class ProfileNamespace {
  private readonly crudNamespace: ProfileCrudNamespace;
  private readonly fingerprintNamespace: ProfileFingerprintNamespace;
  private readonly launchNamespace: ProfileLaunchNamespace;

  constructor(
    private pluginId: string,
    private profileService: IProfileService,
    private groupService: IProfileGroupService,
    private viewManager: IWebContentsViewManager,
    private windowManager: IWindowManager,
    private getPluginConfig?: (key: string) => Promise<any>,
    private devToolsOpener?: InternalDevToolsOpener
  ) {
    this.crudNamespace = new ProfileCrudNamespace({
      pluginId,
      profileService,
      groupService,
    });
    this.launchNamespace = new ProfileLaunchNamespace({
      pluginId,
      profileService,
      viewManager,
      windowManager,
      getPluginConfig,
      devToolsOpener,
    });
    this.fingerprintNamespace = new ProfileFingerprintNamespace({
      pluginId,
      getProfile: (profileId) => this.profileService.get(profileId),
      updateProfile: (profileId, params) => this.update(profileId, params),
    });
  }

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
    return this.launchNamespace.withLease(profileId, options, handler);
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
    return this.crudNamespace.list(params);
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
    return this.crudNamespace.get(id);
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
    return this.crudNamespace.create(params);
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
    return this.crudNamespace.update(id, params);
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
    return this.crudNamespace.delete(id);
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
    return this.crudNamespace.isAvailable(id);
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
    return this.crudNamespace.getStats();
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
    return this.crudNamespace.listGroups();
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
    return this.launchNamespace.launch(profileId, options);
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
    return this.launchNamespace.getUsage(profileId);
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
    return this.launchNamespace.launchPopup(profileId, options);
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
    return this.fingerprintNamespace.generateFingerprint(options);
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
    return this.fingerprintNamespace.getPresets();
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
    return this.fingerprintNamespace.getPresetConfig(presetId);
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
    return this.fingerprintNamespace.applyPreset(profileId, presetId);
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
    return this.fingerprintNamespace.randomizeFingerprint(profileId);
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
    return this.fingerprintNamespace.regenerateFingerprint(profileId, options);
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
    return this.fingerprintNamespace.validateFingerprint(config);
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
    return this.fingerprintNamespace.getDefaultFingerprint(engine);
  }
}
