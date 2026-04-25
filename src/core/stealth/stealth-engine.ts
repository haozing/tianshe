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
function generatePermissionsScript(): string {
  return `
  // Permissions API 伪装
  (function() {
    if (!window.navigator.permissions || !window.navigator.permissions.query) return;

    const originalQuery = window.navigator.permissions.query;

    window.navigator.permissions.query = function(parameters) {
      if (parameters && parameters.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission === 'denied' ? 'denied' : Notification.permission,
          status: Notification.permission === 'denied' ? 'denied' : Notification.permission,
          onchange: null,
        });
      }
      return originalQuery.call(this, parameters);
    };

    if (window.__markAsNative) {
      window.__markAsNative(window.navigator.permissions.query, 'query');
    }
  })();
  `;
}

/**
 * 插件列表伪装
 */
function generatePluginsScript(plugins: BrowserFingerprint['plugins']): string {
  const pluginsJson = JSON.stringify(
    plugins.map((p) => ({
      name: p.name,
      filename: p.filename,
      description: p.description,
      mimeTypes: p.mimeTypes || [],
    }))
  );

  return `
  // 插件列表伪装
  (function() {
    const pluginData = ${pluginsJson};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function defineValue(target, prop, value, enumerable) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: false,
          enumerable: !!enumerable,
          configurable: true,
        });
      } catch (_e) {}
    }

    function defineGetter(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    function ensureConstructor(name, tag) {
      const toStringTag = typeof Symbol === 'function' ? Symbol.toStringTag : null;
      try {
        const existing = window[name];
        if (typeof existing === 'function' && existing.prototype) {
          if (toStringTag && !existing.prototype[toStringTag]) {
            defineValue(existing.prototype, toStringTag, tag, false);
          }
          markNative(existing, name);
          return existing;
        }
      } catch (_e) {}

      const ctor = function() {};
      ctor.prototype = Object.create(Object.prototype);
      if (toStringTag) {
        defineValue(ctor.prototype, toStringTag, tag, false);
      }
      try {
        window[name] = ctor;
      } catch (_e) {}
      markNative(ctor, name);
      return ctor;
    }

    const PluginCtor = ensureConstructor('Plugin', 'Plugin');
    const MimeTypeCtor = ensureConstructor('MimeType', 'MimeType');
    const PluginArrayCtor = ensureConstructor('PluginArray', 'PluginArray');
    const iteratorSymbol = typeof Symbol === 'function' ? Symbol.iterator : null;

    function createMimeType(mt, pluginRef) {
      const mimeType = Object.create(MimeTypeCtor.prototype);
      defineValue(mimeType, 'type', mt.type, false);
      defineValue(mimeType, 'suffixes', mt.suffixes, false);
      defineValue(mimeType, 'description', mt.description, false);
      defineValue(mimeType, 'enabledPlugin', pluginRef || null, false);
      return mimeType;
    }

    function createPlugin(p) {
      const plugin = Object.create(PluginCtor.prototype);
      defineValue(plugin, 'name', p.name, false);
      defineValue(plugin, 'filename', p.filename, false);
      defineValue(plugin, 'description', p.description, false);
      defineValue(plugin, 'length', p.mimeTypes.length, false);
      const item = function(i) { return this[i] || null; };
      const namedItem = function(name) {
        for (let i = 0; i < this.length; i++) {
          const item = this[i];
          if (item && item.type === name) return item;
        }
        return null;
      };
      defineValue(plugin, 'item', item, false);
      defineValue(plugin, 'namedItem', namedItem, false);
      markNative(item, 'item');
      markNative(namedItem, 'namedItem');
      if (iteratorSymbol) {
        const iterator = function* () {
          for (let i = 0; i < this.length; i++) {
            yield this[i];
          }
        };
        defineValue(plugin, iteratorSymbol, iterator, false);
        markNative(iterator, 'Symbol.iterator');
      }

      for (let index = 0; index < p.mimeTypes.length; index++) {
        const mt = p.mimeTypes[index];
        const mimeType = createMimeType(mt, plugin);
        defineValue(plugin, index, mimeType, true);
      }

      return plugin;
    }

    const pluginArray = Object.create(PluginArrayCtor.prototype);
    defineValue(pluginArray, 'length', pluginData.length, false);
    const arrayItem = function(index) { return this[index] || null; };
    const arrayNamedItem = function(name) {
      for (let i = 0; i < this.length; i++) {
        const plugin = this[i];
        if (plugin && plugin.name === name) return plugin;
      }
      return null;
    };
    const refresh = function() {};
    defineValue(pluginArray, 'item', arrayItem, false);
    defineValue(pluginArray, 'namedItem', arrayNamedItem, false);
    defineValue(pluginArray, 'refresh', refresh, false);
    markNative(arrayItem, 'item');
    markNative(arrayNamedItem, 'namedItem');
    markNative(refresh, 'refresh');
    if (iteratorSymbol) {
      const iterator = function* () {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      defineValue(pluginArray, iteratorSymbol, iterator, false);
      markNative(iterator, 'Symbol.iterator');
    }

    for (let i = 0; i < pluginData.length; i++) {
      defineValue(pluginArray, i, createPlugin(pluginData[i]), true);
    }

    const getPlugins = function() { return pluginArray; };
    markNative(getPlugins, 'get plugins');

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = defineGetter(proto, 'plugins', getPlugins) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      defineGetter(navigator, 'plugins', getPlugins);
    }
  })();
  `;
}

