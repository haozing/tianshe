/**
 * shared-scripts.ts 单元测试
 *
 * 测试共享脚本生成模块的各个函数
 */

import { describe, it, expect } from 'vitest';
import {
  createSeededRandom,
  hashString,
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
  combineScripts,
  wrapScript,
} from './shared-scripts';
import type { BrowserFingerprint } from './types';

describe('共享脚本生成模块', () => {
  // ========== 工具函数测试 ==========

  describe('createSeededRandom', () => {
    it('应该生成确定性的随机数序列', () => {
      // 使用相同种子的两个随机数生成器
      const random1 = createSeededRandom(12345);
      const random2 = createSeededRandom(12345);

      // 生成多个随机数
      const sequence1 = Array.from({ length: 10 }, () => random1());
      const sequence2 = Array.from({ length: 10 }, () => random2());

      // 序列应该完全相同
      expect(sequence1).toEqual(sequence2);
    });

    it('应该生成 0-1 之间的随机数', () => {
      const random = createSeededRandom(12345);

      for (let i = 0; i < 100; i++) {
        const value = random();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    it('不同种子应该产生不同的序列', () => {
      const random1 = createSeededRandom(12345);
      const random2 = createSeededRandom(54321);

      const sequence1 = Array.from({ length: 10 }, () => random1());
      const sequence2 = Array.from({ length: 10 }, () => random2());

      // 序列不应该完全相同
      expect(sequence1).not.toEqual(sequence2);
    });

    it('同一生成器应该产生不重复的值', () => {
      const random = createSeededRandom(12345);
      const sequence = Array.from({ length: 100 }, () => random());

      // 至少应该有多个不同的值（不是所有值都相同）
      const uniqueValues = new Set(sequence);
      expect(uniqueValues.size).toBeGreaterThan(10);
    });
  });

  describe('hashString', () => {
    it('应该为相同字符串返回相同的哈希值', () => {
      const str = 'test-string-123';
      const hash1 = hashString(str);
      const hash2 = hashString(str);

      expect(hash1).toBe(hash2);
    });

    it('应该为不同字符串返回不同的哈希值', () => {
      const hash1 = hashString('string1');
      const hash2 = hashString('string2');
      const hash3 = hashString('completely-different');

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });

    it('应该返回正整数', () => {
      const testStrings = ['hello', 'world', '12345', 'special-chars-!@#$%', '中文字符', ''];

      testStrings.forEach((str) => {
        const hash = hashString(str);
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(hash)).toBe(true);
      });
    });

    it('空字符串应该返回固定哈希值', () => {
      const hash1 = hashString('');
      const hash2 = hashString('');

      expect(hash1).toBe(hash2);
      expect(hash1).toBe(5381); // djb2 算法的初始值
    });

    it('哈希值应该对字符顺序敏感', () => {
      const hash1 = hashString('abc');
      const hash2 = hashString('cba');

      expect(hash1).not.toBe(hash2);
    });
  });

  // ========== WebGL 脚本测试 ==========

  describe('generateWebGLScript', () => {
    it('应该生成包含 WebGL 参数的脚本', () => {
      const webgl = {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti)',
        version: 'WebGL 1.0',
      };

      const script = generateWebGLScript(webgl);

      expect(script).toContain('WebGL 参数覆盖');
      expect(script).toContain(webgl.vendor);
      expect(script).toContain(webgl.renderer);
      expect(script).toContain(webgl.version);
    });

    it('应该覆盖 WebGLRenderingContext.prototype.getParameter', () => {
      const webgl = {
        vendor: 'Test Vendor',
        renderer: 'Test Renderer',
        version: 'WebGL 2.0',
      };

      const script = generateWebGLScript(webgl);

      expect(script).toContain('patchContext(WebGLRenderingContext');
      expect(script).toContain('proto.getParameter');
    });

    it('应该处理 WebGL 2.0', () => {
      const webgl = {
        vendor: 'Test',
        renderer: 'Test',
        version: 'WebGL 2.0',
      };

      const script = generateWebGLScript(webgl);

      expect(script).toContain('WebGL2RenderingContext');
      expect(script).toContain("patchContext(WebGL2RenderingContext.prototype, 'webgl2')");
    });

    it('应该包含 WebGL 能力参数映射', () => {
      const webgl = {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)',
        version: 'WebGL 1.0',
      };

      const script = generateWebGLScript(webgl);

      expect(script).toContain('MAX_TEXTURE_SIZE');
      expect(script).toContain('webglCaps');
      expect(script).toContain('maxTextureSize');
    });

    it('应该覆盖 WEBGL_debug_renderer_info 扩展', () => {
      const webgl = { vendor: 'Test', renderer: 'Test', version: 'WebGL 1.0' };
      const script = generateWebGLScript(webgl);

      expect(script).toContain("const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info'");
      expect(script).toContain('proto.getExtension');
      expect(script).toContain('UNMASKED_VENDOR_WEBGL');
      expect(script).toContain('UNMASKED_RENDERER_WEBGL');
    });

    it('应该把 WEBGL_debug_renderer_info 放进 getSupportedExtensions', () => {
      const webgl = { vendor: 'Test', renderer: 'Test', version: 'WebGL 1.0' };
      const script = generateWebGLScript(webgl);

      expect(script).toContain('proto.getSupportedExtensions');
      expect(script).toContain('getSupportedExtensions.call');
      expect(script).toContain('arr.push(DEBUG_RENDERER_INFO)');
    });

    it('启用 webglNoise 时应该覆盖 readPixels', () => {
      const webgl = { vendor: 'Test', renderer: 'Test', version: 'WebGL 1.0' };
      const script = generateWebGLScript(webgl, 12345);

      expect(script).toContain('readPixels');
      expect(script).toContain('noiseByteDelta');
    });

    it('应该正确转义特殊字符', () => {
      const webgl = {
        vendor: "Test's Vendor",
        renderer: "Renderer with 'quotes'",
        version: "Version 'special'",
      };

      const script = generateWebGLScript(webgl);

      // 单引号应该被转义
      expect(script).toContain("\\'");
      // 不应该包含未转义的单引号（除了 JS 语法中的）
      const vendorMatch = script.match(/VENDOR\]: '([^']+)'/);
      expect(vendorMatch).toBeTruthy();
    });
  });

  // ========== Webdriver 隐藏脚本测试 ==========

  describe('generateWebdriverHideScript', () => {
    it('应该生成隐藏 navigator.webdriver 的脚本', () => {
      const script = generateWebdriverHideScript();

      expect(script).toContain('navigator.webdriver');
      expect(script).toContain('delete navigator.webdriver');
      expect(script).toContain('Object.defineProperty');
    });

    it('应该将 webdriver 属性定义为 undefined', () => {
      const script = generateWebdriverHideScript();

      expect(script).toContain('get: () => undefined');
    });

    it('应该生成有效的 JavaScript 代码', () => {
      const script = generateWebdriverHideScript();

      // 不应该抛出语法错误
      expect(() => new Function(script)).not.toThrow();
    });
  });

  // ========== 自动化特征清理脚本测试 ==========

  describe('generateAutomationCleanupScript', () => {
    it('应该生成清理自动化工具特征的脚本', () => {
      const script = generateAutomationCleanupScript();

      expect(script).toContain('清理自动化工具特征');
      expect(script).toContain('automationObjects');
      expect(script).toContain('automationDocumentObjects');
    });

    it('应该包含常见自动化对象', () => {
      const script = generateAutomationCleanupScript();

      // 应该包含 Selenium 相关对象
      expect(script).toContain('domAutomation');
      expect(script).toContain('_selenium');
    });

    it('应该删除 window 对象上的自动化属性', () => {
      const script = generateAutomationCleanupScript();

      expect(script).toContain('delete window[obj]');
    });

    it('不应该处理 navigator.webdriver（由 generateWebdriverHideScript 单独处理）', () => {
      const script = generateAutomationCleanupScript();

      // navigator.webdriver 由 generateWebdriverHideScript 单独处理，避免重复
      expect(script).not.toContain('navigator.webdriver');
    });
  });

  // ========== 时区脚本测试 ==========

  describe('generateTimezoneScript', () => {
    it('应该生成时区伪装脚本', () => {
      const script = generateTimezoneScript('America/New_York');

      expect(script).toContain('时区伪装');
      expect(script).toContain('America/New_York');
      expect(script).toContain('Intl.DateTimeFormat');
    });

    it('应该包含时区偏移量', () => {
      const script = generateTimezoneScript('America/Los_Angeles');

      // 应该包含数值形式的偏移量
      expect(script).toMatch(/targetOffset\s*=\s*\d+/);
    });

    it('应该重写 Date.prototype.getTimezoneOffset', () => {
      const script = generateTimezoneScript('Asia/Tokyo');

      expect(script).toContain('Date.prototype.getTimezoneOffset');
      expect(script).toContain('return targetOffset');
    });

    it('应该重写 Date.prototype.toString', () => {
      const script = generateTimezoneScript('Europe/London');

      expect(script).toContain('Date.prototype.toString');
    });

    it('应该正确转义时区字符串', () => {
      const script = generateTimezoneScript("America/Test'Zone");

      expect(script).toContain("\\'");
    });

    it('对于未知时区应该使用默认值', () => {
      const script = generateTimezoneScript('Unknown/Timezone');

      // 应该不抛出错误
      expect(script).toBeTruthy();
      expect(script).toContain('Unknown/Timezone');
    });
  });

  // ========== Battery API 脚本测试 ==========

  describe('generateBatteryScript', () => {
    it('应该生成 Battery API 伪装脚本', () => {
      const script = generateBatteryScript(12345);

      expect(script).toContain('Battery API 伪装');
      expect(script).toContain('navigator.getBattery');
    });

    it('应该生成确定性的电池状态', () => {
      const script1 = generateBatteryScript(12345);
      const script2 = generateBatteryScript(12345);

      // 相同种子应该生成相同的脚本
      expect(script1).toBe(script2);
    });

    it('不同种子应该生成不同的电池状态', () => {
      const script1 = generateBatteryScript(12345);
      const script2 = generateBatteryScript(54321);

      // 不同种子应该生成不同的脚本
      expect(script1).not.toBe(script2);
    });

    it('应该包含电池属性', () => {
      const script = generateBatteryScript(12345);

      expect(script).toContain('charging');
      expect(script).toContain('chargingTime');
      expect(script).toContain('dischargingTime');
      expect(script).toContain('level');
    });

    it('电池电量应该在 50%-100% 范围内', () => {
      // 通过正则提取 level 值
      const script = generateBatteryScript(12345);
      const levelMatch = script.match(/level:\s*([\d.]+)/);

      expect(levelMatch).toBeTruthy();
      if (levelMatch) {
        const level = parseFloat(levelMatch[1]);
        expect(level).toBeGreaterThanOrEqual(0.5);
        expect(level).toBeLessThanOrEqual(1);
      }
    });
  });

  // ========== AudioContext 脚本测试 ==========

  describe('generateAudioContextScript', () => {
    it('应该生成 AudioContext 指纹防护脚本', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toContain('AudioContext 指纹防护');
      expect(script).toContain('AudioContext');
    });

    it('应该包含伪随机数生成器', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toContain('seededRandom');
      expect(script).toContain('0x6D2B79F5');
    });

    it('应该覆盖 AudioBuffer.prototype.getChannelData', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toContain('AudioBuffer.prototype.getChannelData');
      expect(script).toContain('originalGetChannelData');
    });

    it('应该覆盖 AnalyserNode', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toContain('createAnalyser');
      expect(script).toContain('getFloatFrequencyData');
    });

    it('应该覆盖 AnalyserNode 的 byte/time 域方法', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toContain('getByteFrequencyData');
      expect(script).toContain('getByteTimeDomainData');
      expect(script).toContain('getFloatTimeDomainData');
    });

    it('应该兼容 OfflineAudioContext', () => {
      const script = generateAudioContextScript(12345);
      expect(script).toContain('OfflineAudioContext');
    });

    it('应该使用种子生成噪声', () => {
      const script = generateAudioContextScript(12345);

      expect(script).toMatch(/seededRandom\(12345\)/);
      // 脚本中使用 seed 派生表达式，而不是硬编码的值
      expect(script).toMatch(/seededRandom\(12345 \+ seedOffset\)/);
    });

    it('不同种子应该在脚本中使用不同的值', () => {
      const script1 = generateAudioContextScript(12345);
      const script2 = generateAudioContextScript(99999);

      expect(script1).toContain('12345');
      expect(script2).toContain('99999');
      expect(script1).not.toContain('99999');
    });

    it('应该把 noiseLevel 映射到脚本噪声幅度', () => {
      const script = generateAudioContextScript(12345, 0.02);
      expect(script).toContain('const __airpaAudioNoiseLevel = 0.02;');
      expect(script).toContain('const __airpaAudioChannelAmp = 0.0002;');
      expect(script).toContain('const __airpaAudioFreqAmp = 0.2;');
    });
  });

  // ========== WebRTC 防护脚本测试 ==========

  describe('generateWebRTCProtectionScript', () => {
    it('应该生成 WebRTC 泄露防护脚本', () => {
      const script = generateWebRTCProtectionScript();

      expect(script).toContain('WebRTC 泄露防护');
      expect(script).toContain('RTCPeerConnection');
    });

    it('应该强制使用 relay 模式', () => {
      const script = generateWebRTCProtectionScript();

      expect(script).toContain('iceTransportPolicy');
      expect(script).toContain('relay');
    });

    it('应该过滤 ICE 候选者', () => {
      const script = generateWebRTCProtectionScript();

      expect(script).toContain('createOffer');
      expect(script).toContain('typ host');
      expect(script).toContain('typ srflx');
    });

    it('应该处理旧版 webkitRTCPeerConnection', () => {
      const script = generateWebRTCProtectionScript();

      expect(script).toContain('webkitRTCPeerConnection');
    });

    it('应该生成有效的 JavaScript 代码', () => {
      const script = generateWebRTCProtectionScript();

      expect(() => new Function(script)).not.toThrow();
    });
  });

  // ========== Canvas 噪声脚本测试 ==========

  describe('generateCanvasNoiseScript', () => {
    it('应该生成 Canvas 噪声注入脚本', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('Canvas 噪声注入');
    });

    it('应该包含哈希函数', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('hashPixels');
      expect(script).toContain('5381'); // djb2 算法初始值
    });

    it('应该包含伪随机数生成器', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('seededRandom');
    });

    it('应该覆盖 HTMLCanvasElement.prototype.toDataURL', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('HTMLCanvasElement.prototype.toDataURL');
      expect(script).toContain('originalToDataURL');
    });

    it('应该覆盖 HTMLCanvasElement.prototype.toBlob', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('HTMLCanvasElement.prototype.toBlob');
      expect(script).toContain('originalToBlob');
    });

    it('应该覆盖 CanvasRenderingContext2D.prototype.getImageData', () => {
      const script = generateCanvasNoiseScript();
      expect(script).toContain('CanvasRenderingContext2D.prototype.getImageData');
    });

    it('应该覆盖 OffscreenCanvas.prototype.convertToBlob', () => {
      const script = generateCanvasNoiseScript();
      expect(script).toContain('OffscreenCanvas.prototype.convertToBlob');
    });

    it('应该处理跨域 canvas', () => {
      const script = generateCanvasNoiseScript();

      // 应该有 try-catch 处理跨域错误
      expect(script).toMatch(/try\s*\{[\s\S]*\}\s*catch/);
    });

    it('应该添加确定性噪声', () => {
      const script = generateCanvasNoiseScript();

      expect(script).toContain('addNoiseToImageData');
      expect(script).toContain('hashPixels');
    });

    it('应该把 noiseLevel 映射到像素扰动幅度', () => {
      const script = generateCanvasNoiseScript(0.2);
      expect(script).toContain('const __airpaCanvasNoiseDelta = 2;');
    });
  });

  // ========== Client Hints 脚本测试 ==========

  describe('generateClientHintsScript', () => {
    it('应该生成 Client Hints API 伪装脚本', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Win32',
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc.',
          renderer: 'ANGLE',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain('Client Hints API 伪装');
      expect(script).toContain('userAgentData');
    });

    it('应该从 User-Agent 中提取 Chrome 版本', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Chrome/120.0.0.0',
        platform: 'Win32',
        languages: ['en-US'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc.',
          renderer: 'ANGLE',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain("version: '120'");
    });

    it('应该根据 User-Agent 识别 Windows 平台', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
        platform: 'Win32',
        languages: ['en-US'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc.',
          renderer: 'ANGLE',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain("platform: 'Windows'");
    });

    it('应该根据 User-Agent 识别 macOS 平台', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120.0.0.0',
        platform: 'MacIntel',
        languages: ['en-US'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Apple',
          renderer: 'Apple GPU',
          version: 'WebGL 2.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain("platform: 'macOS'");
    });

    it('应该包含 brands 数组', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Chrome/120.0.0.0',
        platform: 'Win32',
        languages: ['en-US'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc.',
          renderer: 'ANGLE',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain('Not_A Brand');
      expect(script).toContain('Chromium');
      expect(script).toContain('Google Chrome');
    });

    it('应该包含 getHighEntropyValues 方法', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Chrome/120.0.0.0',
        platform: 'Win32',
        languages: ['en-US'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc.',
          renderer: 'ANGLE',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const script = generateClientHintsScript(fingerprint);

      expect(script).toContain('getHighEntropyValues');
      expect(script).toContain('platformVersion');
      expect(script).toContain('architecture');
      expect(script).toContain('bitness');
      expect(script).toContain('Array.isArray(hints)');
    });
  });

  // ========== Chrome 对象注入脚本测试 ==========

  describe('generateChromeObjectScript', () => {
    it('应该生成 Chrome 对象注入脚本', () => {
      const script = generateChromeObjectScript(12345);

      expect(script).toContain('Chrome 对象注入');
      expect(script).toContain('window.chrome');
    });

    it('应该生成确定性的时间值', () => {
      const script1 = generateChromeObjectScript(12345);
      const script2 = generateChromeObjectScript(12345);

      expect(script1).toBe(script2);
    });

    it('不同种子应该生成不同的时间值', () => {
      const script1 = generateChromeObjectScript(12345);
      const script2 = generateChromeObjectScript(54321);

      expect(script1).not.toBe(script2);
    });

    it('应该包含 chrome.runtime', () => {
      const script = generateChromeObjectScript(12345);

      expect(script).toContain('chrome.runtime');
      expect(script).toContain('PlatformOs');
      expect(script).toContain('PlatformArch');
    });

    it('应该包含 chrome.loadTimes', () => {
      const script = generateChromeObjectScript(12345);

      expect(script).toContain('chrome.loadTimes');
      expect(script).toContain('requestTime');
      expect(script).toContain('startLoadTime');
    });

    it('应该包含 chrome.csi', () => {
      const script = generateChromeObjectScript(12345);

      expect(script).toContain('chrome.csi');
      expect(script).toContain('startE');
      expect(script).toContain('onloadT');
    });

    it('应该包含 chrome.app', () => {
      const script = generateChromeObjectScript(12345);

      expect(script).toContain('chrome.app');
      expect(script).toContain('isInstalled');
      expect(script).toContain('InstallState');
    });
  });

  // ========== 函数原型保护脚本测试 ==========

  describe('generateFunctionPrototypeScript', () => {
    it('应该生成函数原型保护脚本', () => {
      const script = generateFunctionPrototypeScript();

      expect(script).toContain('函数原型保护');
      expect(script).toContain('Function.prototype.toString');
    });

    it('应该使用 WeakMap 存储被欺骗的函数', () => {
      const script = generateFunctionPrototypeScript();

      expect(script).toContain('WeakMap');
      expect(script).toContain('spoofedFunctions');
    });

    it('应该提供 __markAsNative 函数', () => {
      const script = generateFunctionPrototypeScript();

      expect(script).toContain('__markAsNative');
      expect(script).toContain('[native code]');
    });

    it('应该修复 Object.getOwnPropertyDescriptor', () => {
      const script = generateFunctionPrototypeScript();

      expect(script).toContain('Object.getOwnPropertyDescriptor');
      expect(script).toContain('desc.get');
      expect(script).toContain('desc.value');
    });

    it('应该标记 getter 和函数为原生', () => {
      const script = generateFunctionPrototypeScript();

      expect(script).toContain('__markAsNative');
      expect(script).toContain("'get ' + String(prop)");
    });
  });

  // ========== 合并脚本测试 ==========

  describe('combineScripts', () => {
    it('应该将多个脚本合并为一个', () => {
      const scripts = [
        '// Script 1\nconst a = 1;',
        '// Script 2\nconst b = 2;',
        '// Script 3\nconst c = 3;',
      ];

      const combined = combineScripts(scripts);

      expect(combined).toContain('Script 1');
      expect(combined).toContain('Script 2');
      expect(combined).toContain('Script 3');
      expect(combined).toContain('const a = 1;');
      expect(combined).toContain('const b = 2;');
      expect(combined).toContain('const c = 3;');
    });

    it('应该用换行符分隔脚本', () => {
      const scripts = ['script1', 'script2', 'script3'];
      const combined = combineScripts(scripts);

      expect(combined).toBe('script1\nscript2\nscript3');
    });

    it('应该过滤掉空脚本', () => {
      const scripts = ['script1', '', null as any, undefined as any, 'script2'];
      const combined = combineScripts(scripts);

      expect(combined).toBe('script1\nscript2');
    });

    it('应该处理空数组', () => {
      const combined = combineScripts([]);

      expect(combined).toBe('');
    });

    it('应该处理只有一个脚本的情况', () => {
      const combined = combineScripts(['single-script']);

      expect(combined).toBe('single-script');
    });
  });

  // ========== 包装脚本测试 ==========

  describe('wrapScript', () => {
    it('应该将脚本包装为 IIFE', () => {
      const script = 'const x = 1;';
      const wrapped = wrapScript(script);

      expect(wrapped).toMatch(/^\(function\(\)\s*\{/);
      expect(wrapped).toMatch(/\}\)\(\);$/);
    });

    it('应该添加严格模式', () => {
      const script = 'const x = 1;';
      const wrapped = wrapScript(script);

      expect(wrapped).toContain("'use strict';");
    });

    it('应该包含原始脚本内容', () => {
      const script = 'console.log("test");';
      const wrapped = wrapScript(script);

      expect(wrapped).toContain(script);
    });

    it('应该生成有效的 JavaScript 代码', () => {
      const script = 'const x = 1; console.log(x);';
      const wrapped = wrapScript(script);

      // 不应该抛出语法错误
      expect(() => new Function(wrapped)).not.toThrow();
    });

    it('应该处理多行脚本', () => {
      const script = `
        const x = 1;
        const y = 2;
        console.log(x + y);
      `;
      const wrapped = wrapScript(script);

      expect(wrapped).toContain('const x = 1;');
      expect(wrapped).toContain('const y = 2;');
      expect(wrapped).toContain('console.log(x + y);');
    });

    it('应该处理空脚本', () => {
      const wrapped = wrapScript('');

      expect(wrapped).toBe("(function() {\n'use strict';\n\n})();");
    });
  });

  // ========== 集成测试 ==========

  describe('集成测试', () => {
    it('所有脚本生成函数应该返回有效的 JavaScript 代码', () => {
      const fingerprint: BrowserFingerprint = {
        userAgent: 'Chrome/120.0.0.0',
        platform: 'Win32',
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        webgl: {
          vendor: 'Google Inc. (NVIDIA)',
          renderer: 'ANGLE (NVIDIA)',
          version: 'WebGL 1.0',
        },
        plugins: [],
      };

      const scripts = [
        generateWebGLScript(fingerprint.webgl),
        generateWebdriverHideScript(),
        generateAutomationCleanupScript(),
        generateTimezoneScript(fingerprint.timezone),
        generateBatteryScript(12345),
        generateAudioContextScript(12345),
        generateWebRTCProtectionScript(),
        generateCanvasNoiseScript(),
        generateClientHintsScript(fingerprint),
        generateChromeObjectScript(12345),
        generateFunctionPrototypeScript(),
      ];

      // 所有脚本都应该是字符串
      scripts.forEach((script) => {
        expect(typeof script).toBe('string');
        expect(script.length).toBeGreaterThan(0);
      });

      // 合并所有脚本
      const combined = combineScripts(scripts);
      expect(combined).toBeTruthy();

      // 包装后的脚本应该是有效的 JavaScript
      const wrapped = wrapScript(combined);
      expect(() => new Function(wrapped)).not.toThrow();
    });

    it('应该能够组合多个脚本并包装', () => {
      const scripts = [
        generateWebdriverHideScript(),
        generateAutomationCleanupScript(),
        generateWebRTCProtectionScript(),
      ];

      const combined = combineScripts(scripts);
      const wrapped = wrapScript(combined);

      expect(wrapped).toContain('navigator.webdriver');
      expect(wrapped).toContain('automationObjects');
      expect(wrapped).toContain('RTCPeerConnection');
      expect(wrapped).toContain("'use strict';");
      expect(wrapped).toMatch(/^\(function\(\)/);
      expect(wrapped).toMatch(/\}\)\(\);$/);
    });
  });
});
