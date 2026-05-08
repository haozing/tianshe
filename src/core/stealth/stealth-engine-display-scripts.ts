import type { BrowserFingerprint } from './types';

export function generateScreenScript(fingerprint: BrowserFingerprint): string {
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
export function generateDiagnosticsScript(fingerprint: BrowserFingerprint): string {
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
export function generateSpeechSynthesisScript(): string {
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
