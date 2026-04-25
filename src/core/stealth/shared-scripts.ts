/**
 * 共享脚本生成模块
 *
 * 提供可在 CDP 和直接 JS 注入两种方式下复用的脚本生成函数
 * 避免 cdp-emulation.ts 和 script-generator.ts 之间的代码重复
 */

import {
  WEBGL_PARAMS,
  TIMEZONE_OFFSETS,
  AUTOMATION_WINDOW_OBJECTS,
  AUTOMATION_DOCUMENT_OBJECTS,
  DEFAULT_TIMEZONE,
} from './constants';
import type { BrowserFingerprint } from './types';
import { buildUserAgentMetadata } from './client-hints';

// ========== 工具函数 ==========

/**
 * 基于种子的伪随机数生成器（Mulberry32 算法）
 *
 * 用于生成确定性随机数，确保同一种子产生相同序列
 *
 * @param seed - 随机种子
 * @returns 返回 0-1 之间的伪随机数的函数
 */
export function createSeededRandom(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 简单的字符串哈希函数（djb2 算法）
 *
 * 用于从字符串生成确定性种子
 *
 * @param str - 输入字符串
 * @returns 哈希值
 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash; // 转换为 32 位整数
  }
  return Math.abs(hash);
}

// ========== WebGL 脚本 ==========

/**
 * 生成 WebGL 参数覆盖脚本
 *
 * 覆盖 WebGLRenderingContext.getParameter 以返回自定义的 GPU 信息
 *
 * @param webgl - WebGL 配置
 * @param noiseSeed - 可选的噪声种子，提供时会为 WebGL 添加微小噪声
 * @returns JavaScript 代码字符串
 */
