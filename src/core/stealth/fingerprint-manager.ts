/**
 * 指纹管理器
 *
 * 负责：
 * - 管理 cacheKey（identityKey/partition）→ fingerprint 的映射关系
 * - 使用 fingerprint-generator 动态生成指纹配置
 * - 保证同一 cacheKey 的指纹一致性
 *
 * 设计理念：
 * - 默认每个 partition（Session）对应一个独立的指纹
 * - 同一 cacheKey 创建的多个实例共享相同的指纹
 * - 未配置 identityKey 时，不同 partition 有不同的指纹，避免被关联
 *
 * v2 重构：
 * - 使用 fingerprint-generator 动态生成真实指纹
 * - 移除静态预设依赖，改用动态生成
 * - 使用 constants 模块的常量
 * - 添加工厂方法支持测试
 */

import { FingerprintGenerator, type BrowserFingerprintWithHeaders } from 'fingerprint-generator';
import type { HeaderGeneratorOptions, OperatingSystem, Device } from 'header-generator';
import type { StealthConfig, BrowserFingerprint } from './types';
import {
  DEFAULT_CHROME_PLUGINS,
  DEFAULT_HARDWARE,
  DEFAULT_WEBGL,
  DEFAULT_TIMEZONE,
  DEFAULT_BROWSER_CONFIG,
} from './constants';
import { getPresetById } from '../../constants/fingerprint-defaults';
import { buildStealthConfigFromFingerprint } from '../fingerprint/fingerprint-projections';
import type { FingerprintConfig } from '../../types/profile';
import { createLogger } from '../logger';

const logger = createLogger('FingerprintManager');
const CHROMIUM_UA_REGEX = /(Chrome|HeadlessChrome|Chromium|Edg|OPR)\//i;

function isChromiumUserAgent(ua: string): boolean {
  return CHROMIUM_UA_REGEX.test(String(ua || ''));
}

/**
 * 指纹生成选项
 */
export interface FingerprintOptions {
  /** 操作系统 */
  operatingSystems?: ('windows' | 'macos' | 'linux')[];
  /** 浏览器（仅支持 chromium 系浏览器选项） */
  browsers?: {
    name: 'chrome' | 'firefox' | 'safari' | 'edge';
    minVersion?: number;
    maxVersion?: number;
  }[];
  /** 设备类型 */
  devices?: ('desktop' | 'mobile')[];
  /** 语言列表 */
  locales?: string[];
  /** 屏幕宽度范围 */
  screenWidth?: { min?: number; max?: number };
  /** 屏幕高度范围 */
  screenHeight?: { min?: number; max?: number };
}

/**
 * 指纹管理器类
 */
export class FingerprintManager {
  /**
   * 指纹缓存（cacheKey → fingerprint）
   *
   * cacheKey = identityKey ?? partition
   */
  private cache: Map<string, BrowserFingerprint> = new Map();

  /**
   * 指纹生成器实例
   */
  private generator: FingerprintGenerator;

  constructor() {
    this.generator = new FingerprintGenerator();
  }

  private areStringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  private normalizeLanguages(languages?: string[]): string[] {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(languages) ? languages : []) {
      const value = String(raw || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      cleaned.push(value);
    }
    return cleaned;
  }

  private resolveCacheKey(partition: string, config?: StealthConfig): string {
    const identityKey = typeof config?.identityKey === 'string' ? config.identityKey.trim() : '';
    return identityKey ? identityKey : partition;
  }

  private normalizeBrowserOptions(
    browsers?: FingerprintOptions['browsers']
  ): FingerprintOptions['browsers'] | undefined {
    if (!Array.isArray(browsers) || browsers.length === 0) return undefined;
    const chromium = browsers.filter(
      (browser) => browser.name === 'chrome' || browser.name === 'edge'
    );
    return chromium.length > 0 ? chromium : undefined;
  }

  private buildStealthConfigFromPreset(preset: FingerprintConfig): StealthConfig {
    return buildStealthConfigFromFingerprint(preset);
  }