/**
 * MimeTypes 伪装
 */
function generateMimeTypesScript(plugins: BrowserFingerprint['plugins']): string {
  const allMimeTypes = plugins.flatMap((p) => p.mimeTypes || []);
  const mimeTypesJson = JSON.stringify(allMimeTypes);

  return `
  // MimeTypes 伪装
  (function() {
    const mimeTypeData = ${mimeTypesJson};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function defineValue(target, prop, value, enumerable) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: false,
          enumerable: !!enumerable,
          configurable: true,
        });
      } catch (_e) {}
    }

    function defineGetter(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    function ensureConstructor(name, tag) {
      const toStringTag = typeof Symbol === 'function' ? Symbol.toStringTag : null;
      try {
        const existing = window[name];
        if (typeof existing === 'function' && existing.prototype) {
          if (toStringTag && !existing.prototype[toStringTag]) {
            defineValue(existing.prototype, toStringTag, tag, false);
          }
          markNative(existing, name);
          return existing;
        }
      } catch (_e) {}

      const ctor = function() {};
      ctor.prototype = Object.create(Object.prototype);
      if (toStringTag) {
        defineValue(ctor.prototype, toStringTag, tag, false);
      }
      try {
        window[name] = ctor;
      } catch (_e) {}
      markNative(ctor, name);
      return ctor;
    }

    const MimeTypeCtor = ensureConstructor('MimeType', 'MimeType');
    const MimeTypeArrayCtor = ensureConstructor('MimeTypeArray', 'MimeTypeArray');
    const iteratorSymbol = typeof Symbol === 'function' ? Symbol.iterator : null;

    function createMimeType(mt, pluginRef) {
      const mimeType = Object.create(MimeTypeCtor.prototype);
      defineValue(mimeType, 'type', mt.type, false);
      defineValue(mimeType, 'suffixes', mt.suffixes, false);
      defineValue(mimeType, 'description', mt.description, false);
      defineValue(mimeType, 'enabledPlugin', pluginRef || null, false);
      return mimeType;
    }

    const mimeTypes = [];
    const seenTypes = new Set();
    try {
      const pluginArray = navigator.plugins;
      if (pluginArray && typeof pluginArray.length === 'number') {
        for (let i = 0; i < pluginArray.length; i++) {
          const plugin = pluginArray[i];
          if (!plugin || typeof plugin.length !== 'number') continue;
          for (let j = 0; j < plugin.length; j++) {
            let candidate = plugin[j];
            if (!candidate || !candidate.type) continue;
            if (seenTypes.has(candidate.type)) continue;
            seenTypes.add(candidate.type);
            if (Object.getPrototypeOf(candidate) !== MimeTypeCtor.prototype) {
              try {
                Object.setPrototypeOf(candidate, MimeTypeCtor.prototype);
              } catch (_e) {}
            }
            if (!candidate.enabledPlugin) {
              defineValue(candidate, 'enabledPlugin', plugin, false);
            }
            mimeTypes.push(candidate);
          }
        }
      }
    } catch (_e) {}

    if (mimeTypes.length === 0) {
      for (let i = 0; i < mimeTypeData.length; i++) {
        const mt = mimeTypeData[i];
        if (!mt || !mt.type || seenTypes.has(mt.type)) continue;
        seenTypes.add(mt.type);
        mimeTypes.push(createMimeType(mt, null));
      }
    }

    const mimeTypesArray = Object.create(MimeTypeArrayCtor.prototype);
    defineValue(mimeTypesArray, 'length', mimeTypes.length, false);
    const arrayItem = function(index) { return this[index] || null; };
    const arrayNamedItem = function(name) {
      for (let i = 0; i < this.length; i++) {
        const mt = this[i];
        if (mt && mt.type === name) return mt;
      }
      return null;
    };
    defineValue(mimeTypesArray, 'item', arrayItem, false);
    defineValue(mimeTypesArray, 'namedItem', arrayNamedItem, false);
    markNative(arrayItem, 'item');
    markNative(arrayNamedItem, 'namedItem');
    if (iteratorSymbol) {
      const iterator = function* () {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      defineValue(mimeTypesArray, iteratorSymbol, iterator, false);
      markNative(iterator, 'Symbol.iterator');
    }

    for (let i = 0; i < mimeTypes.length; i++) {
      defineValue(mimeTypesArray, i, mimeTypes[i], true);
    }

    const getMimeTypes = function() { return mimeTypesArray; };
    markNative(getMimeTypes, 'get mimeTypes');

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = defineGetter(proto, 'mimeTypes', getMimeTypes) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      defineGetter(navigator, 'mimeTypes', getMimeTypes);
    }
  })();
  `;
}

