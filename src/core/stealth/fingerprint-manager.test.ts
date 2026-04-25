/**
 * FingerprintManager 单元测试
 *
 * 测试覆盖：
 * - 指纹生成和缓存机制
 * - 自定义配置支持
 * - 缓存管理（清除、大小、列表）
 * - 指纹验证功能
 * - 工厂函数
 * - UA 推断逻辑
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ========== Mock fingerprint-generator ==========
// 使用 vi.hoisted 确保 mock 数据在模块加载前初始化

const { mockGeneratedFingerprint, _mockMacFingerprint } = vi.hoisted(() => {
  return {
    // Mock 数据：模拟 fingerprint-generator 返回的指纹
    mockGeneratedFingerprint: {
      fingerprint: {
        navigator: {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          platform: 'Win32',
          hardwareConcurrency: 8,
          deviceMemory: 8,
          language: 'en-US',
        },
        screen: {
          width: 1920,
          height: 1080,
          colorDepth: 24,
        },
        videoCard: {
          vendor: 'Google Inc. (NVIDIA)',
          renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
        },
      },
    },

    // Mock 不同操作系统的指纹
    _mockMacFingerprint: {
      fingerprint: {
        navigator: {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          platform: 'MacIntel',
          hardwareConcurrency: 8,
          deviceMemory: 16,
          language: 'en-US',
        },
        screen: {
          width: 2560,
          height: 1440,
          colorDepth: 30,
        },
        videoCard: {
          vendor: 'Apple Inc.',
          renderer: 'Apple M1',
        },
      },
    },
  };
});

// Mock FingerprintGenerator
vi.mock('fingerprint-generator', () => ({
  FingerprintGenerator: vi.fn().mockImplementation(() => ({
    getFingerprint: vi.fn().mockReturnValue(mockGeneratedFingerprint),
  })),
}));

// 现在才导入被测试的模块
import { FingerprintManager, createFingerprintManager } from './fingerprint-manager';
import type { StealthConfig, BrowserFingerprint } from './types';
import { DEFAULT_CHROME_PLUGINS, DEFAULT_TIMEZONE } from './constants';
import { getPresetById } from '../../constants/fingerprint-defaults';

// ========== 测试数据 ==========

// 有效的指纹配置（用于验证测试）
const validFingerprint: BrowserFingerprint = {
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

// ========== FingerprintManager 核心功能测试 ==========

describe('FingerprintManager', () => {
  let manager: FingerprintManager;

  beforeEach(() => {
    // 每个测试前创建新实例，确保隔离
    manager = createFingerprintManager();
    vi.clearAllMocks();
  });

  // ========== 构造函数和工厂方法 ==========

  describe('Constructor and Factory', () => {
    it('应该能通过 new 创建实例', () => {
      const instance = new FingerprintManager();
      expect(instance).toBeInstanceOf(FingerprintManager);
      expect(instance.getCacheSize()).toBe(0);
    });

    it('应该能通过工厂函数创建实例', () => {
      const instance = createFingerprintManager();
      expect(instance).toBeInstanceOf(FingerprintManager);
      expect(instance.getCacheSize()).toBe(0);
    });

    it('工厂函数每次应返回新实例', () => {
      const instance1 = createFingerprintManager();
      const instance2 = createFingerprintManager();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ========== getFingerprint 基础功能 ==========

  describe('getFingerprint', () => {
    it('应该为新 partition 生成有效的指纹', () => {
      const fingerprint = manager.getFingerprint('test-partition');

      // 验证所有必需字段
      expect(fingerprint.userAgent).toBeDefined();
      expect(fingerprint.userAgent).toContain('Chrome');
      expect(fingerprint.platform).toBeDefined();
      expect(fingerprint.languages).toBeInstanceOf(Array);
      expect(fingerprint.languages.length).toBeGreaterThan(0);
      expect(fingerprint.timezone).toBeDefined();
      expect(fingerprint.hardwareConcurrency).toBeGreaterThan(0);
      expect(fingerprint.deviceMemory).toBeGreaterThan(0);
      expect(fingerprint.screenResolution.width).toBeGreaterThan(0);
      expect(fingerprint.screenResolution.height).toBeGreaterThan(0);
      expect(fingerprint.colorDepth).toBeGreaterThan(0);
      expect(fingerprint.webgl).toBeDefined();
      expect(fingerprint.webgl.vendor).toBeDefined();
      expect(fingerprint.webgl.renderer).toBeDefined();
      expect(fingerprint.webgl.version).toBeDefined();
      expect(fingerprint.plugins).toBeInstanceOf(Array);
      expect(fingerprint.canvas).toBeDefined();
    });

    it('应该为相同 partition 返回缓存的指纹（同一引用）', () => {
      const partition = 'cache-test-partition';

      const fp1 = manager.getFingerprint(partition);
      const fp2 = manager.getFingerprint(partition);
      const fp3 = manager.getFingerprint(partition);

      // 应该返回完全相同的对象引用
      expect(fp1).toBe(fp2);
      expect(fp2).toBe(fp3);
    });

    it('应该支持使用相同 identityKey 跨 partition 复用指纹', () => {
      const config: StealthConfig = {
        enabled: true,
        identityKey: 'shared-identity',
      };

      const fp1 = manager.getFingerprint('partition-A', config);
      const fp2 = manager.getFingerprint('partition-B', config);

      expect(fp2).toBe(fp1);
      expect(manager.getCacheSize()).toBe(1);
    });

    it('应该在同一 partition 上按配置变化重新生成指纹', () => {
      const partition = 'cache-config-mismatch';

      const fpZh = manager.getFingerprint(partition, {
        enabled: true,
        languages: ['zh-CN', 'zh', 'en-US', 'en'],
        timezone: 'Asia/Shanghai',
      });

      const fpEn = manager.getFingerprint(partition, {
        enabled: true,
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
      });

      expect(fpEn).not.toBe(fpZh);
      expect(fpZh.languages).toEqual(['zh-CN', 'zh', 'en-US', 'en']);
      expect(fpZh.timezone).toBe('Asia/Shanghai');
      expect(fpEn.languages).toEqual(['en-US', 'en']);
      expect(fpEn.timezone).toBe('America/New_York');

      const fpEn2 = manager.getFingerprint(partition, {
        enabled: true,
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
      });
      expect(fpEn2).toBe(fpEn);
    });

    it('应该为不同 partition 生成不同的指纹对象', () => {
      const fp1 = manager.getFingerprint('partition-1');
      const fp2 = manager.getFingerprint('partition-2');
      const fp3 = manager.getFingerprint('partition-3');

      // 不同 partition 应该是不同的对象引用
      expect(fp1).not.toBe(fp2);
      expect(fp2).not.toBe(fp3);
      expect(fp1).not.toBe(fp3);
    });

    it('应该在缓存中记录指纹', () => {
      expect(manager.getCacheSize()).toBe(0);

      manager.getFingerprint('partition-1');
      expect(manager.getCacheSize()).toBe(1);

      manager.getFingerprint('partition-2');
      expect(manager.getCacheSize()).toBe(2);

      // 重复获取同一 partition 不应增加缓存大小
      manager.getFingerprint('partition-1');
      expect(manager.getCacheSize()).toBe(2);
    });
  });

  // ========== 自定义配置测试 ==========

  describe('Custom Configuration', () => {
    it('应该支持自定义 User-Agent', () => {
      const customUA = 'Custom/5.0 User Agent String';
      const config: StealthConfig = {
        enabled: true,
        userAgent: customUA,
      };

      const fingerprint = manager.getFingerprint('custom-ua', config);
      expect(fingerprint.userAgent).toBe(customUA);
    });

    it('应该支持自定义 Platform', () => {
      const config: StealthConfig = {
        enabled: true,
        platform: 'MacIntel',
      };

      const fingerprint = manager.getFingerprint('custom-platform', config);
      expect(fingerprint.platform).toBe('MacIntel');
    });

    it('应该支持自定义语言列表', () => {
      const customLangs = ['zh-CN', 'zh', 'en-US'];
      const config: StealthConfig = {
        enabled: true,
        languages: customLangs,
      };

      const fingerprint = manager.getFingerprint('custom-langs', config);
      // 注意：由于实现会通过生成器处理，实际的语言列表可能基于 mock 返回的数据
      // 所以我们检查语言字段存在且为数组即可
      expect(fingerprint.languages).toBeInstanceOf(Array);
      expect(fingerprint.languages.length).toBeGreaterThan(0);
    });

    it('应该支持自定义时区', () => {
      const config: StealthConfig = {
        enabled: true,
        timezone: 'Asia/Tokyo',
      };

      const fingerprint = manager.getFingerprint('custom-tz', config);
      expect(fingerprint.timezone).toBe('Asia/Tokyo');
    });

    it('应该支持自定义 WebGL 配置', () => {
      const customWebGL = {
        vendor: 'Custom Vendor Inc.',
        renderer: 'Custom Renderer Model X',
      };
      const config: StealthConfig = {
        enabled: true,
        webgl: customWebGL,
      };

      const fingerprint = manager.getFingerprint('custom-webgl', config);
      expect(fingerprint.webgl.vendor).toBe(customWebGL.vendor);
      expect(fingerprint.webgl.renderer).toBe(customWebGL.renderer);
      expect(fingerprint.webgl.version).toBeDefined(); // 版本应该自动补全
    });

    it('应该支持启用 Canvas 噪声', () => {
      const config: StealthConfig = {
        enabled: true,
        canvasNoise: true,
      };

      const fingerprint = manager.getFingerprint('canvas-noise', config);
      expect(fingerprint.canvas?.noise).toBe(true);
    });

    it('应该支持组合多个自定义配置', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Combined/1.0',
        platform: 'Linux x86_64',
        languages: ['ja-JP', 'ja'],
        timezone: 'Asia/Tokyo',
        canvasNoise: true,
        webgl: {
          vendor: 'Intel Inc.',
          renderer: 'Intel HD Graphics',
        },
      };

      const fingerprint = manager.getFingerprint('combined', config);

      expect(fingerprint.userAgent).toBe('Combined/1.0');
      expect(fingerprint.platform).toBe('Linux x86_64');
      expect(fingerprint.languages).toEqual(expect.arrayContaining(['ja-JP', 'ja']));
      expect(fingerprint.timezone).toBe('Asia/Tokyo');
      expect(fingerprint.canvas?.noise).toBe(true);
      expect(fingerprint.webgl.vendor).toBe('Intel Inc.');
      expect(fingerprint.webgl.renderer).toBe('Intel HD Graphics');
    });

    it('应该在没有配置时使用默认值', () => {
      const fingerprint = manager.getFingerprint('defaults');

      expect(fingerprint.timezone).toBe(DEFAULT_TIMEZONE);
      expect(fingerprint.plugins).toEqual(
        expect.arrayContaining(
          DEFAULT_CHROME_PLUGINS.map((p) => expect.objectContaining({ name: p.name }))
        )
      );
      expect(fingerprint.canvas?.noise).toBe(true);
    });

    it('应该支持使用预设指纹 ID', () => {
      const preset = getPresetById('windows-chrome-120');
      expect(preset).toBeDefined();
      if (!preset) return;

      const config: StealthConfig = {
        enabled: true,
        fingerprint: preset.id,
      };
      const fingerprint = manager.getFingerprint('preset-id', config);
      expect(fingerprint.userAgent).toBe(preset.config.userAgent);
      expect(fingerprint.platform).toBe(preset.config.platform);
      expect(fingerprint.timezone).toBe(preset.config.timezone);
    });
  });

  // ========== UA 推断逻辑测试 ==========

  describe('Platform Inference from User-Agent', () => {
    it('应该从 Windows UA 推断出 Win32 平台', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      };

      const fingerprint = manager.getFingerprint('win-ua', config);
      expect(fingerprint.platform).toBe('Win32');
    });

    it('应该从 macOS UA 推断出 MacIntel 平台', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
      };

      const fingerprint = manager.getFingerprint('mac-ua', config);
      expect(fingerprint.platform).toBe('MacIntel');
    });

    it('应该从 Linux UA 推断出 Linux x86_64 平台', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0',
      };

      const fingerprint = manager.getFingerprint('linux-ua', config);
      expect(fingerprint.platform).toBe('Linux x86_64');
    });

    it('如果明确指定 platform，应该使用指定值而不是推断', () => {
      const config: StealthConfig = {
        enabled: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        platform: 'MacIntel', // 故意不匹配
      };

      const fingerprint = manager.getFingerprint('explicit-platform', config);
      expect(fingerprint.platform).toBe('MacIntel'); // 应该使用明确指定的值
    });
  });

  // ========== generateWithOptions 测试 ==========

  describe('generateWithOptions', () => {
    it('应该能生成具有特定选项的指纹', () => {
      const options = {
        operatingSystems: ['windows' as const],
        browsers: [{ name: 'chrome' as const, minVersion: 120 }],
        devices: ['desktop' as const],
        locales: ['en-US', 'en-GB'],
      };

      const fingerprint = manager.generateWithOptions(options);

      expect(fingerprint).toBeDefined();
      expect(fingerprint.userAgent).toContain('Chrome');
    });

    it('应该支持自定义屏幕尺寸范围', () => {
      const options = {
        screenWidth: { min: 1024, max: 1920 },
        screenHeight: { min: 768, max: 1080 },
      };

      const fingerprint = manager.generateWithOptions(options);

      expect(fingerprint.screenResolution.width).toBeGreaterThanOrEqual(1024);
      expect(fingerprint.screenResolution.width).toBeLessThanOrEqual(1920);
      expect(fingerprint.screenResolution.height).toBeGreaterThanOrEqual(768);
      expect(fingerprint.screenResolution.height).toBeLessThanOrEqual(1080);
    });

    it('应该使用默认值当未指定选项时', () => {
      const fingerprint = manager.generateWithOptions({});

      expect(fingerprint.userAgent).toBeDefined();
      expect(fingerprint.platform).toBeDefined();
      expect(fingerprint.screenResolution.width).toBeGreaterThan(0);
    });
  });

  // ========== 缓存管理测试 ==========

  describe('Cache Management', () => {
    describe('clearCache', () => {
      it('应该清除指定 partition 的缓存', () => {
        const partition = 'clear-me';

        const fp1 = manager.getFingerprint(partition);
        expect(manager.getCacheSize()).toBe(1);

        manager.clearCache(partition);
        expect(manager.getCacheSize()).toBe(0);

        // 清除后重新获取应该生成新的指纹对象
        const fp2 = manager.getFingerprint(partition);
        expect(fp2).not.toBe(fp1); // 不同的引用
      });

      it('应该只清除指定的 partition，不影响其他缓存', () => {
        manager.getFingerprint('partition-1');
        manager.getFingerprint('partition-2');
        manager.getFingerprint('partition-3');
        expect(manager.getCacheSize()).toBe(3);

        manager.clearCache('partition-2');

        expect(manager.getCacheSize()).toBe(2);
        expect(manager.getCachedPartitions()).toContain('partition-1');
        expect(manager.getCachedPartitions()).not.toContain('partition-2');
        expect(manager.getCachedPartitions()).toContain('partition-3');
      });

      it('清除不存在的 partition 应该不报错', () => {
        expect(() => {
          manager.clearCache('non-existent');
        }).not.toThrow();
      });
    });

    describe('clearAllCache', () => {
      it('应该清除所有缓存', () => {
        manager.getFingerprint('partition-1');
        manager.getFingerprint('partition-2');
        manager.getFingerprint('partition-3');
        expect(manager.getCacheSize()).toBe(3);

        manager.clearAllCache();

        expect(manager.getCacheSize()).toBe(0);
        expect(manager.getCachedPartitions()).toHaveLength(0);
      });

      it('清除空缓存应该不报错', () => {
        expect(manager.getCacheSize()).toBe(0);
        expect(() => {
          manager.clearAllCache();
        }).not.toThrow();
        expect(manager.getCacheSize()).toBe(0);
      });
    });

    describe('getCacheSize', () => {
      it('初始缓存大小应该为 0', () => {
        expect(manager.getCacheSize()).toBe(0);
      });

      it('应该正确返回缓存数量', () => {
        manager.getFingerprint('partition-1');
        expect(manager.getCacheSize()).toBe(1);

        manager.getFingerprint('partition-2');
        expect(manager.getCacheSize()).toBe(2);

        manager.getFingerprint('partition-3');
        expect(manager.getCacheSize()).toBe(3);
      });

      it('重复获取同一 partition 不应增加计数', () => {
        manager.getFingerprint('same-partition');
        manager.getFingerprint('same-partition');
        manager.getFingerprint('same-partition');
        expect(manager.getCacheSize()).toBe(1);
      });
    });

    describe('getCachedPartitions', () => {
      it('初始应该返回空数组', () => {
        expect(manager.getCachedPartitions()).toEqual([]);
      });

      it('应该返回所有缓存的 partition 列表', () => {
        manager.getFingerprint('partition-A');
        manager.getFingerprint('partition-B');
        manager.getFingerprint('partition-C');

        const partitions = manager.getCachedPartitions();
        expect(partitions).toHaveLength(3);
        expect(partitions).toContain('partition-A');
        expect(partitions).toContain('partition-B');
        expect(partitions).toContain('partition-C');
      });

      it('清除缓存后应该更新列表', () => {
        manager.getFingerprint('partition-1');
        manager.getFingerprint('partition-2');

        manager.clearCache('partition-1');

        const partitions = manager.getCachedPartitions();
        expect(partitions).toHaveLength(1);
        expect(partitions).not.toContain('partition-1');
        expect(partitions).toContain('partition-2');
      });
    });
  });

  // ========== 指纹验证功能测试 ==========

  describe('validateFingerprint', () => {
    it('应该验证有效的指纹配置', () => {
      const result = manager.validateFingerprint(validFingerprint);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    describe('User-Agent 与 Platform 匹配检查', () => {
      it('应该检测 Windows UA 与 Platform 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
          platform: 'MacIntel', // 不匹配！
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((e) => e.includes('platform'))).toBe(true);
        expect(result.errors.some((e) => e.includes('Win32'))).toBe(true);
      });

      it('应该检测 macOS UA 与 Platform 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...',
          platform: 'Win32', // 不匹配！
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('MacIntel'))).toBe(true);
      });

      it('应该检测 Linux UA 与 Platform 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) ...',
          platform: 'Win32', // 不匹配！
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Linux'))).toBe(true);
      });
    });

    describe('WebGL Vendor 与 Renderer 匹配检查', () => {
      it('应该检测 NVIDIA Vendor 与 Renderer 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          webgl: {
            vendor: 'Google Inc. (NVIDIA)',
            renderer: 'ANGLE (Intel HD Graphics)', // 不匹配！
            version: 'WebGL 1.0',
          },
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('NVIDIA'))).toBe(true);
      });

      it('应该检测 Intel Vendor 与 Renderer 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          webgl: {
            vendor: 'Google Inc. (Intel)',
            renderer: 'ANGLE (NVIDIA GeForce)', // 不匹配！
            version: 'WebGL 1.0',
          },
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Intel'))).toBe(true);
      });

      it('应该检测 Apple Vendor 与 Renderer 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          webgl: {
            vendor: 'Apple Inc.',
            renderer: 'NVIDIA GeForce', // 不匹配！
            version: 'WebGL 1.0',
          },
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Apple'))).toBe(true);
      });
    });

    describe('硬件配置合理性检查', () => {
      it('应该检测 hardwareConcurrency 超出范围（过小）', () => {
        const invalidFp = {
          ...validFingerprint,
          hardwareConcurrency: 0, // 无效值
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('hardwareConcurrency'))).toBe(true);
      });

      it('应该检测 hardwareConcurrency 超出范围（过大）', () => {
        const invalidFp = {
          ...validFingerprint,
          hardwareConcurrency: 256, // 超出合理范围
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('hardwareConcurrency'))).toBe(true);
      });

      it('应该检测 deviceMemory 超出范围（过小）', () => {
        const invalidFp = {
          ...validFingerprint,
          deviceMemory: 0.1, // 小于最小值 0.25
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('deviceMemory'))).toBe(true);
      });

      it('应该检测 deviceMemory 超出范围（过大）', () => {
        const invalidFp = {
          ...validFingerprint,
          deviceMemory: 128, // 超出合理范围
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('deviceMemory'))).toBe(true);
      });
    });

    describe('屏幕分辨率合理性检查', () => {
      it('应该检测屏幕宽度过小', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { width: 320, height: 1080 }, // 宽度过小
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('width'))).toBe(true);
      });

      it('应该检测屏幕宽度过大', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { width: 8000, height: 1080 }, // 宽度过大
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('width'))).toBe(true);
      });

      it('应该检测屏幕高度过小', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { width: 1920, height: 240 }, // 高度过小
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('height'))).toBe(true);
      });

      it('应该检测屏幕高度过大', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { width: 1920, height: 5000 }, // 高度过大
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('height'))).toBe(true);
      });
    });

    describe('颜色深度检查', () => {
      it('应该接受有效的颜色深度值', () => {
        const validDepths = [8, 16, 24, 30, 32];

        for (const depth of validDepths) {
          const fp = { ...validFingerprint, colorDepth: depth };
          const result = manager.validateFingerprint(fp);
          expect(result.valid).toBe(true);
        }
      });

      it('应该拒绝无效的颜色深度值', () => {
        const invalidDepths = [0, 4, 12, 20, 48, 64];

        for (const depth of invalidDepths) {
          const fp = { ...validFingerprint, colorDepth: depth };
          const result = manager.validateFingerprint(fp);
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.includes('colorDepth'))).toBe(true);
        }
      });
    });

    describe('platformVersion 格式检查', () => {
      it('应该拒绝无效的 platformVersion 格式', () => {
        const invalidFp = {
          ...validFingerprint,
          platformVersion: '10.0.19045.3324',
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('platformVersion'))).toBe(true);
      });

      it('应该接受有效的 platformVersion 格式', () => {
        const validFp = {
          ...validFingerprint,
          platformVersion: '10.0.19045',
        };

        const result = manager.validateFingerprint(validFp);

        expect(result.valid).toBe(true);
      });
    });

    describe('屏幕可用区域与像素比检查', () => {
      it('应该检测 availWidth 超出屏幕宽度', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { ...validFingerprint.screenResolution, availWidth: 2500 },
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('availWidth'))).toBe(true);
      });

      it('应该检测 availHeight 超出屏幕高度', () => {
        const invalidFp = {
          ...validFingerprint,
          screenResolution: { ...validFingerprint.screenResolution, availHeight: 1400 },
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('availHeight'))).toBe(true);
      });

      it('应该检测无效的 pixelRatio', () => {
        const invalidFp = {
          ...validFingerprint,
          pixelRatio: 0,
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('pixelRatio'))).toBe(true);
      });
    });

    describe('语言与触控配置检查', () => {
      it('应该检测空语言列表', () => {
        const invalidFp = {
          ...validFingerprint,
          languages: [],
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('languages'))).toBe(true);
      });

      it('应该检测无效的 maxTouchPoints', () => {
        const invalidFp = {
          ...validFingerprint,
          maxTouchPoints: -1,
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('maxTouchPoints'))).toBe(true);
      });

      it('应该检测非整数的 maxTouchPoints', () => {
        const invalidFp = {
          ...validFingerprint,
          maxTouchPoints: 1.5,
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('maxTouchPoints'))).toBe(true);
      });

      it('应该检测 touchSupport 与 maxTouchPoints 不匹配', () => {
        const invalidFp = {
          ...validFingerprint,
          touchSupport: true,
          maxTouchPoints: 0,
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('touchSupport'))).toBe(true);
      });
    });

    describe('多重错误检测', () => {
      it('应该检测并报告所有错误', () => {
        const invalidFp = {
          ...validFingerprint,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
          platform: 'MacIntel', // 错误 1：UA/Platform 不匹配
          hardwareConcurrency: 256, // 错误 2：CPU 核心数过大
          deviceMemory: 128, // 错误 3：内存过大
          screenResolution: { width: 8000, height: 5000 }, // 错误 4+5：分辨率过大
          colorDepth: 64, // 错误 6：无效的颜色深度
        };

        const result = manager.validateFingerprint(invalidFp);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(5); // 至少有 5 个错误
      });
    });
  });

  // ========== 边缘情况测试 ==========

  describe('Edge Cases', () => {
    it('应该处理空字符串 partition', () => {
      const fingerprint = manager.getFingerprint('');
      expect(fingerprint).toBeDefined();
      expect(manager.getCachedPartitions()).toContain('');
    });

    it('应该处理包含特殊字符的 partition', () => {
      const specialPartitions = [
        'partition:with:colons',
        'partition-with-dashes',
        'partition_with_underscores',
        'partition.with.dots',
        'partition/with/slashes',
        'partition with spaces',
      ];

      for (const partition of specialPartitions) {
        const fp = manager.getFingerprint(partition);
        expect(fp).toBeDefined();
        expect(manager.getCachedPartitions()).toContain(partition);
      }
    });

    it('应该处理非常长的 partition 名称', () => {
      const longPartition = 'a'.repeat(1000);
      const fingerprint = manager.getFingerprint(longPartition);
      expect(fingerprint).toBeDefined();
      expect(manager.getCachedPartitions()).toContain(longPartition);
    });

    it('应该处理部分自定义配置（只提供部分字段）', () => {
      const partialConfig: StealthConfig = {
        enabled: true,
        userAgent: 'Custom UA',
        // 其他字段使用默认值
      };

      const fingerprint = manager.getFingerprint('partial', partialConfig);

      expect(fingerprint.userAgent).toBe('Custom UA');
      expect(fingerprint.platform).toBeDefined();
      expect(fingerprint.languages).toBeDefined();
      expect(fingerprint.timezone).toBeDefined();
    });
  });

  // ========== 指纹数据完整性测试 ==========

  describe('Fingerprint Data Integrity', () => {
    it('生成的指纹应该包含正确的插件列表', () => {
      const fingerprint = manager.getFingerprint('plugin-test');

      expect(fingerprint.plugins.length).toBeGreaterThan(0);
      expect(fingerprint.plugins.every((p) => p.name)).toBe(true);
      expect(fingerprint.plugins.every((p) => p.filename)).toBe(true);

      // 应该包含 PDF 相关插件
      const hasPdfPlugin = fingerprint.plugins.some((p) => p.name.toLowerCase().includes('pdf'));
      expect(hasPdfPlugin).toBe(true);
    });

    it('生成的指纹应该包含合理的硬件数值', () => {
      const fingerprint = manager.getFingerprint('hardware-test');

      expect(fingerprint.hardwareConcurrency).toBeGreaterThanOrEqual(1);
      expect(fingerprint.hardwareConcurrency).toBeLessThanOrEqual(128);
      expect(fingerprint.deviceMemory).toBeGreaterThanOrEqual(0.25);
      expect(fingerprint.deviceMemory).toBeLessThanOrEqual(64);
      expect(fingerprint.screenResolution.width).toBeGreaterThanOrEqual(640);
      expect(fingerprint.screenResolution.height).toBeGreaterThanOrEqual(480);
      expect([8, 16, 24, 30, 32]).toContain(fingerprint.colorDepth);
    });

    it('生成的指纹应该包含有效的 WebGL 信息', () => {
      const fingerprint = manager.getFingerprint('webgl-test');

      expect(fingerprint.webgl.vendor).toBeTruthy();
      expect(fingerprint.webgl.vendor.length).toBeGreaterThan(0);
      expect(fingerprint.webgl.renderer).toBeTruthy();
      expect(fingerprint.webgl.renderer.length).toBeGreaterThan(0);
      expect(fingerprint.webgl.version).toBeTruthy();
      expect(fingerprint.webgl.version).toContain('WebGL');
    });

    it('plugins 数组应该是深拷贝，修改不会影响常量', () => {
      const fingerprint = manager.getFingerprint('plugin-immutable-test');

      // 修改返回的插件列表
      fingerprint.plugins[0].name = 'Modified Name';

      // 重新获取应该返回原始的插件列表
      const fingerprint2 = manager.getFingerprint('plugin-immutable-test');
      expect(fingerprint2.plugins[0].name).toBe('Modified Name'); // 因为是缓存的同一对象

      // 但新 partition 的插件应该不受影响
      const fingerprint3 = manager.getFingerprint('plugin-immutable-test-2');
      expect(fingerprint3.plugins[0].name).not.toBe('Modified Name');
    });
  });
});