  private resolveStealthConfig(config?: StealthConfig): StealthConfig | undefined {
    if (!config?.fingerprint) return config;

    const preset = getPresetById(config.fingerprint);
    if (!preset) return config;

    const base = this.buildStealthConfigFromPreset(preset.config);

    return {
      enabled: config.enabled,
      fingerprint: config.fingerprint,
      identityKey: config.identityKey,
      userAgent: config.userAgent || base.userAgent,
      platform: config.platform || base.platform,
      platformVersion: config.platformVersion || base.platformVersion,
      languages:
        config.languages && config.languages.length > 0
          ? this.normalizeLanguages(config.languages)
          : base.languages,
      timezone: config.timezone || base.timezone,
      hardwareConcurrency:
        typeof config.hardwareConcurrency === 'number'
          ? config.hardwareConcurrency
          : base.hardwareConcurrency,
      deviceMemory:
        typeof config.deviceMemory === 'number' ? config.deviceMemory : base.deviceMemory,
      screen: config.screen ? { ...base.screen, ...config.screen } : base.screen,
      webgl: config.webgl ? { ...base.webgl, ...config.webgl } : base.webgl,
      canvasNoise: typeof config.canvasNoise === 'boolean' ? config.canvasNoise : base.canvasNoise,
      canvasNoiseLevel:
        typeof config.canvasNoiseLevel === 'number'
          ? config.canvasNoiseLevel
          : base.canvasNoiseLevel,
      audioNoise: typeof config.audioNoise === 'boolean' ? config.audioNoise : base.audioNoise,
      audioNoiseLevel:
        typeof config.audioNoiseLevel === 'number' ? config.audioNoiseLevel : base.audioNoiseLevel,
      webglNoise: typeof config.webglNoise === 'boolean' ? config.webglNoise : base.webglNoise,
      fonts: Array.isArray(config.fonts) ? config.fonts : base.fonts,
      touchSupport:
        typeof config.touchSupport === 'boolean' ? config.touchSupport : base.touchSupport,
      maxTouchPoints:
        typeof config.maxTouchPoints === 'number' ? config.maxTouchPoints : base.maxTouchPoints,
    };
  }

  private fingerprintSatisfiesConfig(
    fingerprint: BrowserFingerprint,
    config: StealthConfig
  ): boolean {
    if (config.userAgent && fingerprint.userAgent !== config.userAgent) return false;
    if (config.platform && fingerprint.platform !== config.platform) return false;
    if (typeof config.platformVersion === 'string' && config.platformVersion.trim()) {
      if (fingerprint.platformVersion !== config.platformVersion.trim()) return false;
    }

    if (config.languages && config.languages.length > 0) {
      if (!this.areStringArraysEqual(fingerprint.languages, config.languages)) return false;
    }

    if (config.timezone && fingerprint.timezone !== config.timezone) return false;

    if (
      typeof config.hardwareConcurrency === 'number' &&
      fingerprint.hardwareConcurrency !== config.hardwareConcurrency
    ) {
      return false;
    }

    if (
      typeof config.deviceMemory === 'number' &&
      fingerprint.deviceMemory !== config.deviceMemory
    ) {
      return false;
    }

    if (config.screen) {
      const s = config.screen;
      const fp = fingerprint.screenResolution;
      if (typeof s.width === 'number' && fp.width !== s.width) return false;
      if (typeof s.height === 'number' && fp.height !== s.height) return false;
      if (typeof s.availWidth === 'number' && fp.availWidth !== s.availWidth) return false;
      if (typeof s.availHeight === 'number' && fp.availHeight !== s.availHeight) return false;
      if (typeof s.colorDepth === 'number' && fingerprint.colorDepth !== s.colorDepth) return false;
      if (typeof s.pixelRatio === 'number' && fingerprint.pixelRatio !== s.pixelRatio) return false;
    }

    if (config.webgl) {
      if (fingerprint.webgl.vendor !== config.webgl.vendor) return false;
      if (fingerprint.webgl.renderer !== config.webgl.renderer) return false;
      if (config.webgl.version && fingerprint.webgl.version !== config.webgl.version) return false;
    }

    if (Array.isArray(config.fonts)) {
      if (!this.areStringArraysEqual(fingerprint.fonts, config.fonts)) return false;
    }

    if (
      typeof config.touchSupport === 'boolean' &&
      fingerprint.touchSupport !== config.touchSupport
    ) {
      return false;
    }

    if (
      typeof config.maxTouchPoints === 'number' &&
      fingerprint.maxTouchPoints !== config.maxTouchPoints
    ) {
      return false;
    }

    if (
      typeof config.canvasNoise === 'boolean' &&
      fingerprint.canvas?.noise !== config.canvasNoise
    ) {
      return false;
    }

    if (
      typeof config.canvasNoiseLevel === 'number' &&
      fingerprint.canvas?.noiseLevel !== config.canvasNoiseLevel
    ) {
      return false;
    }

    if (typeof config.audioNoise === 'boolean' && fingerprint.audio?.noise !== config.audioNoise) {
      return false;
    }

    if (
      typeof config.audioNoiseLevel === 'number' &&
      fingerprint.audio?.noiseLevel !== config.audioNoiseLevel
    ) {
      return false;
    }

    if (typeof config.webglNoise === 'boolean' && fingerprint.webglNoise !== config.webglNoise) {
      return false;
    }

    return true;
  }