/**
 * 语言列表伪装
 */
function generateLanguagesScript(languages: string[]): string {
  const languagesJson = JSON.stringify(languages);
  const primary = languages[0] || 'en-US';

  return `
  // 语言列表伪装
  (function() {
    const __airpaLanguages = ${languagesJson};
    const __airpaPrimaryLanguage = ${JSON.stringify(primary)};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function tryDefine(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    const getLanguage = function() { return __airpaPrimaryLanguage; };
    const getLanguages = function() { return __airpaLanguages; };
    markNative(getLanguage, 'get language');
    markNative(getLanguages, 'get languages');

    let languagePatched = false;
    let languagesPatched = false;

    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        languagePatched = tryDefine(proto, 'language', getLanguage) || languagePatched;
        languagesPatched = tryDefine(proto, 'languages', getLanguages) || languagesPatched;
      }
    } catch (_e) {}

    languagePatched = tryDefine(navigator, 'language', getLanguage) || languagePatched;
    languagesPatched = tryDefine(navigator, 'languages', getLanguages) || languagesPatched;

    function shouldUseDefaultLocale(locales) {
      if (locales === undefined || locales === null) return true;
      if (Array.isArray(locales) && locales.length === 0) return true;
      if (typeof locales === 'string' && locales.trim().length === 0) return true;
      return false;
    }

    function patchIntlConstructor(name) {
      try {
        const Original = Intl[name];
        if (typeof Original !== 'function') return;
        const Wrapped = function(locales, options) {
          const resolvedLocales = shouldUseDefaultLocale(locales) ? __airpaPrimaryLanguage : locales;
          return new Original(resolvedLocales, options);
        };
        Wrapped.prototype = Original.prototype;
        if (typeof Original.supportedLocalesOf === 'function') {
          Wrapped.supportedLocalesOf = Original.supportedLocalesOf.bind(Original);
        }
        Intl[name] = Wrapped;
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(Wrapped, name);
        }
      } catch (_e) {}
    }

    ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames']
      .forEach(patchIntlConstructor);
  })();
  `;
}

/**
 * 硬件信息伪装
 */
function generateHardwareScript(fingerprint: BrowserFingerprint): string {
  return `
  // 硬件信息伪装
  (function() {
    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function tryDefine(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    const getHardwareConcurrency = function() { return ${fingerprint.hardwareConcurrency}; };
    markNative(getHardwareConcurrency, 'get hardwareConcurrency');

    let hardwarePatched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        hardwarePatched = tryDefine(proto, 'hardwareConcurrency', getHardwareConcurrency) || hardwarePatched;
      }
    } catch (_e) {}

    if (!hardwarePatched) {
      tryDefine(navigator, 'hardwareConcurrency', getHardwareConcurrency);
    }

    if ('deviceMemory' in navigator) {
      const getDeviceMemory = function() { return ${fingerprint.deviceMemory}; };
      markNative(getDeviceMemory, 'get deviceMemory');

      let memoryPatched = false;
      try {
        const proto = Object.getPrototypeOf(navigator);
        if (proto) {
          memoryPatched = tryDefine(proto, 'deviceMemory', getDeviceMemory) || memoryPatched;
        }
      } catch (_e) {}

      if (!memoryPatched) {
        tryDefine(navigator, 'deviceMemory', getDeviceMemory);
      }
    }
  })();
  `;
}