export function generateWebGLScript(
  webgl: BrowserFingerprint['webgl'],
  noiseSeed?: number
): string {
  // 转义字符串中的特殊字符
  const vendor = webgl.vendor.replace(/'/g, "\\'");
  const renderer = webgl.renderer.replace(/'/g, "\\'");
  const version = webgl.version.replace(/'/g, "\\'");

  // 如果启用噪声，添加噪声生成代码
  const noiseCode =
    noiseSeed !== undefined
      ? `
    // WebGL 噪声生成（确定性）
    function seededRandom(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    const noiseRandom = seededRandom(${noiseSeed});
    const noiseMultiplier = 1 + (noiseRandom() - 0.5) * 0.0001; // 微小噪声 ±0.005%
    const noiseByteDelta = Math.max(1, Math.round(noiseRandom() * 2)); // 1~2
  `
      : '';

  const applyNoise =
    noiseSeed !== undefined
      ? `
        // 对数值类型的参数应用微小噪声
        if (typeof result === 'number' && !Number.isInteger(result)) {
          result = result * noiseMultiplier;
        }
  `
      : '';

  const readPixelsPatch =
    noiseSeed !== undefined
      ? `
      // readPixels 是很多 WebGL 指纹的核心采集点：在不破坏渲染的前提下对输出做极小确定性扰动
      const readPixels = proto.readPixels;
      if (typeof readPixels === 'function') {
        proto.readPixels = function(...args) {
          const out = readPixels.apply(this, args);
          try {
            const pixels = args[5] || args[6]; // WebGL1: (x,y,w,h,format,type,pixels), WebGL2 有 offset
            if (pixels && pixels.buffer && pixels.byteLength && pixels.length) {
              const len = pixels.length >>> 0;
              const r = seededRandom(${noiseSeed} + len);
              const steps = Math.min(6, Math.max(1, Math.floor(len / 2000)));
              for (let i = 0; i < steps; i++) {
                const idx = Math.floor(r() * len) >>> 0;
                if (idx >= len) continue;
                const v = pixels[idx];
                if (typeof v === 'number') {
                  if (pixels instanceof Float32Array || pixels instanceof Float64Array) {
                    pixels[idx] = v + (r() - 0.5) * 1e-7;
                  } else {
                    const next = v + (r() > 0.5 ? noiseByteDelta : -noiseByteDelta);
                    pixels[idx] = Math.max(0, Math.min(255, next));
                  }
                }
              }
            }
          } catch (_e) {}
          return out;
        };
        markNative(proto.readPixels, 'readPixels');
      }
    `
      : '';

  const shadingLanguageVersion =
    webgl.version && webgl.version.toLowerCase().includes('webgl 2')
      ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'
      : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';

  return `
  // WebGL 参数覆盖${noiseSeed !== undefined ? '（含噪声）' : ''}
  (function() {
    const VENDOR = ${WEBGL_PARAMS.UNMASKED_VENDOR_WEBGL};
    const RENDERER = ${WEBGL_PARAMS.UNMASKED_RENDERER_WEBGL};
    const VERSION = ${WEBGL_PARAMS.VERSION};
    const SHADING_LANGUAGE_VERSION = 0x8B8C;
    const MASKED_VENDOR = 0x1F00;
    const MASKED_RENDERER = 0x1F01;
    const MAX_TEXTURE_SIZE = 0x0D33;
    const MAX_RENDERBUFFER_SIZE = 0x84E8;
    const MAX_VIEWPORT_DIMS = 0x0D3A;
    const MAX_VERTEX_UNIFORM_VECTORS = 0x8DFB;
    const MAX_FRAGMENT_UNIFORM_VECTORS = 0x8DFD;
    const MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8B4D;
    const MAX_TEXTURE_IMAGE_UNITS = 0x8872;
    const MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8B4C;
    const MAX_CUBE_MAP_TEXTURE_SIZE = 0x851C;
    const MAX_VARYING_VECTORS = 0x8DFC;
    const MAX_VERTEX_ATTRIBS = 0x8869;
    const ALIASED_LINE_WIDTH_RANGE = 0x846E;
    const ALIASED_POINT_SIZE_RANGE = 0x846D;
    const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info';

    const webglParams = {
      [VENDOR]: '${vendor}',
      [RENDERER]: '${renderer}',
      [VERSION]: '${version}',
      [SHADING_LANGUAGE_VERSION]: '${shadingLanguageVersion}',
      [MASKED_VENDOR]: 'WebKit',
      [MASKED_RENDERER]: 'WebKit WebGL',
    };

    const vendorLower = '${vendor}'.toLowerCase();
    const rendererLower = '${renderer}'.toLowerCase();
    const isNvidia = vendorLower.includes('nvidia');
    const isAmd = vendorLower.includes('amd') || rendererLower.includes('radeon');
    const isIntel =
      vendorLower.includes('intel') || rendererLower.includes('intel') || rendererLower.includes('iris');
    const isApple =
      vendorLower.includes('apple') ||
      rendererLower.includes('apple') ||
      rendererLower.includes('m1') ||
      rendererLower.includes('m2') ||
      rendererLower.includes('m3');
    const isMesa = vendorLower.includes('mesa') || rendererLower.includes('mesa');

    const capsHigh = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 4096,
      maxFragmentUniformVectors: 4096,
      maxCombinedTextureImageUnits: 192,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 32,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const capsMid = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 2048,
      maxFragmentUniformVectors: 2048,
      maxCombinedTextureImageUnits: 128,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 16,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const capsLow = {
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
      maxViewportDims: 8192,
      maxVertexUniformVectors: 2048,
      maxFragmentUniformVectors: 2048,
      maxCombinedTextureImageUnits: 96,
      maxTextureImageUnits: 16,
      maxVertexTextureImageUnits: 16,
      maxCubeMapTextureSize: 8192,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 512,
    };
    const capsApple = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 4096,
      maxFragmentUniformVectors: 4096,
      maxCombinedTextureImageUnits: 160,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 32,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const isHighEnd =
      rendererLower.includes('rtx') ||
      rendererLower.includes('rx ') ||
      rendererLower.includes('radeon') ||
      rendererLower.includes('quadro') ||
      rendererLower.includes('firepro');
    const isMidEnd =
      rendererLower.includes('gtx') ||
      rendererLower.includes('geforce') ||
      rendererLower.includes('vega') ||
      rendererLower.includes('arc');
    const capProfile = (function() {
      if (isApple) return capsApple;
      if (isHighEnd) return capsHigh;
      if (isMidEnd) return capsMid;
      if (isNvidia || isAmd) return capsMid;
      if (isIntel || isMesa) return capsLow;
      return capsLow;
    })();

    const webglCaps = {
      [MAX_TEXTURE_SIZE]: capProfile.maxTextureSize,
      [MAX_RENDERBUFFER_SIZE]: capProfile.maxRenderbufferSize,
      [MAX_VIEWPORT_DIMS]: [capProfile.maxViewportDims, capProfile.maxViewportDims],
      [MAX_VERTEX_UNIFORM_VECTORS]: capProfile.maxVertexUniformVectors,
      [MAX_FRAGMENT_UNIFORM_VECTORS]: capProfile.maxFragmentUniformVectors,
      [MAX_COMBINED_TEXTURE_IMAGE_UNITS]: capProfile.maxCombinedTextureImageUnits,
      [MAX_TEXTURE_IMAGE_UNITS]: capProfile.maxTextureImageUnits,
      [MAX_VERTEX_TEXTURE_IMAGE_UNITS]: capProfile.maxVertexTextureImageUnits,
      [MAX_CUBE_MAP_TEXTURE_SIZE]: capProfile.maxCubeMapTextureSize,
      [MAX_VARYING_VECTORS]: capProfile.maxVaryingVectors,
      [MAX_VERTEX_ATTRIBS]: capProfile.maxVertexAttribs,
      [ALIASED_LINE_WIDTH_RANGE]: [1, 1],
      [ALIASED_POINT_SIZE_RANGE]: [1, capProfile.maxPointSize],
    };

    ${noiseCode}

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const __airpaDebugRendererInfoExt = createDebugRendererInfoExtension();
    function createDebugRendererInfoExtension() {
      return {
        UNMASKED_VENDOR_WEBGL: VENDOR,
        UNMASKED_RENDERER_WEBGL: RENDERER,
      };
    }

    function patchContext(proto, label) {
      if (!proto) return;

      const getSupportedExtensions = proto.getSupportedExtensions;
      if (typeof getSupportedExtensions === 'function') {
        proto.getSupportedExtensions = function() {
          let list;
          try {
            list = getSupportedExtensions.call(this);
          } catch (_e) {
            list = null;
          }

          const arr = Array.isArray(list) ? [...list] : [];
          if (!arr.some((e) => String(e || '').toLowerCase() === DEBUG_RENDERER_INFO.toLowerCase())) {
            arr.push(DEBUG_RENDERER_INFO);
          }
          return arr;
        };
        markNative(proto.getSupportedExtensions, 'getSupportedExtensions');
      }

      const getParameter = proto.getParameter;
      if (typeof getParameter === 'function') {
        proto.getParameter = function(param) {
          if (param in webglParams) return webglParams[param];
          var result = getParameter.call(this, param);
          if (param in webglCaps) {
            const override = webglCaps[param];
            if (typeof override === 'number') {
              if (typeof result === 'number' && Number.isFinite(result)) {
                return Math.min(override, result);
              }
              return override;
            }
            if (Array.isArray(override)) {
              const out = [];
              const length = override.length;
              for (let i = 0; i < length; i++) {
                const originalValue = result && typeof result[i] === 'number' ? result[i] : undefined;
                out[i] =
                  typeof originalValue === 'number' ? Math.min(override[i], originalValue) : override[i];
              }
              if (typeof Int32Array !== 'undefined' && result instanceof Int32Array) {
                return new Int32Array(out);
              }
              if (typeof Float32Array !== 'undefined' && result instanceof Float32Array) {
                return new Float32Array(out);
              }
              return out;
            }
          }
          ${applyNoise}
          return result;
        };
        markNative(proto.getParameter, 'getParameter');
      }

      const getExtension = proto.getExtension;
      if (typeof getExtension === 'function') {
        proto.getExtension = function(name) {
          try {
            const normalized = String(name || '').trim().toLowerCase();
            if (normalized === DEBUG_RENDERER_INFO.toLowerCase()) {
              return __airpaDebugRendererInfoExt;
            }
          } catch (_e) {}
          return getExtension.call(this, name);
        };
        markNative(proto.getExtension, 'getExtension');
      }

      ${readPixelsPatch}
    }

    // WebGL 1.0
    try {
      if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext && WebGLRenderingContext.prototype) {
        patchContext(WebGLRenderingContext.prototype, 'webgl1');
      }
    } catch (_e) {}

    // WebGL 2.0
    try {
      if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext && WebGL2RenderingContext.prototype) {
        patchContext(WebGL2RenderingContext.prototype, 'webgl2');
      }
    } catch (_e) {}
  })();
  `;
}

// ========== Webdriver 隐藏脚本 ==========

/**
 * 生成 navigator.webdriver 隐藏脚本
 *
 * @returns JavaScript 代码字符串
 */
export function generateWebdriverHideScript(): string {
  return `
  // 隐藏 navigator.webdriver
  (function() {
    // 尝试从实例和原型链上彻底删除 webdriver 属性
    // 注意：Electron --disable-blink-features=AutomationControlled 会设置值为 undefined 但保留属性
    try {
      // 1. 删除 navigator 实例上的属性
      delete navigator.webdriver;

      // 2. 删除 Navigator.prototype 上的属性
      const proto = Object.getPrototypeOf(navigator);
      if (proto && 'webdriver' in proto) {
        delete proto.webdriver;
      }

      // 3. 如果无法删除（只读属性），则用 getter 覆盖，返回 undefined
      // 使用 enumerable: false 使其在枚举时不可见
      if ('webdriver' in navigator) {
        const descriptor = {
          get: () => undefined,
          configurable: true,
          enumerable: false,
        };
        Object.defineProperty(navigator, 'webdriver', descriptor);
        try {
          if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
            window.__markAsNative(descriptor.get, 'get webdriver');
          }
        } catch (_e) {}
      }
    } catch (e) {
      // 静默失败，避免暴露自动化特征
    }
  })();
  `;
}

// ========== 自动化特征清理脚本 ==========

/**
 * 生成自动化工具特征清理脚本
 *
 * 删除 Selenium、Puppeteer 等自动化工具注入的全局对象
 * 注意：navigator.webdriver 由 generateWebdriverHideScript 单独处理，此处不再重复
 *
 * @returns JavaScript 代码字符串
 */
export function generateAutomationCleanupScript(): string {
  const objectsJson = JSON.stringify(AUTOMATION_WINDOW_OBJECTS);
  const documentObjectsJson = JSON.stringify(AUTOMATION_DOCUMENT_OBJECTS);

  return `
  // 清理自动化工具特征
  (function() {
    const automationObjects = ${objectsJson};
    const automationDocumentObjects = ${documentObjectsJson};

    function tryDelete(target, prop) {
      try {
        delete target[prop];
      } catch (_e) {}
    }

    automationObjects.forEach(function(obj) {
      try {
        delete window[obj];
      } catch (_e) {}
    });

    try {
      const winProps = Object.getOwnPropertyNames(window);
      for (let i = 0; i < winProps.length; i++) {
        const prop = winProps[i];
        if (/\\$[a-z]dc_/i.test(prop)) {
          tryDelete(window, prop);
        }
      }
    } catch (_e) {}

    try {
      if (typeof document !== 'undefined') {
        automationDocumentObjects.forEach(function(obj) {
          tryDelete(document, obj);
        });

        try {
          const docProps = Object.getOwnPropertyNames(document);
          for (let i = 0; i < docProps.length; i++) {
            const prop = docProps[i];
            if (/\\$[a-z]dc_/i.test(prop)) {
              tryDelete(document, prop);
            }
          }
        } catch (_e) {}

        try {
          const root = document.documentElement;
          if (root && typeof root.removeAttribute === 'function') {
            ['webdriver', 'driver', 'selenium'].forEach(function(attr) {
              try {
                if (root.hasAttribute(attr)) {
                  root.removeAttribute(attr);
                }
              } catch (_e) {}
            });
          }
        } catch (_e) {}
      }
    } catch (_e) {}

    try {
      if (window.external) {
        const originalToString = window.external.toString;
        const safeToString = function() {
          try {
            const result = typeof originalToString === 'function' ? originalToString.call(this) : '';
            if (typeof result === 'string' && result && !/Sequentum/i.test(result)) {
              return result;
            }
          } catch (_e) {}
          return 'External';
        };
        if (typeof originalToString === 'function') {
          window.external.toString = safeToString;
        } else {
          try {
            Object.defineProperty(window.external, 'toString', {
              value: safeToString,
              configurable: true,
            });
          } catch (_e) {}
        }
        try {
          if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
            window.__markAsNative(window.external.toString, 'toString');
          }
        } catch (_e) {}
      }
    } catch (_e) {}
  })();
  `;
}

// ========== 时区脚本 ==========

/**
 * 生成时区伪装脚本
 *
 * 通过 JS 重写 Intl API 和 Date 方法实现时区伪装
 * 注意：精度不如 CDP Emulation.setTimezoneOverride
 *
 * @param timezone - IANA 时区标识符
 * @returns JavaScript 代码字符串
 */
export function generateTimezoneScript(timezone: string): string {
  const offset = TIMEZONE_OFFSETS[timezone] ?? TIMEZONE_OFFSETS[DEFAULT_TIMEZONE] ?? 0;
  const zoneName = timezone.split('/').pop() || 'Unknown';

  // 转义时区字符串
  const escapedTimezone = timezone.replace(/'/g, "\\'");
  const escapedZoneName = zoneName.replace(/'/g, "\\'");

  return `
  // 时区伪装（JS 实现，不依赖 CDP）
  (function() {
    const targetTimezone = '${escapedTimezone}';
    const targetOffset = ${offset};
    const zoneName = '${escapedZoneName}';

    // 1. 重写 Intl.DateTimeFormat
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(...args) {
      const options = args[1] || {};
      if (typeof options === 'object' && !options.timeZone) {
        options.timeZone = targetTimezone;
        args[1] = options;
      }
      return new OriginalDateTimeFormat(...args);
    };
    Intl.DateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf;
    try {
      if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
        window.__markAsNative(Intl.DateTimeFormat, 'DateTimeFormat');
      }
    } catch (_e) {}

    // 2. 重写 Date.prototype.getTimezoneOffset
    Date.prototype.getTimezoneOffset = function() {
      return targetOffset;
    };

    // 3. 重写 Date.prototype.toString
    const originalToString = Date.prototype.toString;
    Date.prototype.toString = function() {
      const str = originalToString.call(this);
      return str.replace(/\\(.*\\)$/, '(' + zoneName + ')');
    };
  })();
  `;
}

// ========== Battery API 脚本 ==========

/**
 * 生成 Battery API 伪装脚本
 *
 * 使用确定性值避免随机性被用于指纹识别
 *
 * @param seed - 随机种子（用于生成确定性值）
 * @returns JavaScript 代码字符串
 */
export function generateBatteryScript(seed: number): string {
  // 使用种子生成确定性的电池状态
  const random = createSeededRandom(seed);
  const charging = random() > 0.5;
  const level = Math.round((random() * 0.5 + 0.5) * 100) / 100; // 50%-100%
  const chargeRemaining = Math.max(0, 1 - level);
  const chargingTime = charging
    ? Math.max(0, Math.round(chargeRemaining * 3600 + random() * 300))
    : Infinity;
  const dischargingTime = charging
    ? Infinity
    : Math.max(60, Math.round(level * 7200 + random() * 600));

  return `
  // Battery API 伪装（确定性值）
  (function() {
    if (navigator.getBattery) {
      function markNative(fn, name) {
        try {
          if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
            window.__markAsNative(fn, name);
          }
        } catch (_e) {}
      }

      const batteryInfo = {
        charging: ${charging},
        chargingTime: ${chargingTime},
        dischargingTime: ${dischargingTime},
        level: ${level},
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; },
      };

      markNative(batteryInfo.addEventListener, 'addEventListener');
      markNative(batteryInfo.removeEventListener, 'removeEventListener');
      markNative(batteryInfo.dispatchEvent, 'dispatchEvent');

      const getBattery = function() {
        return Promise.resolve(batteryInfo);
      };
      navigator.getBattery = getBattery;
      markNative(getBattery, 'getBattery');
    }
  })();
  `;
}

// ========== AudioContext 脚本 ==========

/**
 * 生成 AudioContext 指纹防护脚本
 *
 * 使用确定性噪声避免随机性被用于指纹识别
 *
 * @param seed - 随机种子
 * @returns JavaScript 代码字符串
 */
export function generateAudioContextScript(seed: number, noiseLevel?: number): string {
  const resolvedNoiseLevel = Number.isFinite(noiseLevel)
    ? Math.max(0, Math.min(1, noiseLevel as number))
    : 0.01;
  const channelAmp = Number((resolvedNoiseLevel * 0.01).toFixed(8));
  const freqAmp = Number((resolvedNoiseLevel * 10).toFixed(6));
  const byteAmp = Math.max(1, Math.round(resolvedNoiseLevel * 10));
  const timeAmp = Number((resolvedNoiseLevel * 0.002).toFixed(8));

  return `
  // AudioContext 指纹防护（确定性噪声）
  (function() {
    const AudioContextCtor = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
    if (!AudioContextCtor) return;

    const __airpaAudioNoiseLevel = ${resolvedNoiseLevel};
    const __airpaAudioChannelAmp = ${channelAmp};
    const __airpaAudioFreqAmp = ${freqAmp};
    const __airpaAudioByteAmp = ${byteAmp};
    const __airpaAudioTimeAmp = ${timeAmp};

    // 基于种子的伪随机数生成器
    function seededRandom(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    const random = seededRandom(${seed});

    // 覆盖 AudioBuffer.getChannelData
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = originalGetChannelData.call(this, channel);
      // 使用标记避免重复添加噪声
      const key = '_noise_' + channel;
      if (!this[key]) {
        for (let i = 0; i < data.length; i += 100) {
          data[i] += (random() - 0.5) * __airpaAudioChannelAmp;
        }
        this[key] = true;
      }
      return data;
    };

    // 覆盖 AnalyserNode.getFloatFrequencyData
    function patchAnalyser(analyser, localRandom) {
      if (!analyser) return analyser;

      const origGetFloatFrequencyData = analyser.getFloatFrequencyData;
      if (typeof origGetFloatFrequencyData === 'function') {
        analyser.getFloatFrequencyData = function(array) {
          origGetFloatFrequencyData.call(this, array);
          for (let i = 0; i < array.length; i += 10) {
            array[i] += (localRandom() - 0.5) * __airpaAudioFreqAmp;
          }
        };
      }

      const origGetByteFrequencyData = analyser.getByteFrequencyData;
      if (typeof origGetByteFrequencyData === 'function') {
        analyser.getByteFrequencyData = function(array) {
          origGetByteFrequencyData.call(this, array);
          for (let i = 0; i < array.length; i += 10) {
            const v = array[i] + (localRandom() > 0.5 ? __airpaAudioByteAmp : -__airpaAudioByteAmp);
            array[i] = Math.max(0, Math.min(255, v));
          }
        };
      }

      const origGetByteTimeDomainData = analyser.getByteTimeDomainData;
      if (typeof origGetByteTimeDomainData === 'function') {
        analyser.getByteTimeDomainData = function(array) {
          origGetByteTimeDomainData.call(this, array);
          for (let i = 0; i < array.length; i += 10) {
            const v = array[i] + (localRandom() > 0.5 ? __airpaAudioByteAmp : -__airpaAudioByteAmp);
            array[i] = Math.max(0, Math.min(255, v));
          }
        };
      }

      const origGetFloatTimeDomainData = analyser.getFloatTimeDomainData;
      if (typeof origGetFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData = function(array) {
          origGetFloatTimeDomainData.call(this, array);
          for (let i = 0; i < array.length; i += 10) {
            array[i] += (localRandom() - 0.5) * __airpaAudioTimeAmp;
          }
        };
      }

      return analyser;
    }

    function patchCreateAnalyser(proto, seedOffset) {
      if (!proto || typeof proto.createAnalyser !== 'function') return;
      const originalCreateAnalyser = proto.createAnalyser;
      proto.createAnalyser = function() {
        const analyser = originalCreateAnalyser.call(this);
        const localRandom = seededRandom(${seed} + seedOffset);
        return patchAnalyser(analyser, localRandom);
      };
    }

    patchCreateAnalyser(AudioContextCtor.prototype, 1);
    if (typeof OfflineAudioContext !== 'undefined' && OfflineAudioContext && OfflineAudioContext.prototype) {
      patchCreateAnalyser(OfflineAudioContext.prototype, 2);
    }
  })();
  `;
}

// ========== WebRTC 防护脚本 ==========

/**
 * 生成 WebRTC 泄露防护脚本
 *
 * 防止通过 WebRTC 泄露真实 IP 地址
 *
 * @returns JavaScript 代码字符串
 */
export function generateWebRTCProtectionScript(): string {
  return `
  // WebRTC 泄露防护
  (function() {
    if (typeof RTCPeerConnection === 'undefined') return;

    const OriginalRTCPeerConnection = RTCPeerConnection;

    window.RTCPeerConnection = function(config, constraints) {
      // 强制使用 relay 模式
      if (config && config.iceServers) {
        config.iceTransportPolicy = 'relay';
      }

      const pc = new OriginalRTCPeerConnection(config, constraints);

      // 过滤包含真实 IP 的候选者
      const originalCreateOffer = pc.createOffer.bind(pc);
      pc.createOffer = function(options) {
        return originalCreateOffer(options).then(function(offer) {
          if (offer.sdp) {
            offer.sdp = offer.sdp.replace(/a=candidate:.*typ host.*/g, '');
            offer.sdp = offer.sdp.replace(/a=candidate:.*typ srflx.*/g, '');
          }
          return offer;
        });
      };

      return pc;
    };

    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

    // 处理旧版 API
    if (typeof webkitRTCPeerConnection !== 'undefined') {
      window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }
  })();
  `;
}

// ========== Canvas 噪声脚本 ==========

/**
 * 生成 Canvas 噪声注入脚本
 *
 * 使用基于 canvas 内容的确定性哈希生成一致的噪声
 *
 * @returns JavaScript 代码字符串
 */
export function generateCanvasNoiseScript(noiseLevel?: number): string {
  const resolvedNoiseLevel = Number.isFinite(noiseLevel)
    ? Math.max(0, Math.min(1, noiseLevel as number))
    : 0.1;
  const delta = Math.max(1, Math.round(resolvedNoiseLevel * 10));
  return `
  // Canvas 噪声注入（确定性）
  (function() {
    const __airpaCanvasNoiseDelta = ${delta};
    // 哈希函数（djb2）
    function hashPixels(pixels) {
      let hash = 5381;
      for (let i = 0; i < pixels.length; i += 400) {
        hash = ((hash << 5) + hash) + pixels[i];
        hash = hash & hash;
      }
      return Math.abs(hash);
    }

    // 基于种子的伪随机数生成器
    function seededRandom(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    // 添加确定性噪声到 ImageData
    function addNoiseToImageData(imageData) {
      const pixels = imageData.data;
      const seed = hashPixels(pixels);
      const random = seededRandom(seed);

      const noisyData = new Uint8ClampedArray(pixels);
      for (let i = 0; i < noisyData.length; i += 4) {
        noisyData[i] = Math.max(0, Math.min(255, noisyData[i] + (random() > 0.5 ? __airpaCanvasNoiseDelta : -__airpaCanvasNoiseDelta)));
        noisyData[i + 1] = Math.max(0, Math.min(255, noisyData[i + 1] + (random() > 0.5 ? __airpaCanvasNoiseDelta : -__airpaCanvasNoiseDelta)));
        noisyData[i + 2] = Math.max(0, Math.min(255, noisyData[i + 2] + (random() > 0.5 ? __airpaCanvasNoiseDelta : -__airpaCanvasNoiseDelta)));
      }

      return new ImageData(noisyData, imageData.width, imageData.height);
    }

    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    // 覆盖 getImageData：部分站点直接用像素数据做指纹，不会走 toDataURL/toBlob
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const imageData = originalGetImageData.apply(this, args);
      try {
        return addNoiseToImageData(imageData);
      } catch (_e) {
        return imageData;
      }
    };

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const context = this.getContext('2d');
      if (context && this.width > 0 && this.height > 0) {
        try {
          const imageData = originalGetImageData.call(context, 0, 0, this.width, this.height);
          const noisyImageData = addNoiseToImageData(imageData);

          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = this.width;
          tempCanvas.height = this.height;
          const tempContext = tempCanvas.getContext('2d');
          tempContext.putImageData(noisyImageData, 0, 0);

          return originalToDataURL.apply(tempCanvas, args);
        } catch (e) {
          // 跨域 canvas 无法获取图像数据
        }
      }
      return originalToDataURL.apply(this, args);
    };

    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      const context = this.getContext('2d');
      if (context && this.width > 0 && this.height > 0) {
        try {
          const imageData = originalGetImageData.call(context, 0, 0, this.width, this.height);
          const noisyImageData = addNoiseToImageData(imageData);

          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = this.width;
          tempCanvas.height = this.height;
          const tempContext = tempCanvas.getContext('2d');
          tempContext.putImageData(noisyImageData, 0, 0);

          return originalToBlob.call(tempCanvas, callback, ...args);
        } catch (e) {
          // 跨域 canvas 无法获取图像数据
        }
      }
      return originalToBlob.call(this, callback, ...args);
    };

    // OffscreenCanvas.convertToBlob：更隐蔽的 canvas 指纹路径
    try {
      if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas && OffscreenCanvas.prototype) {
        const originalConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
        if (typeof originalConvertToBlob === 'function') {
          OffscreenCanvas.prototype.convertToBlob = function(...args) {
            try {
              const context = this.getContext && this.getContext('2d');
              if (context && this.width > 0 && this.height > 0) {
                const imageData = originalGetImageData.call(context, 0, 0, this.width, this.height);
                const noisyImageData = addNoiseToImageData(imageData);

                const tempCanvas = new OffscreenCanvas(this.width, this.height);
                const tempContext = tempCanvas.getContext('2d');
                if (tempContext) {
                  tempContext.putImageData(noisyImageData, 0, 0);
                  return originalConvertToBlob.apply(tempCanvas, args);
                }
              }
            } catch (_e) {}
            return originalConvertToBlob.apply(this, args);
          };
        }
      }
    } catch (_e) {}
  })();
  `;
}

// ========== Client Hints 脚本 ==========

/**
 * 生成 Client Hints API 伪装脚本
 *
 * @param fingerprint - 浏览器指纹配置
 * @returns JavaScript 代码字符串
 */
export function generateClientHintsScript(fingerprint: BrowserFingerprint): string {
  const metadata = buildUserAgentMetadata(fingerprint);

  const chromiumMajor = metadata.brands.find((b) => b.brand === 'Chromium')?.version || '120';
  const primaryBrand =
    metadata.brands.find((b) => b.brand !== 'Not_A Brand' && b.brand !== 'Chromium')?.brand ||
    'Google Chrome';
  const primaryMajor =
    metadata.brands.find((b) => b.brand === primaryBrand)?.version || chromiumMajor;

  const platform = metadata.platform;
  const platformVersion = metadata.platformVersion;

  return `
  // Client Hints API 伪装
  (function() {
    if (!('userAgentData' in navigator)) return;

    const brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '${chromiumMajor}' },
      { brand: '${primaryBrand}', version: '${primaryMajor}' },
    ];

    const fullVersionList = ${JSON.stringify(metadata.fullVersionList)};

    const userAgentData = {
      brands: brands,
      mobile: ${metadata.mobile ? 'true' : 'false'},
      platform: '${platform}',
      getHighEntropyValues: function(hints) {
        const result = {
          brands: brands,
          mobile: ${metadata.mobile ? 'true' : 'false'},
          platform: '${platform}',
          platformVersion: '${platformVersion}',
          architecture: '${metadata.architecture}',
          bitness: '${metadata.bitness}',
          model: '',
          wow64: ${metadata.wow64 ? 'true' : 'false'},
          uaFullVersion: '${metadata.fullVersion}',
          fullVersionList: fullVersionList,
        };
        if (!Array.isArray(hints)) {
          return Promise.resolve(result);
        }
        const allowed = new Set(
          hints
            .map(function(h) { return String(h || '').trim(); })
            .filter(function(h) { return h.length > 0; })
        );
        const filtered = {};
        for (const key in result) {
          if (allowed.has(key)) {
            filtered[key] = result[key];
          }
        }
        return Promise.resolve(filtered);
      },
      toJSON: function() {
        return {
          brands: brands,
          mobile: ${metadata.mobile ? 'true' : 'false'},
          platform: '${platform}',
        };
      },
    };

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const getUserAgentData = function() { return userAgentData; };

    function tryDefine(target) {
      try {
        Object.defineProperty(target, 'userAgentData', {
          get: getUserAgentData,
          configurable: true,
          enumerable: true,
        });
        markNative(getUserAgentData, 'get userAgentData');
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
    patched = tryDefine(navigator) || patched;

    if (!patched) {
      try {
        const existing = navigator.userAgentData;
        if (existing) {
          if (typeof existing.getHighEntropyValues === 'function') {
            existing.getHighEntropyValues = userAgentData.getHighEntropyValues;
          }
          if (typeof existing.toJSON === 'function') {
            existing.toJSON = userAgentData.toJSON;
          }
        }
      } catch (_e) {}
    }

    markNative(userAgentData.getHighEntropyValues, 'getHighEntropyValues');
    markNative(userAgentData.toJSON, 'toJSON');
  })();
  `;
}

// ========== Chrome 对象注入脚本 ==========

/**
 * 生成 Chrome 对象注入脚本
 *
 * 注入完整的 chrome 对象结构，避免被检测为非 Chrome 浏览器
 *
 * @param seed - 随机种子（用于生成确定性时间值）
 * @returns JavaScript 代码字符串
 */
export function generateChromeObjectScript(seed: number): string {
  // 使用种子生成确定性的时间偏移
  const random = createSeededRandom(seed);
  const timeOffsets = {
    request: Math.round(random() * 10 * 1000) / 1000,
    startLoad: Math.round(random() * 5 * 1000) / 1000,
    commit: Math.round(random() * 3 * 1000) / 1000,
    finishDoc: Math.round(random() * 2 * 1000) / 1000,
    finish: Math.round(random() * 1000) / 1000,
    firstPaint: Math.round(random() * 1000) / 1000,
    csiStart: Math.round(random() * 1000),
    csiOnload: Math.round(random() * 500),
    csiPage: Math.round(random() * 300),
  };

  return `
  // Chrome 对象注入
  (function() {
    if (!window.chrome) {
      window.chrome = {};
    }

    // chrome.runtime
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      };
    }

    // chrome.loadTimes()（确定性值）
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        const now = Date.now() / 1000;
        return {
          requestTime: now - ${timeOffsets.request},
          startLoadTime: now - ${timeOffsets.startLoad},
          commitLoadTime: now - ${timeOffsets.commit},
          finishDocumentLoadTime: now - ${timeOffsets.finishDoc},
          finishLoadTime: now - ${timeOffsets.finish},
          firstPaintTime: now - ${timeOffsets.firstPaint},
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      };
    }

    // chrome.csi()（确定性值）
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        const now = Date.now();
        return {
          startE: now - ${timeOffsets.csiStart},
          onloadT: now - ${timeOffsets.csiOnload},
          pageT: now - ${timeOffsets.csiPage},
          tran: 15,
        };
      };
    }

    // chrome.app
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
  })();
  `;
}

// ========== 函数原型保护脚本 ==========

/**
 * 生成函数原型保护脚本
 *
 * 修复被覆写函数的 toString() 返回值，使其看起来像原生函数
 *
 * @returns JavaScript 代码字符串
 */
export function generateFunctionPrototypeScript(): string {
  return `
  // 函数原型保护
  (function() {
    const nativeToString = Function.prototype.toString;
    const spoofedFunctions = new WeakMap();

    Function.prototype.toString = function() {
      if (spoofedFunctions.has(this)) {
        return spoofedFunctions.get(this);
      }
      return nativeToString.call(this);
    };

    // 标记函数为"原生"
    window.__markAsNative = function(fn, name) {
      spoofedFunctions.set(fn, 'function ' + name + '() { [native code] }');
    };

    // 修复 Object.getOwnPropertyDescriptor 检测（确保 getter/function 显示为原生）
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = function(obj, prop) {
      const desc = originalGetOwnPropertyDescriptor.call(this, obj, prop);
      try {
        if (desc && typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          if (typeof desc.get === 'function') {
            window.__markAsNative(desc.get, 'get ' + String(prop));
          }
          if (typeof desc.value === 'function') {
            window.__markAsNative(desc.value, String(prop));
          }
        }
      } catch (_e) {}
      return desc;
    };

    try {
      if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
        window.__markAsNative(Object.getOwnPropertyDescriptor, 'getOwnPropertyDescriptor');
      }
    } catch (_e) {}
  })();
  `;
}

// ========== Console 调试输出伪装 ==========

/**
 * 生成 console.debug 伪装脚本
 *
 * 避免调试器检测通过 console.debug(Error) 触发 stack getter
 *
 * @returns JavaScript 代码字符串
 */
export function generateConsoleStealthScript(): string {
  return `
  // Console debug 伪装
  (function() {
    let patched = false;
    let baseDebug = null;
    let wrappedDebug = null;

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function buildWrapper(target) {
      const wrapped = function() {
        try {
          const args = Array.prototype.slice.call(arguments);
          if (args.length > 0) {
            const mapped = new Array(args.length);
            for (let i = 0; i < args.length; i++) {
              const arg = args[i];
              try {
                if (arg && typeof arg === 'object' && 'stack' in arg) {
                  try {
                    Object.defineProperty(arg, 'stack', {
                      value: '',
                      configurable: true,
                      writable: false,
                    });
                  } catch (_e) {}
                  mapped[i] = String(arg);
                  continue;
                }
              } catch (_e) {}
              mapped[i] = arg;
            }
            return target.apply(this, mapped);
          }
        } catch (_e) {}
        return target.apply(this, arguments);
      };
      markNative(wrapped, 'debug');
      return wrapped;
    }

    function installWrapper(next) {
      const target = typeof next === 'function' ? next : baseDebug;
      wrappedDebug = buildWrapper(target);
    }

    function tryPatch() {
      if (patched) return true;
      if (!window.console || typeof window.console.debug !== 'function') return false;
      baseDebug = window.console.debug;
      installWrapper(baseDebug);
      try {
        Object.defineProperty(window.console, 'debug', {
          configurable: true,
          enumerable: true,
          get: function() { return wrappedDebug; },
          set: function(next) { installWrapper(next); },
        });
      } catch (_e) {
        try {
          window.console.debug = wrappedDebug;
        } catch (_e2) {}
      }
      patched = true;
      return true;
    }

    if (!tryPatch()) {
      let timer = null;
      const retry = function() {
        if (tryPatch() && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      timer = setInterval(retry, 50);
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('load', function() {
          retry();
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        });
      }
    }
  })();
  `;
}

// ========== Worker 调试检测伪装 ==========

/**
 * 生成 Worker 调试检测绕过脚本
 *
 * 针对包含 debugger 语句的检测用 Worker，返回快速 before/after
 *
 * @returns JavaScript 代码字符串
 */
export function generateWorkerStealthScript(): string {
  return `
  // Worker 调试检测绕过
  (function() {
    const beforeMessage = 'before';
    const afterMessage = 'after';

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const OriginalBlob = window.Blob;
    const OriginalWorker = window.Worker;
    const originalCreateObjectURL =
      window.URL && typeof window.URL.createObjectURL === 'function'
        ? window.URL.createObjectURL
        : null;
    const originalRevokeObjectURL =
      window.URL && typeof window.URL.revokeObjectURL === 'function'
        ? window.URL.revokeObjectURL
        : null;

    const blobFlags = typeof WeakMap === 'function' ? new WeakMap() : null;
    const urlFlags = typeof Map === 'function' ? new Map() : null;

    function isSuspiciousScript(text) {
      if (!text) return false;
      return /\\bdebugger\\b/.test(text) && text.indexOf(beforeMessage) !== -1 && text.indexOf(afterMessage) !== -1;
    }

    function tryMarkBlob(blob, parts) {
      if (!blobFlags || !parts) return;
      try {
        let text = '';
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (typeof part === 'string') {
            text += part;
            if (text.length > 20000) break;
          }
        }
        if (isSuspiciousScript(text)) {
          blobFlags.set(blob, true);
        }
      } catch (_e) {}
    }

    if (typeof OriginalBlob === 'function') {
      const WrappedBlob = function(parts, options) {
        const blob = new OriginalBlob(parts || [], options || {});
        tryMarkBlob(blob, parts);
        return blob;
      };
      WrappedBlob.prototype = OriginalBlob.prototype;
      try {
        Object.setPrototypeOf(WrappedBlob, OriginalBlob);
      } catch (_e) {}
      window.Blob = WrappedBlob;
      markNative(WrappedBlob, 'Blob');
    }

    if (originalCreateObjectURL) {
      window.URL.createObjectURL = function(obj) {
        const url = originalCreateObjectURL.call(this, obj);
        try {
          if (urlFlags && blobFlags && obj && blobFlags.get(obj)) {
            urlFlags.set(url, true);
          }
        } catch (_e) {}
        return url;
      };
      markNative(window.URL.createObjectURL, 'createObjectURL');
    }

    if (originalRevokeObjectURL) {
      window.URL.revokeObjectURL = function(url) {
        try {
          if (urlFlags) {
            urlFlags.delete(url);
          }
        } catch (_e) {}
        return originalRevokeObjectURL.call(this, url);
      };
      markNative(window.URL.revokeObjectURL, 'revokeObjectURL');
    }

    function createFakeWorker() {
      let terminated = false;
      const messageListeners = [];
      const errorListeners = [];

      function emitMessage(data) {
        const event = { data: data };
        if (typeof fake.onmessage === 'function') {
          try {
            fake.onmessage.call(fake, event);
          } catch (_e) {}
        }
        for (let i = 0; i < messageListeners.length; i++) {
          const listener = messageListeners[i];
          try {
            listener.call(fake, event);
          } catch (_e) {}
        }
      }

      function emitError(error) {
        if (typeof fake.onerror === 'function') {
          try {
            fake.onerror.call(fake, error);
          } catch (_e) {}
        }
        for (let i = 0; i < errorListeners.length; i++) {
          const listener = errorListeners[i];
          try {
            listener.call(fake, error);
          } catch (_e) {}
        }
      }

      const fake = {
        onmessage: null,
        onerror: null,
        postMessage: function() {
          if (terminated) return;
          setTimeout(function() {
            if (!terminated) emitMessage(beforeMessage);
          }, 0);
          setTimeout(function() {
            if (!terminated) emitMessage(afterMessage);
          }, 0);
        },
        terminate: function() {
          terminated = true;
          messageListeners.length = 0;
          errorListeners.length = 0;
        },
        addEventListener: function(type, listener) {
          if (typeof listener !== 'function') return;
          if (type === 'message') {
            if (messageListeners.indexOf(listener) === -1) {
              messageListeners.push(listener);
            }
          } else if (type === 'error') {
            if (errorListeners.indexOf(listener) === -1) {
              errorListeners.push(listener);
            }
          }
        },
        removeEventListener: function(type, listener) {
          if (type === 'message') {
            const index = messageListeners.indexOf(listener);
            if (index !== -1) messageListeners.splice(index, 1);
          } else if (type === 'error') {
            const index = errorListeners.indexOf(listener);
            if (index !== -1) errorListeners.splice(index, 1);
          }
        },
        dispatchEvent: function() { return true; },
      };

      markNative(fake.postMessage, 'postMessage');
      markNative(fake.terminate, 'terminate');
      markNative(fake.addEventListener, 'addEventListener');
      markNative(fake.removeEventListener, 'removeEventListener');
      markNative(fake.dispatchEvent, 'dispatchEvent');

      try {
        if (OriginalWorker && OriginalWorker.prototype) {
          Object.setPrototypeOf(fake, OriginalWorker.prototype);
        }
      } catch (_e) {}

      return fake;
    }

    if (typeof OriginalWorker === 'function') {
      const WrappedWorker = function(scriptURL, options) {
        try {
          if (typeof scriptURL === 'string' && urlFlags && urlFlags.get(scriptURL)) {
            return createFakeWorker();
          }
        } catch (_e) {}
        return new OriginalWorker(scriptURL, options);
      };
      WrappedWorker.prototype = OriginalWorker.prototype;
      try {
        Object.setPrototypeOf(WrappedWorker, OriginalWorker);
      } catch (_e) {}
      window.Worker = WrappedWorker;
      markNative(WrappedWorker, 'Worker');
    }
  })();
  `;
}

// ========== 合并脚本 ==========

/**
 * 合并多个脚本片段为单个脚本
 *
 * @param scripts - 脚本片段数组
 * @returns 合并后的脚本
 */
export function combineScripts(scripts: string[]): string {
  return scripts.filter(Boolean).join('\n');
}

// ========== 鼠标事件模拟脚本 ==========

/**
 * 生成鼠标事件模拟脚本
 *
 * 抖音 a_bogus 签名算法会检测是否有真实的鼠标事件
 * 如果没有触发过鼠标事件，生成的签名是无效的（假值）
 * 必须触发至少一次 mousemove 事件才能通过验证
 *
 * @returns JavaScript 代码字符串
 */
export function generateMouseEventScript(): string {
  return `
  // 模拟鼠标事件（用于通过 a_bogus 签名验证）
  (function() {
    // 标记是否已触发过鼠标事件
    let mouseEventTriggered = false;

    // 创建并分发鼠标移动事件
    function triggerMouseEvent() {
      if (mouseEventTriggered) return;

      try {
        // 创建多个鼠标事件以模拟真实用户行为
        const events = ['mousemove', 'mouseenter', 'mouseover'];

        events.forEach(function(eventType, index) {
          const event = new MouseEvent(eventType, {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: 100 + Math.random() * 200,
            clientY: 100 + Math.random() * 200,
            screenX: 100 + Math.random() * 200,
            screenY: 100 + Math.random() * 200,
            movementX: Math.random() * 10,
            movementY: Math.random() * 10,
          });

          // 延迟触发以模拟真实行为
          setTimeout(function() {
            document.dispatchEvent(event);
            if (document.body) {
              document.body.dispatchEvent(event);
            }
          }, index * 50);
        });

        mouseEventTriggered = true;
      } catch (e) {
        // 静默失败
      }
    }

    // DOM 加载完成后触发
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', triggerMouseEvent);
    } else {
      // DOM 已加载，延迟触发
      setTimeout(triggerMouseEvent, 100);
    }

    // 也在 load 事件时触发（双重保险）
    window.addEventListener('load', function() {
      setTimeout(triggerMouseEvent, 200);
    });
  })();
  `;
}

/**
 * 包装脚本为 IIFE 并添加严格模式
 *
 * @param script - 原始脚本
 * @returns 包装后的脚本
 */
export function wrapScript(script: string): string {
  return `(function() {\n'use strict';\n${script}\n})();`;
}

// ========== 触摸支持脚本 ==========

/**
 * 生成触摸支持伪装脚本
 *
 * 伪装 navigator.maxTouchPoints 和触摸相关属性
 *
 * @param maxTouchPoints - 最大触摸点数
 * @returns JavaScript 代码字符串
 */
export function generateTouchSupportScript(maxTouchPoints: number): string {
  const resolvedTouchPoints = Number.isFinite(maxTouchPoints)
    ? Math.max(0, Math.floor(maxTouchPoints))
    : 0;
  return `
  // 触摸支持伪装
  (function() {
    const touchPoints = ${resolvedTouchPoints};

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

    // 伪装 navigator.maxTouchPoints
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        tryDefine(proto, 'maxTouchPoints', function() { return touchPoints; });
      }
    } catch (_e) {}
    tryDefine(navigator, 'maxTouchPoints', function() { return touchPoints; });

    // 伪装 navigator.msMaxTouchPoints（IE/Edge）
    if ('msMaxTouchPoints' in navigator) {
      try {
        const proto = Object.getPrototypeOf(navigator);
        if (proto) {
          tryDefine(proto, 'msMaxTouchPoints', function() { return touchPoints; });
        }
      } catch (_e) {}
      tryDefine(navigator, 'msMaxTouchPoints', function() { return touchPoints; });
    }

    // 伪装 'ontouchstart' in window 检测
    if (touchPoints > 0) {
      if (!('ontouchstart' in window)) {
        window.ontouchstart = null;
      }
    } else {
      // 移除触摸支持特征
      if ('ontouchstart' in window) {
        try {
          delete window.ontouchstart;
        } catch (_e) {
          try {
            Object.defineProperty(window, 'ontouchstart', {
              value: undefined,
              configurable: true,
              enumerable: true,
              writable: true,
            });
          } catch (_e2) {}
        }
      }
    }
  })();
  `;
}

// ========== 字体列表脚本 ==========

/**
 * 生成字体列表伪装脚本
 *
 * 通过 CSS FontFace API 和 document.fonts 限制可检测的字体列表
 *
 * @param fonts - 允许的字体列表
 * @returns JavaScript 代码字符串
 */
export function generateFontsScript(fonts: string[]): string {
  const fontsJson = JSON.stringify(fonts);

  return `
  // 字体列表伪装
  (function() {
    const allowedFonts = new Set(${fontsJson});

    // 伪装 document.fonts.check()
    if (document.fonts && document.fonts.check) {
      const originalCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        // 解析字体族名称
        const fontFamily = font.split(',')[0].trim().replace(/['"]/g, '');

        // 只对允许列表中的字体返回 true
        if (allowedFonts.has(fontFamily)) {
          return originalCheck(font, text);
        }

        // 对于系统默认字体也返回 true
        const systemFonts = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'];
        if (systemFonts.includes(fontFamily.toLowerCase())) {
          return originalCheck(font, text);
        }

        // 其他字体返回 false
        return false;
      };
    }

    // 伪装基于 Canvas 的字体检测
    // 通过限制 measureText 的差异来减少可检测的字体数量
    const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(text) {
      const result = originalMeasureText.call(this, text);

      // 获取当前字体
      const currentFont = this.font || '';
      const fontFamily = currentFont.split(',')[0].split(' ').pop()?.replace(/['"]/g, '') || '';

      // 如果字体不在允许列表中，返回默认字体的测量值
      if (fontFamily && !allowedFonts.has(fontFamily)) {
        const systemFonts = ['serif', 'sans-serif', 'monospace'];
        if (!systemFonts.includes(fontFamily.toLowerCase())) {
          // 使用 sans-serif 作为后备
          const originalFont = this.font;
          this.font = this.font.replace(fontFamily, 'sans-serif');
          const fallbackResult = originalMeasureText.call(this, text);
          this.font = originalFont;
          return fallbackResult;
        }
      }

      return result;
    };
  })();
  `;
}