  /**
   * 获取或生成指纹配置
   *
   * 工作流程：
   * 1. 检查缓存，如果存在则返回（保证一致性）
   * 2. 根据配置生成新指纹
   * 3. 缓存并返回
   *
   * @param partition - Session partition 标识
   * @param config - Stealth 配置（可选）
   * @returns 指纹配置
   */
  getFingerprint(partition: string, config?: StealthConfig): BrowserFingerprint {
    const resolvedConfig = this.resolveStealthConfig(config);
    const cacheKey = this.resolveCacheKey(partition, resolvedConfig);
    // 1. 检查缓存（保证同一 cacheKey 的一致性）
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (!resolvedConfig || this.fingerprintSatisfiesConfig(cached, resolvedConfig)) {
        logger.debug('Reusing fingerprint for cache key: ' + cacheKey);
        return cached;
      }

      logger.debug('Cached fingerprint does not satisfy config, regenerating: ' + cacheKey);
    }

    // 2. 生成新指纹
    let fingerprint: BrowserFingerprint;

    if (resolvedConfig?.userAgent || resolvedConfig?.platform || resolvedConfig?.webgl) {
      // 2.1 使用自定义配置
      fingerprint = this.buildCustom(resolvedConfig);
      logger.debug('Built custom fingerprint for cache key: ' + cacheKey);
    } else {
      // 2.2 动态生成（使用 fingerprint-generator）
      fingerprint = this.generateDynamic(resolvedConfig);
      logger.debug('Generated dynamic fingerprint for cache key: ' + cacheKey);
    }

