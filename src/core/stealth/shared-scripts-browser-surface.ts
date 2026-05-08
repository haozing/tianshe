import { createSeededRandom } from './shared-scripts-utils';

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