/**
 * Navigator 属性伪装
 */
function generateNavigatorPropsScript(fingerprint: BrowserFingerprint): string {
  const ua = fingerprint.userAgent;
  const appVersion = ua.startsWith('Mozilla/') ? ua.slice(8) : ua;
  const isFirefox = /Firefox/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/(Chrome|Chromium|Edg)\//i.test(ua);
  const vendor = isFirefox ? '' : isSafari ? 'Apple Computer, Inc.' : 'Google Inc.';
  const productSub = isFirefox ? '20100101' : '20030107';
  const props = {
    platform: fingerprint.platform,
    userAgent: ua,
    appVersion,
    vendor,
    vendorSub: '',
    productSub,
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    product: 'Gecko',
  };

  return `
  // Navigator props spoof
  (function() {
    const props = ${JSON.stringify(props)};

    function defineProp(target, prop, value) {
      const getter = function() { return value; };
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        try {
          if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
            window.__markAsNative(getter, prop);
          }
        } catch (_e) {}
        return true;
      } catch (_e) {
        return false;
      }
    }

    function patchProp(prop, value) {
      let patched = false;
      try {
        const proto = Object.getPrototypeOf(navigator);
        if (proto) {
          patched = defineProp(proto, prop, value);
        }
      } catch (_e) {}
      if (!patched) {
        defineProp(navigator, prop, value);
      }
    }

    for (const prop in props) {
      if (Object.prototype.hasOwnProperty.call(props, prop)) {
        patchProp(prop, props[prop]);
      }
    }
  })();
  `;
}

/**
 * 连接类型伪装
 */
function generateConnectionScript(): string {
  return `
  // 连接类型伪装
  (function() {
    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const connection = {
      effectiveType: '4g',
      downlink: 10,
      downlinkMax: 10,
      rtt: 50,
      saveData: false,
      type: 'wifi',
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    };

    markNative(connection.addEventListener, 'addEventListener');
    markNative(connection.removeEventListener, 'removeEventListener');
    markNative(connection.dispatchEvent, 'dispatchEvent');

    const getConnection = function() { return connection; };
    markNative(getConnection, 'get connection');

    function tryDefine(target) {
      try {
        Object.defineProperty(target, 'connection', {
          get: getConnection,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = tryDefine(proto) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      tryDefine(navigator);
    }
  })();
  `;
}

/**
 * 屏幕信息伪装
 *
 * 重要：Electron 离屏渲染时，screen.width/height 会返回 0，
 * 这会被抖音等网站的反爬虫系统检测到。必须伪装这些值。
 */
