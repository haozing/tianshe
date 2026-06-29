/**
 * Stealth Engine - 统一的浏览器反检测引擎
 *
 * 整合 CDP 命令和 JS 脚本注入，提供统一的 API
 *
 * 设计理念：
 * - CDP 优先：对于 CDP 能实现的功能，优先使用 CDP（更底层、更精确）
 * - JS 补充：对于 CDP 无法实现的功能，使用 JS 脚本补充
 * - 统一入口：用户无需关心底层实现，只需调用统一 API
 *
 * 使用示例：
 * ```typescript
 * // 方式 1：使用 CDP（推荐）
 * const executor = { send: (m, p) => webContents.debugger.sendCommand(m, p) };
 * await applyFullStealth(executor, fingerprint);
 *
 * // 方式 2：不使用 debugger（生成脚本手动注入）
 * const script = generateFullStealthScript(fingerprint);
 * await webContents.executeJavaScript(script);
 * ```
 */

import type { BrowserFingerprint } from './types';
import { buildUserAgentMetadata } from './client-hints';
import { buildAcceptLanguageHeaderValue } from './accept-language';
import {
  TIMEZONE_LOCATIONS,
  DEFAULT_TIMEZONE,
  DEFAULT_GEOLOCATION_ACCURACY,
  WEBGL_PARAMS,
} from './constants';
import {
  generateWebGLScript,
  generateWebdriverHideScript,
  generateAutomationCleanupScript,
  generateTimezoneScript,
  generateBatteryScript,
  generateAudioContextScript,
  generateWebRTCProtectionScript,
  generateCanvasNoiseScript,
  generateClientHintsScript,
  generateChromeObjectScript,
  generateFunctionPrototypeScript,
  generateConsoleStealthScript,
  generateWorkerStealthScript,
  generateTouchSupportScript,
  generateFontsScript,
  hashString,
  combineScripts,
  wrapScript,
} from './shared-scripts';
import {
  generateConnectionScript,
  generateHardwareScript,
  generateLanguagesScript,
  generateMimeTypesScript,
  generateNavigatorPropsScript,
  generatePermissionsScript,
  generatePluginsScript,
} from './stealth-engine-navigator-scripts';
import {
  generateDiagnosticsScript,
  generateScreenScript,
  generateSpeechSynthesisScript,
} from './stealth-engine-display-scripts';
import { createLogger } from '../logger';

const logger = createLogger('StealthEngine');

// ========== 类型定义 ==========

/**
 * CDP 执行器接口
 */