    // 3. 缓存并返回
    this.cache.set(cacheKey, fingerprint);
    return fingerprint;
  }

  /**
   * 使用 fingerprint-generator 动态生成指纹
   *
   * @param config - Stealth 配置（可选）
   * @returns 指纹配置
   */
  private generateDynamic(config?: StealthConfig): BrowserFingerprint {
    // 构建生成器选项
    const options: Partial<HeaderGeneratorOptions> & {
      screen?: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number };
    } = {
      browsers: [{ name: 'chrome', minVersion: DEFAULT_BROWSER_CONFIG.minChromeVersion }],
      devices: ['desktop'] as Device[],
    };

    // 根据配置或当前系统设置操作系统
    const inferredOs = this.inferOperatingSystem(config);
    const platform = process.platform;
    if (inferredOs) {
      options.operatingSystems = [inferredOs] as OperatingSystem[];
    } else if (platform === 'win32') {
      options.operatingSystems = ['windows'] as OperatingSystem[];
    } else if (platform === 'darwin') {
      options.operatingSystems = ['macos'] as OperatingSystem[];
    } else {
      options.operatingSystems = ['linux'] as OperatingSystem[];
    }

    // 设置语言
    if (config?.languages && config.languages.length > 0) {
      options.locales = config.languages;
    }

    // 生成指纹
    const generated = this.generator.getFingerprint(options);

    // 转换为 BrowserFingerprint 格式
    return this.convertToInternal(generated, config);
  }

  /**
   * 将 fingerprint-generator 的指纹转换为内部格式
   *
   * @param generated - fingerprint-generator 生成的指纹
   * @param config - 额外的配置
   * @returns 内部指纹格式
   *
   * v2.1 重构：完整透传所有字段
   */
  private convertToInternal(
    generated: BrowserFingerprintWithHeaders,
    config?: StealthConfig
  ): BrowserFingerprint {
    const fp = generated.fingerprint;
    const navigator = fp.navigator;
    const screen = fp.screen;
    const videoCard = fp.videoCard;

    const screenWidth =
      typeof screen.width === 'number' && screen.width > 0
        ? screen.width
        : DEFAULT_HARDWARE.screenResolution.width;
    const screenHeight =
      typeof screen.height === 'number' && screen.height > 0
        ? screen.height
        : DEFAULT_HARDWARE.screenResolution.height;
    const screenAvailWidth =
      typeof screen.availWidth === 'number' && screen.availWidth > 0
        ? screen.availWidth
        : undefined;
    const screenAvailHeight =
      typeof screen.availHeight === 'number' && screen.availHeight > 0
        ? screen.availHeight
        : undefined;
    const screenPixelRatio =
      typeof screen.devicePixelRatio === 'number' &&
      Number.isFinite(screen.devicePixelRatio) &&
      screen.devicePixelRatio > 0
        ? screen.devicePixelRatio
        : undefined;
    const navigatorLanguages = Array.isArray(navigator.languages) ? navigator.languages : [];
    const fallbackLanguages = [...DEFAULT_BROWSER_CONFIG.languages];
    const resolvedLanguages = this.normalizeLanguages(
      config?.languages && config.languages.length > 0
        ? config.languages
        : navigatorLanguages.length > 0
          ? navigatorLanguages
          : navigator.language
            ? [navigator.language, ...navigator.language.split('-').slice(0, 1)]
            : fallbackLanguages
    );
    const resolvedAvailWidth =
      typeof config?.screen?.availWidth === 'number'
        ? config.screen.availWidth
        : (screenAvailWidth ?? screenWidth);
    const resolvedAvailHeight =
      typeof config?.screen?.availHeight === 'number'
        ? config.screen.availHeight
        : (screenAvailHeight ?? Math.max(0, screenHeight - 40));
    const resolvedPixelRatio =
      typeof config?.screen?.pixelRatio === 'number'
        ? config.screen.pixelRatio
        : (screenPixelRatio ?? 1);
    const resolvedMaxTouchPoints =
      typeof config?.maxTouchPoints === 'number'
        ? config.maxTouchPoints
        : typeof navigator.maxTouchPoints === 'number'
          ? navigator.maxTouchPoints
          : 0;
    const resolvedTouchSupport =
      typeof config?.touchSupport === 'boolean' ? config.touchSupport : resolvedMaxTouchPoints > 0;
    const resolvedColorDepth =
      typeof config?.screen?.colorDepth === 'number'
        ? config.screen.colorDepth
        : typeof screen.colorDepth === 'number'
          ? screen.colorDepth
          : DEFAULT_HARDWARE.colorDepth;

    return {
      // 基础信息
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      platformVersion: config?.platformVersion,
      languages: resolvedLanguages.length > 0 ? resolvedLanguages : fallbackLanguages,
      timezone: config?.timezone || DEFAULT_TIMEZONE,

      // 硬件信息
      hardwareConcurrency:
        config?.hardwareConcurrency ??
        navigator.hardwareConcurrency ??
        DEFAULT_HARDWARE.hardwareConcurrency,
      deviceMemory: config?.deviceMemory ?? navigator.deviceMemory ?? DEFAULT_HARDWARE.deviceMemory,
      screenResolution: {
        width: typeof config?.screen?.width === 'number' ? config.screen.width : screenWidth,
        height: typeof config?.screen?.height === 'number' ? config.screen.height : screenHeight,
        availWidth: resolvedAvailWidth,
        availHeight: resolvedAvailHeight,
      },
      colorDepth: resolvedColorDepth,
      pixelRatio: resolvedPixelRatio,

      // WebGL
      webgl: {
        vendor: config?.webgl?.vendor || videoCard.vendor || DEFAULT_WEBGL.vendor,
        renderer: config?.webgl?.renderer || videoCard.renderer || DEFAULT_WEBGL.renderer,
        version: config?.webgl?.version || DEFAULT_WEBGL.version,
      },

      // 插件
      plugins: DEFAULT_CHROME_PLUGINS.map((p) => ({
        ...p,
        mimeTypes: [...p.mimeTypes],
      })),

      // 字体
      fonts: config?.fonts,

      // 触摸支持
      touchSupport: resolvedTouchSupport,
      maxTouchPoints: resolvedMaxTouchPoints,

      // Canvas 噪声
      canvas: {
        noise: config?.canvasNoise ?? true,
        noiseLevel: config?.canvasNoiseLevel ?? 0.1,
      },

      // Audio 噪声
      audio: {
        noise: config?.audioNoise ?? false,
        noiseLevel: config?.audioNoiseLevel ?? 0.01,
      },

      // WebGL 噪声
      webglNoise: config?.webglNoise ?? false,
    };
  }

  /**
   * 构建自定义配置
   *
   * 基于用户提供的部分配置，补全其他字段
   * 确保字段一致性（如 User-Agent 与 Platform 匹配）
   *
   * @param config - 部分配置
   * @returns 完整的指纹配置
   *
   * v2.1 重构：完整透传所有字段
   */
  private buildCustom(config: StealthConfig): BrowserFingerprint {
    // 如果提供了 User-Agent，推断 Platform
    const platform = config.platform || this.inferPlatformFromUA(config.userAgent);

    // 生成一个基础指纹作为模板
    const base = this.generateDynamic(config);
    const baseScreen = base.screenResolution;
    const overrideScreen = config.screen;

    // 合并用户配置
    const customLanguages =
      config.languages && config.languages.length > 0
        ? this.normalizeLanguages(config.languages)
        : [...base.languages];
    const resolvedCustomLanguages =
      customLanguages.length > 0 ? customLanguages : [...DEFAULT_BROWSER_CONFIG.languages];
    return {
      ...base,
      // 基础信息
      userAgent: config.userAgent || base.userAgent,
      platform: platform,
      platformVersion: config.platformVersion ?? base.platformVersion,
      languages: resolvedCustomLanguages,
      timezone: config.timezone || base.timezone,

      // 硬件信息
      hardwareConcurrency: config.hardwareConcurrency ?? base.hardwareConcurrency,
      deviceMemory: config.deviceMemory ?? base.deviceMemory,
      screenResolution: {
        width: overrideScreen?.width ?? baseScreen.width,
        height: overrideScreen?.height ?? baseScreen.height,
        availWidth:
          overrideScreen?.availWidth ??
          overrideScreen?.width ??
          baseScreen.availWidth ??
          baseScreen.width,
        availHeight:
          overrideScreen?.availHeight ??
          overrideScreen?.height ??
          baseScreen.availHeight ??
          Math.max(0, baseScreen.height - 40),
      },
      colorDepth: overrideScreen?.colorDepth ?? base.colorDepth,
      pixelRatio: overrideScreen?.pixelRatio ?? base.pixelRatio,

      // WebGL
      webgl: config.webgl
        ? {
            vendor: config.webgl.vendor,
            renderer: config.webgl.renderer,
            version: config.webgl.version || base.webgl.version,
          }
        : base.webgl,

      // 字体
      fonts: Array.isArray(config.fonts) ? [...config.fonts] : base.fonts,

      // 触摸支持
      touchSupport: config.touchSupport ?? base.touchSupport,
      maxTouchPoints: config.maxTouchPoints ?? base.maxTouchPoints,

      // Canvas 噪声
      canvas: {
        noise: config.canvasNoise ?? true,
        noiseLevel: config.canvasNoiseLevel ?? 0.1,
      },

      // Audio 噪声
      audio: {
        noise: config.audioNoise ?? false,
        noiseLevel: config.audioNoiseLevel ?? 0.01,
      },

      // WebGL 噪声
      webglNoise: config.webglNoise ?? false,
    };
  }

  /**
   * 从 User-Agent 推断 Platform
   *
   * 根据 UA 字符串中的关键字推断平台
   *
   * @param ua - User-Agent 字符串（可选）
   * @returns Platform 字符串
   */
  private inferPlatformFromUA(ua?: string): string {
    if (!ua) {
      // 未提供 UA，基于当前系统推断
      const platform = process.platform;
      if (platform === 'darwin') return 'MacIntel';
      if (platform === 'linux') return 'Linux x86_64';
      return 'Win32';
    }

    // 根据 UA 内容推断
    if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
      return 'MacIntel';
    } else if (ua.includes('Linux') || ua.includes('X11')) {
      return 'Linux x86_64';
    } else if (ua.includes('Windows') || ua.includes('Win')) {
      return 'Win32';
    }

    // 默认返回 Win32
    return 'Win32';
  }

  private inferOperatingSystem(config?: StealthConfig): OperatingSystem | undefined {
    if (config?.platform) {
      const platform = config.platform.toLowerCase();
      if (platform.includes('win')) return 'windows';
      if (platform.includes('mac')) return 'macos';
      if (platform.includes('linux')) return 'linux';
    }

    if (config?.userAgent) {
      const ua = config.userAgent;
      if (ua.includes('Windows')) return 'windows';
      if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macos';
      if (ua.includes('Linux') || ua.includes('X11')) return 'linux';
    }

    return undefined;
  }

  /**
   * 生成具有特定选项的指纹
   *
   * @param options - 指纹生成选项
   * @returns 指纹配置
   */
  generateWithOptions(options: FingerprintOptions): BrowserFingerprint {
    const normalizedBrowsers = this.normalizeBrowserOptions(options.browsers);
    const genOptions: Partial<HeaderGeneratorOptions> & {
      screen?: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number };
    } = {
      browsers: normalizedBrowsers || [
        { name: 'chrome', minVersion: DEFAULT_BROWSER_CONFIG.minChromeVersion },
      ],
      devices: (options.devices || ['desktop']) as Device[],
      operatingSystems: options.operatingSystems as OperatingSystem[] | undefined,
      locales: options.locales,
    };

    // 设置屏幕尺寸范围
    if (options.screenWidth || options.screenHeight) {
      genOptions.screen = {
        minWidth: options.screenWidth?.min || 1024,
        maxWidth: options.screenWidth?.max || 2560,
        minHeight: options.screenHeight?.min || 768,
        maxHeight: options.screenHeight?.max || 1440,
      };
    }

    const generated = this.generator.getFingerprint(genOptions);
    return this.convertToInternal(generated);
  }

  /**
   * 清除指定 cache key 的缓存
   *
   * cache key 可以是 partition 或 identityKey
   *
   * @param cacheKey - Session partition 或 identityKey
   */
  clearCache(cacheKey: string): void {
    this.cache.delete(cacheKey);
    logger.debug('Cleared fingerprint cache for key: ' + cacheKey);
  }

  /**
   * 清除所有缓存
   *
   * 用于全局重置
   */
  clearAllCache(): void {
    const count = this.cache.size;
    this.cache.clear();
    logger.debug('Cleared all fingerprint cache (' + count + ' entries)');
  }

  /**
   * 获取缓存统计信息
   *
   * @returns 缓存的 key 数量
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * 获取所有缓存的 key 列表
   *
   * @returns cache key 数组
   */
  getCacheKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取所有缓存的 partition 列表
   *
   * @deprecated Use getCacheKeys instead.
   */
  getCachedPartitions(): string[] {
    return this.getCacheKeys();
  }

  /**
   * 验证指纹配置的一致性
   *
   * 检查各字段是否匹配（如 UA 与 Platform 一致）
   *
   * @param fingerprint - 指纹配置
   * @returns 验证结果
   */
  validateFingerprint(fingerprint: BrowserFingerprint): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // 1. 检查 User-Agent 与 Platform 匹配
    const ua = fingerprint.userAgent;
    const platform = fingerprint.platform;

    if (ua.includes('Win') && platform !== 'Win32') {
      errors.push(`User-Agent indicates Windows but platform is "${platform}" (expected "Win32")`);
    }

    if (ua.includes('Mac') && platform !== 'MacIntel') {
      errors.push(`User-Agent indicates macOS but platform is "${platform}" (expected "MacIntel")`);
    }

    if (ua.includes('Linux') && !platform.includes('Linux')) {
      errors.push(
        `User-Agent indicates Linux but platform is "${platform}" (expected "Linux x86_64")`
      );
    }

    if (ua && !isChromiumUserAgent(ua)) {
      errors.push('Non-Chromium userAgent is not supported by this stealth profile');
    }

    // 2. 检查 WebGL Vendor 与 Renderer 匹配
    const vendor = fingerprint.webgl.vendor.toLowerCase();
    const renderer = fingerprint.webgl.renderer.toLowerCase();

    if (vendor.includes('nvidia') && !renderer.includes('nvidia')) {
      errors.push(`WebGL vendor is NVIDIA but renderer doesn't contain NVIDIA`);
    }

    if (vendor.includes('intel') && !renderer.includes('intel')) {
      errors.push(`WebGL vendor is Intel but renderer doesn't contain Intel`);
    }

    if (
      vendor.includes('apple') &&
      !renderer.includes('apple') &&
      !renderer.includes('m1') &&
      !renderer.includes('m2')
    ) {
      errors.push(`WebGL vendor is Apple but renderer doesn't contain Apple/M1/M2`);
    }

    // 3. 检查硬件配置合理性
    if (fingerprint.hardwareConcurrency < 1 || fingerprint.hardwareConcurrency > 128) {
      errors.push(
        `hardwareConcurrency out of range: ${fingerprint.hardwareConcurrency} (expected 1-128)`
      );
    }

    if (fingerprint.deviceMemory < 0.25 || fingerprint.deviceMemory > 64) {
      errors.push(`deviceMemory out of range: ${fingerprint.deviceMemory} GB (expected 0.25-64)`);
    }

    // 4. 检查屏幕分辨率合理性
    if (fingerprint.screenResolution.width < 640 || fingerprint.screenResolution.width > 7680) {
      errors.push(
        `screenResolution.width out of range: ${fingerprint.screenResolution.width} (expected 640-7680)`
      );
    }

    if (fingerprint.screenResolution.height < 480 || fingerprint.screenResolution.height > 4320) {
      errors.push(
        `screenResolution.height out of range: ${fingerprint.screenResolution.height} (expected 480-4320)`
      );
    }

    // 5. 检查颜色深度
    if (![8, 16, 24, 30, 32].includes(fingerprint.colorDepth)) {
      errors.push(`colorDepth invalid: ${fingerprint.colorDepth} (expected 8, 16, 24, 30, or 32)`);
    }

    if (
      typeof fingerprint.screenResolution.availWidth === 'number' &&
      fingerprint.screenResolution.availWidth > fingerprint.screenResolution.width
    ) {
      errors.push(
        `screenResolution.availWidth exceeds width: ${fingerprint.screenResolution.availWidth} > ${fingerprint.screenResolution.width}`
      );
    }

    if (
      typeof fingerprint.screenResolution.availHeight === 'number' &&
      fingerprint.screenResolution.availHeight > fingerprint.screenResolution.height
    ) {
      errors.push(
        `screenResolution.availHeight exceeds height: ${fingerprint.screenResolution.availHeight} > ${fingerprint.screenResolution.height}`
      );
    }

    if (
      typeof fingerprint.pixelRatio === 'number' &&
      (!Number.isFinite(fingerprint.pixelRatio) ||
        fingerprint.pixelRatio <= 0 ||
        fingerprint.pixelRatio > 8)
    ) {
      errors.push(`pixelRatio invalid: ${fingerprint.pixelRatio} (expected > 0 and <= 8)`);
    }

    if (Array.isArray(fingerprint.languages) && fingerprint.languages.length === 0) {
      errors.push('languages is empty');
    }

    if (typeof fingerprint.platformVersion === 'string' && fingerprint.platformVersion.trim()) {
      const normalized = fingerprint.platformVersion.trim();
      if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
        errors.push(`platformVersion invalid: ${fingerprint.platformVersion}`);
      }
    }

    if (typeof fingerprint.maxTouchPoints === 'number') {
      if (!Number.isFinite(fingerprint.maxTouchPoints) || fingerprint.maxTouchPoints < 0) {
        errors.push(`maxTouchPoints invalid: ${fingerprint.maxTouchPoints}`);
      }
      if (Math.floor(fingerprint.maxTouchPoints) !== fingerprint.maxTouchPoints) {
        errors.push(`maxTouchPoints must be an integer: ${fingerprint.maxTouchPoints}`);
      }
    }

    if (typeof fingerprint.touchSupport === 'boolean') {
      const touchPoints =
        typeof fingerprint.maxTouchPoints === 'number' ? fingerprint.maxTouchPoints : 0;
      if (fingerprint.touchSupport && touchPoints <= 0) {
        errors.push(`touchSupport enabled but maxTouchPoints is ${touchPoints}`);
      }
      if (!fingerprint.touchSupport && touchPoints > 0) {
        errors.push(`touchSupport disabled but maxTouchPoints is ${touchPoints}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// ========== 工厂函数和单例 ==========

/**
 * 创建新的 FingerprintManager 实例
 *
 * 主要用于测试场景，允许创建隔离的实例
 *
 * @returns 新的 FingerprintManager 实例
 */
export function createFingerprintManager(): FingerprintManager {
  return new FingerprintManager();
}

export const fingerprintManager = createFingerprintManager();