function generateScreenScript(fingerprint: BrowserFingerprint): string {
  const width = fingerprint.screenResolution.width;
  const height = fingerprint.screenResolution.height;
  // availWidth/availHeight 通常比全屏稍小（减去任务栏）
  const availWidth =
    typeof fingerprint.screenResolution.availWidth === 'number' &&
    fingerprint.screenResolution.availWidth > 0
      ? fingerprint.screenResolution.availWidth
      : width;
  const availHeight =
    typeof fingerprint.screenResolution.availHeight === 'number' &&
    fingerprint.screenResolution.availHeight > 0
      ? fingerprint.screenResolution.availHeight
      : height - 40;
  const pixelRatio =
    typeof fingerprint.pixelRatio === 'number' && fingerprint.pixelRatio > 0
      ? fingerprint.pixelRatio
      : 1;
  const scrollbarWidth = Math.max(0, Math.min(24, Math.round(width * 0.01)));
  const chromeHeight = Math.max(40, Math.min(140, Math.round(height * 0.08)));
  const fallbackInnerWidth = Math.max(0, availWidth - scrollbarWidth);
  const fallbackInnerHeight = Math.max(0, availHeight - chromeHeight);
  const orientationType = width >= height ? 'landscape-primary' : 'portrait-primary';

  return `
  // 屏幕信息伪装（包含尺寸、可见性等关键属性）
  (function() {
    var screenWidth = ${width};
    var screenHeight = ${height};
    var availWidth = ${availWidth};
    var availHeight = ${availHeight};
    var availLeft = 0;
    var availTop = 0;
    var fallbackInnerWidth = ${fallbackInnerWidth};
    var fallbackInnerHeight = ${fallbackInnerHeight};
    var pixelRatio = ${pixelRatio};
    var scrollbarWidth = ${scrollbarWidth};
    var chromeHeight = ${chromeHeight};
    var orientationType = '${orientationType}';
    var orientationAngle = 0;

    function defineValue(target, prop, value) {
      try {
        Object.defineProperty(target, prop, {
          get: function() { return value; },
          configurable: true,
          enumerable: true,
        });
      } catch (_e) {}
    }

    function defineGetter(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
      } catch (_e) {}
    }

    function getNativeGetter(target, prop) {
      var current = target;
      while (current) {
        try {
          var descriptor = Object.getOwnPropertyDescriptor(current, prop);
          if (descriptor && typeof descriptor.get === 'function') {
            return descriptor.get;
          }
        } catch (_e) {}
        current = Object.getPrototypeOf(current);
      }
      return null;
    }

    function readPositiveNumber(getter, target) {
      if (typeof getter !== 'function') return null;
      try {
        var value = getter.call(target);
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          return Math.round(value);
        }
      } catch (_e) {}
      return null;
    }

    var nativeInnerWidthGetter = getNativeGetter(window, 'innerWidth');
    var nativeInnerHeightGetter = getNativeGetter(window, 'innerHeight');
    var nativeOuterWidthGetter = getNativeGetter(window, 'outerWidth');
    var nativeOuterHeightGetter = getNativeGetter(window, 'outerHeight');
    var nativeVisualViewportGetter = getNativeGetter(window, 'visualViewport');

    function getInnerWidth() {
      return readPositiveNumber(nativeInnerWidthGetter, window) || fallbackInnerWidth;
    }

    function getInnerHeight() {
      return readPositiveNumber(nativeInnerHeightGetter, window) || fallbackInnerHeight;
    }

    function getOuterWidth() {
      var nativeOuterWidth = readPositiveNumber(nativeOuterWidthGetter, window);
      if (nativeOuterWidth) return nativeOuterWidth;
      var innerWidth = getInnerWidth();
      return Math.max(innerWidth, Math.min(screenWidth, innerWidth + scrollbarWidth + 16));
    }

    function getOuterHeight() {
      var nativeOuterHeight = readPositiveNumber(nativeOuterHeightGetter, window);
      if (nativeOuterHeight) return nativeOuterHeight;
      var innerHeight = getInnerHeight();
      return Math.max(innerHeight, Math.min(screenHeight, innerHeight + chromeHeight + 8));
    }

    function patchClientSize(element) {
      if (!element) return;
      defineGetter(element, 'clientWidth', function() {
        return getInnerWidth();
      });
      defineGetter(element, 'clientHeight', function() {
        return getInnerHeight();
      });
      defineGetter(element, 'offsetWidth', function() {
        return getInnerWidth();
      });
      defineGetter(element, 'offsetHeight', function() {
        return getInnerHeight();
      });
    }

    // Screen 尺寸属性
    defineValue(screen, 'width', screenWidth);
    defineValue(screen, 'height', screenHeight);
    defineValue(screen, 'availWidth', availWidth);
    defineValue(screen, 'availHeight', availHeight);
    defineValue(screen, 'availLeft', availLeft);
    defineValue(screen, 'availTop', availTop);
    defineValue(screen, 'colorDepth', ${fingerprint.colorDepth});
    defineValue(screen, 'pixelDepth', ${fingerprint.colorDepth});

    var orientation = {
      type: orientationType,
      angle: orientationAngle,
      onchange: null,
      lock: function() {
        return Promise.reject(new Error('NotSupportedError'));
      },
      unlock: function() {},
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    };
    defineValue(screen, 'orientation', orientation);

    // Window 尺寸：优先读取真实值，仅在不可用时回退为稳定指纹值
    defineGetter(window, 'outerWidth', function() {
      return getOuterWidth();
    });
    defineGetter(window, 'outerHeight', function() {
      return getOuterHeight();
    });

    // screenX/screenY/screenLeft/screenTop（窗口位置）
    defineValue(window, 'screenX', 0);
    defineValue(window, 'screenY', 0);
    defineValue(window, 'screenLeft', 0);
    defineValue(window, 'screenTop', 0);

    // devicePixelRatio（设备像素比，Electron 可能返回异常值）
    defineValue(window, 'devicePixelRatio', pixelRatio);

    // 视口尺寸：跟随真实窗口变化，仅在离屏/异常时使用稳定回退值
    defineGetter(window, 'innerWidth', function() {
      return getInnerWidth();
    });
    defineGetter(window, 'innerHeight', function() {
      return getInnerHeight();
    });

    patchClientSize(document.documentElement);
    if (document.body) {
      patchClientSize(document.body);
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        patchClientSize(document.body);
      });
    }

    var fallbackVisualViewport = {
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      onresize: null,
      onscroll: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    };

    defineGetter(fallbackVisualViewport, 'width', function() {
      return getInnerWidth();
    });
    defineGetter(fallbackVisualViewport, 'height', function() {
      return getInnerHeight();
    });

    var nativeVisualViewport = null;
    if (typeof nativeVisualViewportGetter === 'function') {
      try {
        nativeVisualViewport = nativeVisualViewportGetter.call(window);
      } catch (_e) {}
    } else {
      try {
        nativeVisualViewport = window.visualViewport;
      } catch (_e) {}
    }
    var hasUsableNativeVisualViewport = !!(
      nativeVisualViewport &&
      typeof nativeVisualViewport === 'object' &&
      typeof nativeVisualViewport.width === 'number' &&
      nativeVisualViewport.width > 0 &&
      typeof nativeVisualViewport.height === 'number' &&
      nativeVisualViewport.height > 0
    );
    if (!hasUsableNativeVisualViewport) {
      defineGetter(window, 'visualViewport', function() {
        return fallbackVisualViewport;
      });
    }

    // matchMedia 伪装（用于检测屏幕尺寸和特性）
    var originalMatchMedia = window.matchMedia;
    function parseLength(value) {
      if (!value) return null;
      var match = String(value).trim().match(/^([0-9.]+)(px)?$/i);
      return match ? parseFloat(match[1]) : null;
    }

    function parseResolution(value) {
      if (!value) return null;
      var match = String(value).trim().match(/^([0-9.]+)(dppx|dpi|dpcm)$/i);
      if (!match) return null;
      var num = parseFloat(match[1]);
      var unit = match[2].toLowerCase();
      if (unit === 'dppx') return num;
      if (unit === 'dpi') return num / 96;
      if (unit === 'dpcm') return (num * 2.54) / 96;
      return null;
    }

    function matchNumeric(feature, value, actual) {
      if (value === null || !Number.isFinite(actual)) return { supported: false };
      if (feature.indexOf('min-') === 0) return { supported: true, matches: actual >= value };
      if (feature.indexOf('max-') === 0) return { supported: true, matches: actual <= value };
      return { supported: true, matches: actual === value };
    }

    function evalCondition(condition) {
      var text = String(condition || '').trim();
      if (!text) return { supported: false };
      text = text.replace(/^[()]+|[()]+$/g, '').trim().toLowerCase();
      if (!text) return { supported: false };
      if (text === 'screen') return { supported: true, matches: true };
      if (text === 'print') return { supported: true, matches: false };

      var parts = text.split(':');
      var feature = parts[0].trim();
      var value = parts.slice(1).join(':').trim();
      var viewportWidth = getInnerWidth();
      var viewportHeight = getInnerHeight();

      if (feature === 'orientation') {
        var isLandscape = viewportWidth >= viewportHeight;
        if (value === 'landscape') return { supported: true, matches: isLandscape };
        if (value === 'portrait') return { supported: true, matches: !isLandscape };
      }

      if (feature === 'width' || feature === 'min-width' || feature === 'max-width') {
        return matchNumeric(feature, parseLength(value), viewportWidth);
      }

      if (feature === 'height' || feature === 'min-height' || feature === 'max-height') {
        return matchNumeric(feature, parseLength(value), viewportHeight);
      }

      if (
        feature === 'device-width' ||
        feature === 'min-device-width' ||
        feature === 'max-device-width'
      ) {
        return matchNumeric(feature, parseLength(value), screenWidth);
      }

      if (
        feature === 'device-height' ||
        feature === 'min-device-height' ||
        feature === 'max-device-height'
      ) {
        return matchNumeric(feature, parseLength(value), screenHeight);
      }

      if (
        feature === 'resolution' ||
        feature === 'min-resolution' ||
        feature === 'max-resolution'
      ) {
        return matchNumeric(feature, parseResolution(value), pixelRatio);
      }

      if (
        feature === 'device-pixel-ratio' ||
        feature === 'min-device-pixel-ratio' ||
        feature === 'max-device-pixel-ratio' ||
        feature === '-webkit-device-pixel-ratio' ||
        feature === '-webkit-min-device-pixel-ratio' ||
        feature === '-webkit-max-device-pixel-ratio'
      ) {
        var ratio = value ? parseFloat(value) : null;
        if (ratio === null || !Number.isFinite(ratio)) return { supported: false };
        return matchNumeric(feature, ratio, pixelRatio);
      }

      return { supported: false };
    }

    function evaluateQuery(query) {
      if (!query) return null;
      var groups = query.split(',');
      var hasSupported = false;
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        var parts = group.split(/\\s+and\\s+/i);
        var groupSupported = false;
        var groupMatches = true;
        for (var j = 0; j < parts.length; j++) {
          var part = parts[j];
          var result = evalCondition(part);
          if (result.supported) {
            groupSupported = true;
            if (!result.matches) {
              groupMatches = false;
              break;
            }
            continue;
          }

          if (typeof originalMatchMedia === 'function') {
            groupSupported = true;
            if (!originalMatchMedia.call(window, part).matches) {
              groupMatches = false;
              break;
            }
          }
        }

        if (groupSupported) {
          hasSupported = true;
          if (groupMatches) return true;
        }
      }
      return hasSupported ? false : null;
    }

    window.matchMedia = function(query) {
      var q = String(query || '');
      var evaluated = evaluateQuery(q);
      if (typeof evaluated === 'boolean') {
        var original = typeof originalMatchMedia === 'function' ? originalMatchMedia.call(window, q) : null;
        return {
          matches: evaluated,
          media: original && original.media ? original.media : q,
          onchange: null,
          addListener: original && original.addListener ? original.addListener.bind(original) : function() {},
          removeListener: original && original.removeListener ? original.removeListener.bind(original) : function() {},
          addEventListener: original && original.addEventListener ? original.addEventListener.bind(original) : function() {},
          removeEventListener: original && original.removeEventListener ? original.removeEventListener.bind(original) : function() {},
          dispatchEvent: function() { return true; }
        };
      }
      if (typeof originalMatchMedia === 'function') {
        return originalMatchMedia.call(window, q);
      }
      return {
        matches: false,
        media: q,
        onchange: null,
        addListener: function() {},
        removeListener: function() {},
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; }
      };
    };

    // Document 可见性状态（Electron 离屏/隐藏时为 hidden）
    // 抖音等网站会检测这个值，hidden 状态下不返回数据
    defineValue(document, 'visibilityState', 'visible');
    defineValue(document, 'hidden', false);
    defineValue(document, 'webkitVisibilityState', 'visible');
    defineValue(document, 'webkitHidden', false);

    // 拦截 visibilitychange 事件，防止触发隐藏状态
    var originalAddEventListener = document.addEventListener;
    document.addEventListener = function(type, listener, options) {
      if (type === 'visibilitychange' || type === 'webkitvisibilitychange') {
        // 包装 listener，确保总是返回 visible 状态
        var wrappedListener = function(event) {
          // 创建一个假的 event 对象属性
          Object.defineProperty(event, 'target', {
            get: function() {
              return {
                visibilityState: 'visible',
                hidden: false
              };
            }
          });
          return listener.call(this, event);
        };
        return originalAddEventListener.call(this, type, wrappedListener, options);
      }
      return originalAddEventListener.call(this, type, listener, options);
    };

    // Page Visibility API - 也需要伪装
    if (typeof document.hasFocus === 'function') {
      document.hasFocus = function() { return true; };
    }
  })();
  `;
}