export interface CDPExecutor {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * CDP 命令
 */
export interface CDPCommand {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Stealth 配置选项
 *
 * v2.1 重构：添加 audioNoise 和 webglNoise 选项
 */
export interface StealthOptions {
  /** 是否启用 Locale 伪装（默认 true） */
  locale?: boolean;
  /** 是否启用 User-Agent 伪装（默认 true） */
  userAgent?: boolean;
  /** 是否启用时区伪装（默认 true） */
  timezone?: boolean;
  /** 是否启用地理位置伪装（默认 true） */
  geolocation?: boolean;
  /** 是否启用设备指标伪装（默认 true） */
  deviceMetrics?: boolean;
  /** 是否启用触摸事件伪装（默认 false，桌面设备应禁用） */
  touchEvents?: boolean;
  /** 是否启用媒体功能伪装（默认 true） */
  mediaFeatures?: boolean;
  /** 是否启用 Canvas 噪声（默认根据 fingerprint.canvas.noise） */
  canvasNoise?: boolean;
  /** Canvas 噪声级别 (0-1)（默认 0.1） */
  canvasNoiseLevel?: number;
  /** 是否启用 Audio 噪声（默认根据 fingerprint.audio.noise） */
  audioNoise?: boolean;
  /** Audio 噪声级别 (0-1)（默认 0.01） */
  audioNoiseLevel?: number;
  /** 是否启用 WebGL 噪声（默认根据 fingerprint.webglNoise） */
  webglNoise?: boolean;
  /** 是否启用指纹诊断脚本（默认 false） */
  diagnostics?: boolean;
  /** 自定义地理位置 */
  customGeolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

/**
 * User-Agent Client Hints 元数据
 */
// ========== CDP 命令生成 ==========

/**
 * 生成 CDP 伪装命令列表
 */
export function generateCDPCommands(
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): CDPCommand[] {
  const commands: CDPCommand[] = [];

  // 1. 时区伪装
  if (options.timezone !== false && fingerprint.timezone) {
    commands.push({
      method: 'Emulation.setTimezoneOverride',
      params: { timezoneId: fingerprint.timezone },
    });
    logger.debug('Added timezone override: ' + fingerprint.timezone);
  }

  // 2. 地理位置伪装
  if (options.geolocation !== false) {
    const geo = options.customGeolocation || getDefaultGeolocation(fingerprint.timezone);
    commands.push({
      method: 'Emulation.setGeolocationOverride',
      params: {
        latitude: geo.latitude,
        longitude: geo.longitude,
        accuracy: geo.accuracy || DEFAULT_GEOLOCATION_ACCURACY,
      },
    });
    logger.debug('Added geolocation override: ' + geo.latitude + ', ' + geo.longitude);
  }

  // 3. User-Agent 和 Client Hints
  // 2.1 Locale / Language（影响 navigator.language/Intl locale 等）
  if (options.locale !== false && fingerprint.languages && fingerprint.languages.length > 0) {
    commands.push({
      method: 'Emulation.setLocaleOverride',
      params: { locale: fingerprint.languages[0] },
    });
    logger.debug('Added locale override: ' + fingerprint.languages[0]);
  }

  const userAgentMetadata = buildUserAgentMetadata(fingerprint);

  if (options.userAgent !== false) {
    commands.push({
      method: 'Emulation.setUserAgentOverride',
      params: {
        userAgent: fingerprint.userAgent,
        platform: fingerprint.platform,
        acceptLanguage: buildAcceptLanguageHeaderValue(fingerprint.languages),
        userAgentMetadata,
      },
    });
    logger.debug('Added user agent override');
  }

  if (options.deviceMetrics !== false) {
    // 设备指标
    commands.push({
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: fingerprint.screenResolution.width,
        height: fingerprint.screenResolution.height,
        deviceScaleFactor:
          typeof fingerprint.pixelRatio === 'number' && fingerprint.pixelRatio > 0
            ? fingerprint.pixelRatio
            : 1,
        mobile: userAgentMetadata.mobile,
        screenWidth: fingerprint.screenResolution.width,
        screenHeight: fingerprint.screenResolution.height,
      },
    });
    logger.debug('Added device metrics override');
  }

  // 4. 触摸事件（桌面设备应禁用）
  if (options.touchEvents === false) {
    commands.push({
      method: 'Emulation.setTouchEmulationEnabled',
      params: { enabled: false },
    });
    logger.debug('Disabled touch emulation');
  } else if (options.touchEvents === true) {
    const maxTouchPoints =
      typeof fingerprint.maxTouchPoints === 'number' && fingerprint.maxTouchPoints > 0
        ? fingerprint.maxTouchPoints
        : 0;
    commands.push({
      method: 'Emulation.setTouchEmulationEnabled',
      params: maxTouchPoints > 0 ? { enabled: true, maxTouchPoints } : { enabled: false },
    });
    logger.debug('Enabled touch emulation');
  }

  // 5. 媒体功能
  if (options.mediaFeatures !== false) {
    commands.push({
      method: 'Emulation.setEmulatedMedia',
      params: {
        media: 'screen',
        features: [
          { name: 'prefers-color-scheme', value: 'light' },
          { name: 'prefers-reduced-motion', value: 'no-preference' },
          { name: 'prefers-contrast', value: 'no-preference' },
        ],
      },
    });
    logger.debug('Added media features override');
  }

  // 6. 禁用 Runtime 检测
  commands.push({
    method: 'Runtime.setAsyncCallStackDepth',
    params: { maxDepth: 0 },
  });

