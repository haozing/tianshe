import {
  TIMEZONE_OFFSETS,
  AUTOMATION_WINDOW_OBJECTS,
  AUTOMATION_DOCUMENT_OBJECTS,
  DEFAULT_TIMEZONE,
} from './constants';
import type { BrowserFingerprint } from './types';
import { buildUserAgentMetadata } from './client-hints';
import { createSeededRandom } from './shared-scripts-utils';

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