/**
 * 指纹诊断脚本（可选）
 */
function generateDiagnosticsScript(fingerprint: BrowserFingerprint): string {
  const expected = {
    userAgent: fingerprint.userAgent,
    platform: fingerprint.platform,
    platformVersion: fingerprint.platformVersion,
    languages: fingerprint.languages,
    timezone: fingerprint.timezone,
    screen: {
      width: fingerprint.screenResolution.width,
      height: fingerprint.screenResolution.height,
      availWidth: fingerprint.screenResolution.availWidth,
      availHeight: fingerprint.screenResolution.availHeight,
      colorDepth: fingerprint.colorDepth,
      pixelRatio: fingerprint.pixelRatio,
    },
    webgl: fingerprint.webgl,
    touchSupport: fingerprint.touchSupport,
    maxTouchPoints: fingerprint.maxTouchPoints,
  };
  const expectedJson = JSON.stringify(expected);

  return `
  // 指纹诊断（可选）
  (function() {
    try {
      var expected = ${expectedJson};
      var actual = {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: Array.isArray(navigator.languages) ? Array.from(navigator.languages) : [],
        timezone: (function() {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
          } catch (_e) {
            return '';
          }
        })(),
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          pixelDepth: screen.pixelDepth,
        },
        pixelRatio: window.devicePixelRatio,
        viewport: {
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        },
        connection: (function() {
          try {
            var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (!conn) return null;
            return {
              effectiveType: conn.effectiveType,
              downlink: conn.downlink,
              rtt: conn.rtt,
              saveData: conn.saveData,
              type: conn.type,
            };
          } catch (_e) {
            return null;
          }
        })(),
        userAgentData: (function() {
          try {
            var ua = navigator.userAgentData;
            if (!ua) return null;
            var brands = Array.isArray(ua.brands)
              ? ua.brands.map(function(b) { return { brand: b.brand, version: b.version }; })
              : [];
            return {
              brands: brands,
              mobile: ua.mobile,
              platform: ua.platform,
            };
          } catch (_e) {
            return null;
          }
        })(),
        plugins: (function() {
          try {
            if (!navigator.plugins) return [];
            var list = [];
            for (var i = 0; i < navigator.plugins.length; i++) {
              var p = navigator.plugins[i];
              if (p && p.name) list.push(p.name);
            }
            return list;
          } catch (_e) {
            return [];
          }
        })(),
        mimeTypes: (function() {
          try {
            if (!navigator.mimeTypes) return [];
            var list = [];
            for (var i = 0; i < navigator.mimeTypes.length; i++) {
              var mt = navigator.mimeTypes[i];
              if (mt && mt.type) list.push(mt.type);
            }
            return list;
          } catch (_e) {
            return [];
          }
        })(),
        webgl: (function() {
          try {
            var canvas = document.createElement('canvas');
            var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (!gl) return null;
            var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            var vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(37445);
            var renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(37446);
            var version = gl.getParameter(7938);
            return { vendor: vendor, renderer: renderer, version: version };
          } catch (_e) {
            return null;
          }
        })(),
        maxTouchPoints: navigator.maxTouchPoints || 0,
      };
      window.__airpaFingerprintDiagnostics = { expected: expected, actual: actual };
    } catch (_e) {}
  })();
  `;
}

