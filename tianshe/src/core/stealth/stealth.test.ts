/**
 * Stealth 模块测试
 *
 * 测试覆盖：
 * - 指纹管理器核心功能
 * - 脚本生成确定性
 * - CDP 命令生成
 * - 常量和工具函数
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  // 指纹管理器
  createFingerprintManager,
  FingerprintManager,
  // 脚本生成
  generateFullStealthScript,
  generateStealthScript,
  // CDP
  generateCDPCommands,
  createCDPStealthSession,
  // 共享脚本
  generateWebGLScript,
  generateBatteryScript,
  generateAudioContextScript,
  createSeededRandom,
  hashString,
  // 常量
  WEBGL_PARAMS,
  TIMEZONE_OFFSETS,
  TIMEZONE_LOCATIONS,
  DEFAULT_CHROME_PLUGINS,
  DEFAULT_HARDWARE,
} from './index';
import type { BrowserFingerprint, StealthConfig } from './types';

// ========== 测试数据 ==========

const mockFingerprint: BrowserFingerprint = {
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
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
    version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  },
  plugins: [...DEFAULT_CHROME_PLUGINS],
  canvas: { noise: false },
};

// ========== 常量测试 ==========

describe('Constants', () => {
  describe('WEBGL_PARAMS', () => {
    it('should have correct WebGL parameter values', () => {
      expect(WEBGL_PARAMS.VERSION).toBe(7938);
      expect(WEBGL_PARAMS.UNMASKED_VENDOR_WEBGL).toBe(37445);
      expect(WEBGL_PARAMS.UNMASKED_RENDERER_WEBGL).toBe(37446);
    });
  });

  describe('TIMEZONE_OFFSETS', () => {
    it('should have common timezones', () => {
      expect(TIMEZONE_OFFSETS['America/New_York']).toBe(300);
      expect(TIMEZONE_OFFSETS['Asia/Shanghai']).toBe(-480);
      expect(TIMEZONE_OFFSETS['Europe/London']).toBe(0);
    });
  });

  describe('TIMEZONE_LOCATIONS', () => {
    it('should have location for each timezone', () => {
      expect(TIMEZONE_LOCATIONS['America/New_York']).toEqual({
        latitude: 40.7128,
        longitude: -74.006,
      });
      expect(TIMEZONE_LOCATIONS['Asia/Tokyo']).toEqual({
        latitude: 35.6762,
        longitude: 139.6503,
      });
    });
  });

  describe('DEFAULT_CHROME_PLUGINS', () => {
    it('should have PDF plugins', () => {
      expect(DEFAULT_CHROME_PLUGINS.length).toBeGreaterThan(0);
      expect(DEFAULT_CHROME_PLUGINS.some((p) => p.name.includes('PDF'))).toBe(true);
    });
  });

  describe('DEFAULT_HARDWARE', () => {
    it('should have reasonable default values', () => {
      expect(DEFAULT_HARDWARE.hardwareConcurrency).toBe(8);
      expect(DEFAULT_HARDWARE.deviceMemory).toBe(8);
      expect(DEFAULT_HARDWARE.screenResolution.width).toBe(1920);
      expect(DEFAULT_HARDWARE.screenResolution.height).toBe(1080);
      expect(DEFAULT_HARDWARE.colorDepth).toBe(24);
    });
  });
});

// ========== 工具函数测试 ==========

describe('Utility Functions', () => {
  describe('hashString', () => {
    it('should return consistent hash for same input', () => {
      const hash1 = hashString('test string');
      const hash2 = hashString('test string');
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different input', () => {
      const hash1 = hashString('test string 1');
      const hash2 = hashString('test string 2');
      expect(hash1).not.toBe(hash2);
    });

    it('should return a number', () => {
      const hash = hashString('any string');
      expect(typeof hash).toBe('number');
      expect(Number.isInteger(hash)).toBe(true);
    });
  });

  describe('createSeededRandom', () => {
    it('should return consistent sequence for same seed', () => {
      const random1 = createSeededRandom(12345);
      const random2 = createSeededRandom(12345);

      const values1 = [random1(), random1(), random1()];
      const values2 = [random2(), random2(), random2()];

      expect(values1).toEqual(values2);
    });

    it('should return different sequence for different seed', () => {
      const random1 = createSeededRandom(12345);
      const random2 = createSeededRandom(54321);

      expect(random1()).not.toBe(random2());
    });

    it('should return values between 0 and 1', () => {
      const random = createSeededRandom(12345);
      for (let i = 0; i < 100; i++) {
        const value = random();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });
});

// ========== 指纹管理器测试 ==========

describe('FingerprintManager', () => {
  let manager: FingerprintManager;

  beforeEach(() => {
    manager = createFingerprintManager();
  });

  describe('getFingerprint', () => {
    it('should return a valid fingerprint', () => {
      const fingerprint = manager.getFingerprint('test-partition');

      expect(fingerprint.userAgent).toBeDefined();
      expect(fingerprint.platform).toBeDefined();
      expect(fingerprint.languages).toBeInstanceOf(Array);
      expect(fingerprint.timezone).toBeDefined();
      expect(fingerprint.hardwareConcurrency).toBeGreaterThan(0);
      expect(fingerprint.deviceMemory).toBeGreaterThan(0);
      expect(fingerprint.screenResolution.width).toBeGreaterThan(0);
      expect(fingerprint.screenResolution.height).toBeGreaterThan(0);
      expect(fingerprint.webgl.vendor).toBeDefined();
      expect(fingerprint.webgl.renderer).toBeDefined();
      expect(fingerprint.plugins).toBeInstanceOf(Array);
    });

    it('should cache fingerprint for same partition', () => {
      const fp1 = manager.getFingerprint('test-partition');
      const fp2 = manager.getFingerprint('test-partition');

      expect(fp1).toBe(fp2); // Same reference
    });

    it('should generate different fingerprints for different partitions', () => {
      const fp1 = manager.getFingerprint('partition-1');
      const fp2 = manager.getFingerprint('partition-2');

      // Different references (may have same values due to random generation)
      expect(fp1).not.toBe(fp2);
    });

    it('should use custom config when provided', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Custom User Agent',
        platform: 'MacIntel',
        languages: ['zh-CN', 'zh'],
        timezone: 'Asia/Shanghai',
      };

      const fingerprint = manager.getFingerprint('custom-partition', config);

      expect(fingerprint.userAgent).toBe('Custom User Agent');
      expect(fingerprint.platform).toBe('MacIntel');
      // Languages may be reordered by the generator, so check contents not order
      expect(fingerprint.languages).toContain('zh-CN');
      expect(fingerprint.languages).toContain('zh');
      expect(fingerprint.timezone).toBe('Asia/Shanghai');
    });
  });

  describe('clearCache', () => {
    it('should clear specific partition cache', () => {
      const fp1 = manager.getFingerprint('partition-to-clear');
      manager.clearCache('partition-to-clear');
      const fp2 = manager.getFingerprint('partition-to-clear');

      expect(fp1).not.toBe(fp2); // Different reference after clear
    });
  });

  describe('clearAllCache', () => {
    it('should clear all cached fingerprints', () => {
      manager.getFingerprint('partition-1');
      manager.getFingerprint('partition-2');
      expect(manager.getCacheSize()).toBe(2);

      manager.clearAllCache();
      expect(manager.getCacheSize()).toBe(0);
    });
  });

  describe('validateFingerprint', () => {
    it('should validate correct fingerprint', () => {
      const result = manager.validateFingerprint(mockFingerprint);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect UA/Platform mismatch', () => {
      const invalidFp = {
        ...mockFingerprint,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0...',
        platform: 'MacIntel', // Mismatch!
      };

      const result = manager.validateFingerprint(invalidFp);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('platform'))).toBe(true);
    });

    it('should detect invalid hardware values', () => {
      const invalidFp = {
        ...mockFingerprint,
        hardwareConcurrency: 999, // Out of range
      };

      const result = manager.validateFingerprint(invalidFp);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('hardwareConcurrency'))).toBe(true);
    });
  });
});

// ========== 脚本生成测试 ==========

describe('Script Generation', () => {
  describe('generateFullStealthScript', () => {
    it('should generate non-empty script', () => {
      const script = generateFullStealthScript(mockFingerprint);
      expect(script.length).toBeGreaterThan(0);
    });

    it('should include IIFE wrapper', () => {
      const script = generateFullStealthScript(mockFingerprint);
      expect(script).toMatch(/^\(function\(\)/);
      expect(script).toMatch(/\}\)\(\);$/);
    });

    it('should be deterministic for same fingerprint', () => {
      const script1 = generateFullStealthScript(mockFingerprint);
      const script2 = generateFullStealthScript(mockFingerprint);
      expect(script1).toBe(script2);
    });

    it('should include webdriver hiding', () => {
      const script = generateFullStealthScript(mockFingerprint);
      expect(script).toContain('webdriver');
    });

    it('should include WebGL override', () => {
      const script = generateFullStealthScript(mockFingerprint);
      expect(script).toContain('WebGLRenderingContext');
      expect(script).toContain(String(WEBGL_PARAMS.UNMASKED_VENDOR_WEBGL));
    });

    it('should include fingerprint values', () => {
      const script = generateFullStealthScript(mockFingerprint);
      expect(script).toContain(mockFingerprint.platform);
      expect(script).toContain(String(mockFingerprint.hardwareConcurrency));
    });
  });

  describe('generateStealthScript (backward compatible)', () => {
    it('should be alias of generateFullStealthScript', () => {
      const script1 = generateStealthScript(mockFingerprint);
      const script2 = generateFullStealthScript(mockFingerprint);
      expect(script1).toBe(script2);
    });
  });

  describe('generateWebGLScript', () => {
    it('should include WebGL parameters', () => {
      const script = generateWebGLScript(mockFingerprint.webgl);
      expect(script).toContain(mockFingerprint.webgl.vendor);
      expect(script).toContain(mockFingerprint.webgl.renderer);
    });

    it('should escape special characters', () => {
      const webglWithQuotes = {
        vendor: "Google's Inc. (NVIDIA)",
        renderer: "Test 'Renderer'",
        version: 'WebGL 1.0',
      };
      const script = generateWebGLScript(webglWithQuotes);
      // Should properly escape single quotes with backslash
      expect(script).toContain("\\'");
      // Should not have unescaped single quotes that would break the string
      expect(script).toContain("Google\\'s Inc.");
    });
  });

  describe('generateBatteryScript (deterministic)', () => {
    it('should generate same script for same seed', () => {
      const script1 = generateBatteryScript(12345);
      const script2 = generateBatteryScript(12345);
      expect(script1).toBe(script2);
    });

    it('should generate different script for different seed', () => {
      const script1 = generateBatteryScript(12345);
      const script2 = generateBatteryScript(54321);
      expect(script1).not.toBe(script2);
    });
  });

  describe('generateAudioContextScript (deterministic)', () => {
    it('should generate same script for same seed', () => {
      const script1 = generateAudioContextScript(12345);
      const script2 = generateAudioContextScript(12345);
      expect(script1).toBe(script2);
    });
  });
});

// ========== CDP 命令生成测试 ==========

describe('CDP Commands', () => {
  describe('generateCDPCommands', () => {
    it('should generate array of commands', () => {
      const commands = generateCDPCommands(mockFingerprint);
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should include timezone override', () => {
      const commands = generateCDPCommands(mockFingerprint);
      const timezoneCmd = commands.find((c) => c.method === 'Emulation.setTimezoneOverride');
      expect(timezoneCmd).toBeDefined();
      expect(timezoneCmd?.params).toHaveProperty('timezoneId', mockFingerprint.timezone);
    });

    it('should include geolocation override', () => {
      const commands = generateCDPCommands(mockFingerprint);
      const geoCmd = commands.find((c) => c.method === 'Emulation.setGeolocationOverride');
      expect(geoCmd).toBeDefined();
      expect(geoCmd?.params).toHaveProperty('latitude');
      expect(geoCmd?.params).toHaveProperty('longitude');
    });

    it('should include user agent override', () => {
      const commands = generateCDPCommands(mockFingerprint);
      const uaCmd = commands.find((c) => c.method === 'Emulation.setUserAgentOverride');
      expect(uaCmd).toBeDefined();
      expect(uaCmd?.params).toHaveProperty('userAgent', mockFingerprint.userAgent);
    });

    it('should respect config options', () => {
      const commands = generateCDPCommands(mockFingerprint, { timezone: false });
      const timezoneCmd = commands.find((c) => c.method === 'Emulation.setTimezoneOverride');
      expect(timezoneCmd).toBeUndefined();
    });
  });

  describe('createCDPStealthSession', () => {
    it('should include all stealth commands', () => {
      const commands = createCDPStealthSession(mockFingerprint);

      // Should include basic commands
      expect(commands.some((c) => c.method === 'Emulation.setTimezoneOverride')).toBe(true);
      expect(commands.some((c) => c.method === 'Emulation.setGeolocationOverride')).toBe(true);
      expect(commands.some((c) => c.method === 'Emulation.setUserAgentOverride')).toBe(true);

      // Should include debugger hiding
      expect(commands.some((c) => c.method === 'Performance.disable')).toBe(true);

      // Should include script injection (for WebGL, automation hiding)
      const scriptCommands = commands.filter(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'
      );
      expect(scriptCommands.length).toBeGreaterThan(0);
    });
  });
});

// ========== 集成测试 ==========

describe('Integration', () => {
  it('should work end-to-end: manager -> script -> CDP', () => {
    const manager = createFingerprintManager();
    const config: StealthConfig = {
      userAgent: mockFingerprint.userAgent,
      platform: mockFingerprint.platform,
      languages: mockFingerprint.languages,
      timezone: mockFingerprint.timezone,
      hardwareConcurrency: mockFingerprint.hardwareConcurrency,
      deviceMemory: mockFingerprint.deviceMemory,
      screen: {
        width: mockFingerprint.screenResolution.width,
        height: mockFingerprint.screenResolution.height,
        availWidth: mockFingerprint.screenResolution.width,
        availHeight: mockFingerprint.screenResolution.height - 40,
        colorDepth: mockFingerprint.colorDepth,
        pixelRatio: 1,
      },
      webgl: mockFingerprint.webgl,
      touchSupport: false,
      maxTouchPoints: 0,
      canvasNoise: false,
    };

    // 1. Generate fingerprint
    const fingerprint = manager.getFingerprint('integration-test', config);

    // 2. Validate fingerprint
    const validation = manager.validateFingerprint(fingerprint);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    // 3. Generate JS script
    const script = generateFullStealthScript(fingerprint);
    expect(script.length).toBeGreaterThan(0);

    // 4. Generate CDP commands
    const cdpCommands = createCDPStealthSession(fingerprint);
    expect(cdpCommands.length).toBeGreaterThan(0);

    // 5. Verify consistency
    const script2 = generateFullStealthScript(fingerprint);
    expect(script).toBe(script2); // Same fingerprint = same script
  });
});