  return commands;
}

/**
 * 生成隐藏 CDP 调试器特征的命令
 */
export function generateDebuggerHidingCommands(): CDPCommand[] {
  return [
    { method: 'Performance.disable', params: {} },
    { method: 'Runtime.discardConsoleEntries', params: {} },
  ];
}

// ========== 脚本生成 ==========

function computeStealthSeed(fingerprint: BrowserFingerprint): number {
  const parts = [
    fingerprint.userAgent,
    fingerprint.platform,
    fingerprint.platformVersion ?? '',
    Array.isArray(fingerprint.languages) ? fingerprint.languages.join(',') : '',
    fingerprint.timezone,
    String(fingerprint.hardwareConcurrency ?? ''),
    String(fingerprint.deviceMemory ?? ''),
    `${fingerprint.screenResolution.width}x${fingerprint.screenResolution.height}`,
    `${fingerprint.screenResolution.availWidth ?? ''}x${fingerprint.screenResolution.availHeight ?? ''}`,
    String(fingerprint.colorDepth ?? ''),
    String(fingerprint.pixelRatio ?? ''),
    fingerprint.webgl?.vendor ?? '',
    fingerprint.webgl?.renderer ?? '',
    fingerprint.webgl?.version ?? '',
    Array.isArray(fingerprint.fonts) ? fingerprint.fonts.join('|') : '',
    String(fingerprint.maxTouchPoints ?? ''),
  ];

  return hashString(parts.join('||'));
}

/**
 * 生成完整的反检测脚本
 *
 * 包含所有 JS 层面的伪装，用于：
 * - CDP 的 Page.addScriptToEvaluateOnNewDocument 注入
 * - 或直接通过 executeJavaScript 注入
 */
export function generateFullStealthScript(
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): string {
  const seed = computeStealthSeed(fingerprint);

  // 解析噪声配置（优先使用 options，否则使用 fingerprint 中的配置）
  const enableCanvasNoise = options.canvasNoise ?? fingerprint.canvas?.noise ?? true;
  const enableAudioNoise = options.audioNoise ?? fingerprint.audio?.noise ?? false;
  const enableWebglNoise = options.webglNoise ?? fingerprint.webglNoise ?? false;
  const canvasNoiseLevel = options.canvasNoiseLevel ?? fingerprint.canvas?.noiseLevel ?? 0.1;
  const audioNoiseLevel = options.audioNoiseLevel ?? fingerprint.audio?.noiseLevel ?? 0.01;
  const maxTouchPoints =
    typeof fingerprint.maxTouchPoints === 'number' && fingerprint.maxTouchPoints > 0
      ? fingerprint.maxTouchPoints
      : 0;
  const touchPoints =
    options.touchEvents === false
      ? 0
      : options.touchEvents === true
        ? maxTouchPoints
        : fingerprint.touchSupport
          ? maxTouchPoints
          : 0;

  const scripts: string[] = [
    // 1. 函数原型保护（最先执行）
    generateFunctionPrototypeScript(),

    // 2. Console 调试输出伪装
    generateConsoleStealthScript(),

    // 3. Worker 调试检测绕过
    generateWorkerStealthScript(),

    // 4. Navigator.webdriver 隐藏
    generateWebdriverHideScript(),

    // 5. Chrome 对象注入
    generateChromeObjectScript(seed),

    // 6. Permissions API 伪装
    generatePermissionsScript(),

    // 7. 插件列表伪装
    generatePluginsScript(fingerprint.plugins),

    // 8. MimeTypes 伪装
    generateMimeTypesScript(fingerprint.plugins),

    // 9. WebGL 参数覆盖（含可选噪声）
    generateWebGLScript(fingerprint.webgl, enableWebglNoise ? seed : undefined),

    // 10. 语言列表
    options.locale !== false ? generateLanguagesScript(fingerprint.languages) : '',

    // 11. 硬件信息
    generateHardwareScript(fingerprint),

    // 12. Navigator 属性
    generateNavigatorPropsScript(fingerprint),

    // 13. 自动化特征清理
    generateAutomationCleanupScript(),

    // 14. 连接类型
    generateConnectionScript(),

    // 15. 时区（可选，CDP 方式更精确）
    options.timezone !== false && fingerprint.timezone
      ? generateTimezoneScript(fingerprint.timezone)
      : '',

    // 16. Battery API
    generateBatteryScript(seed),

    // 17. 屏幕信息
    generateScreenScript(fingerprint),

    // 18. Canvas 噪声（根据配置决定是否启用）
    enableCanvasNoise ? generateCanvasNoiseScript(canvasNoiseLevel) : '',

    // 19. AudioContext 防护（🔧 v2.1: 根据 audioNoise 配置决定是否启用）
    enableAudioNoise ? generateAudioContextScript(seed + 2, audioNoiseLevel) : '',

    // 20. WebRTC 防护
    generateWebRTCProtectionScript(),

    // 21. Client Hints
    generateClientHintsScript(fingerprint),

    // 22. Speech Synthesis
    generateSpeechSynthesisScript(),

    // 23. 触摸支持（如果配置了 touchSupport）
    generateTouchSupportScript(touchPoints),

    // 24. 字体列表（如果配置了 fonts）
    fingerprint.fonts && fingerprint.fonts.length > 0 ? generateFontsScript(fingerprint.fonts) : '',

    // 25. 指纹诊断脚本（可选）
    options.diagnostics ? generateDiagnosticsScript(fingerprint) : '',
  ];

  return wrapScript(combineScripts(scripts));
}

/**
 * 生成 CDP 脚本注入命令
 *
 * 使用 Page.addScriptToEvaluateOnNewDocument 在页面加载前注入
 */
export function generateScriptInjectionCommand(
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): CDPCommand {
  return {
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: {
      source: generateFullStealthScript(fingerprint, options),
    },
  };
}

// ========== 统一 API ==========

/**
 * 应用完整的 Stealth 伪装（CDP 方式）
 *
 * 执行流程：
 * 1. 执行 CDP 命令（时区、地理位置、User-Agent 等）
 * 2. 隐藏调试器特征
 * 3. 注入反检测脚本
 *
 * @param executor - CDP 执行器
 * @param fingerprint - 浏览器指纹配置
 * @param options - 可选配置
 */
export async function applyFullStealth(
  executor: CDPExecutor,
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): Promise<void> {
  const allCommands: CDPCommand[] = [
    // CDP 伪装命令
    ...generateCDPCommands(fingerprint, options),
    // 调试器隐藏命令
    ...generateDebuggerHidingCommands(),
    // 脚本注入命令
    generateScriptInjectionCommand(fingerprint, options),
  ];

  let successCount = 0;
  let failCount = 0;

  for (const command of allCommands) {
    try {
      await executor.send(command.method, command.params);
      successCount++;
      logger.debug('Executed CDP command: ' + command.method);
    } catch (error) {
      failCount++;
      logger.warn('Failed to execute CDP command: ' + command.method + ' - ' + String(error));
    }
  }

  logger.info(
    `Applied stealth: ${successCount} succeeded, ${failCount} failed (total: ${allCommands.length})`
  );
}

/**
 * 仅应用 CDP 命令（不注入脚本）
 *
 * 用于需要分开处理脚本注入的场景
 */
export async function applyCDPCommands(
  executor: CDPExecutor,
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): Promise<void> {
  const commands = [
    ...generateCDPCommands(fingerprint, options),
    ...generateDebuggerHidingCommands(),
  ];

  for (const command of commands) {
    try {
      await executor.send(command.method, command.params);
    } catch (error) {
      logger.warn('Failed to execute CDP command: ' + command.method + ' - ' + String(error));
    }
  }
}

// ========== 辅助函数 ==========

/**
 * 根据时区获取默认地理位置
 */
function getDefaultGeolocation(timezone?: string): {
  latitude: number;
  longitude: number;
  accuracy: number;
} {
  const location =
    timezone && TIMEZONE_LOCATIONS[timezone]
      ? TIMEZONE_LOCATIONS[timezone]
      : TIMEZONE_LOCATIONS[DEFAULT_TIMEZONE];

  return {
    ...location,
    accuracy: DEFAULT_GEOLOCATION_ACCURACY,
  };
}

/**
 * 构建 User-Agent Client Hints 元数据
 */
// ========== 本地脚本生成函数（从 script-generator.ts 移入） ==========

/**
 * Permissions API 伪装
 */
export const generateStealthScript = generateFullStealthScript;

/**
 * 创建 CDP Stealth 会话（向后兼容）
 * @deprecated 使用 applyFullStealth 代替
 */
export function createCDPStealthSession(
  fingerprint: BrowserFingerprint,
  options: StealthOptions = {}
): CDPCommand[] {
  return [
    ...generateCDPCommands(fingerprint, options),
    ...generateDebuggerHidingCommands(),
    generateScriptInjectionCommand(fingerprint, options),
  ];
}

// 导出 WEBGL_PARAMS 供外部使用
export { WEBGL_PARAMS };