/**
 * Speech Synthesis Voices 伪装
 */
function generateSpeechSynthesisScript(): string {
  return `
  // Speech Synthesis Voices 伪装
  (function() {
    if (typeof speechSynthesis === 'undefined') return;

    const genericVoices = [
      { name: 'Google US English', lang: 'en-US', localService: false, default: true, voiceURI: 'Google US English' },
      { name: 'Google UK English Female', lang: 'en-GB', localService: false, default: false, voiceURI: 'Google UK English Female' },
      { name: 'Google UK English Male', lang: 'en-GB', localService: false, default: false, voiceURI: 'Google UK English Male' },
      { name: 'Google español', lang: 'es-ES', localService: false, default: false, voiceURI: 'Google español' },
      { name: 'Google français', lang: 'fr-FR', localService: false, default: false, voiceURI: 'Google français' },
      { name: 'Google Deutsch', lang: 'de-DE', localService: false, default: false, voiceURI: 'Google Deutsch' },
      { name: 'Google 日本語', lang: 'ja-JP', localService: false, default: false, voiceURI: 'Google 日本語' },
      { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', localService: false, default: false, voiceURI: 'Google 普通话（中国大陆）' },
    ];

    speechSynthesis.getVoices = function() {
      return genericVoices;
    };
  })();
  `;
}

// ========== 向后兼容导出 ==========

/**
 * 生成 Stealth 脚本（向后兼容）
 * @deprecated 使用 generateFullStealthScript 代替
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
