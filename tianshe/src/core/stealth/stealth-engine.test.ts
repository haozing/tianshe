/**
 * Stealth Engine 单元测试
 *
 * 测试统一的浏览器反检测引擎
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateCDPCommands,
  generateDebuggerHidingCommands,
  generateFullStealthScript,
  generateScriptInjectionCommand,
  applyFullStealth,
  applyCDPCommands,
  createCDPStealthSession,
  type CDPExecutor,
  type StealthOptions,
} from './stealth-engine';
import type { BrowserFingerprint } from './types';

// ========== Mock 依赖模块 ==========

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// ========== 测试辅助函数 ==========

/**
 * 创建 Mock 指纹配置
 */
function createMockFingerprint(overrides?: Partial<BrowserFingerprint>): BrowserFingerprint {
  return {
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
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0)',
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    },
    plugins: [
      {
        name: 'Chrome PDF Plugin',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: [
          {
            type: 'application/pdf',
            suffixes: 'pdf',
            description: 'Portable Document Format',
          },
        ],
      },
    ],
    canvas: { noise: false },
    ...overrides,
  };
}

/**
 * 创建 Mock CDP 执行器
 */
function createMockExecutor(): CDPExecutor & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({}),
  };
}

// ========== 测试套件 ==========

describe('stealth-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========== generateCDPCommands 测试 ==========

  describe('generateCDPCommands', () => {
    it('should generate basic CDP commands', () => {
      const fingerprint = createMockFingerprint();
      const commands = generateCDPCommands(fingerprint);

      expect(commands).toBeDefined();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should include timezone override command', () => {
      const fingerprint = createMockFingerprint({
        timezone: 'Asia/Shanghai',
      });
      const commands = generateCDPCommands(fingerprint);

      const timezoneCommand = commands.find(
        (cmd) => cmd.method === 'Emulation.setTimezoneOverride'
      );
      expect(timezoneCommand).toBeDefined();
      expect(timezoneCommand?.params).toEqual({
        timezoneId: 'Asia/Shanghai',
      });
    });

    it('should include geolocation override command', () => {
      const fingerprint = createMockFingerprint();
      const commands = generateCDPCommands(fingerprint);

      const geoCommand = commands.find((cmd) => cmd.method === 'Emulation.setGeolocationOverride');
      expect(geoCommand).toBeDefined();
      expect(geoCommand?.params).toHaveProperty('latitude');
      expect(geoCommand?.params).toHaveProperty('longitude');
      expect(geoCommand?.params).toHaveProperty('accuracy');
    });

    it('should include User-Agent override command', () => {
      const fingerprint = createMockFingerprint();
      const commands = generateCDPCommands(fingerprint);

      const uaCommand = commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride');
      expect(uaCommand).toBeDefined();
      expect(uaCommand?.params).toMatchObject({
        userAgent: fingerprint.userAgent,
        platform: fingerprint.platform,
        acceptLanguage: 'en-US,en;q=0.9',
      });
    });

    it('should include device metrics override command', () => {
      const fingerprint = createMockFingerprint();
      const commands = generateCDPCommands(fingerprint);

      const metricsCommand = commands.find(
        (cmd) => cmd.method === 'Emulation.setDeviceMetricsOverride'
      );
      expect(metricsCommand).toBeDefined();
      expect(metricsCommand?.params).toMatchObject({
        width: fingerprint.screenResolution.width,
        height: fingerprint.screenResolution.height,
        deviceScaleFactor: fingerprint.pixelRatio ?? 1,
        mobile: false,
      });
    });

    it('should use pixelRatio for deviceScaleFactor', () => {
      const fingerprint = createMockFingerprint({ pixelRatio: 2 });
      const commands = generateCDPCommands(fingerprint);

      const metricsCommand = commands.find(
        (cmd) => cmd.method === 'Emulation.setDeviceMetricsOverride'
      );
      expect((metricsCommand?.params as any)?.deviceScaleFactor).toBe(2);
    });

    it('should respect options to disable features', () => {
      const fingerprint = createMockFingerprint();
      const options: StealthOptions = {
        timezone: false,
        geolocation: false,
        userAgent: false,
        deviceMetrics: false,
      };
      const commands = generateCDPCommands(fingerprint, options);

      expect(
        commands.find((cmd) => cmd.method === 'Emulation.setTimezoneOverride')
      ).toBeUndefined();
      expect(
        commands.find((cmd) => cmd.method === 'Emulation.setGeolocationOverride')
      ).toBeUndefined();
      expect(
        commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride')
      ).toBeUndefined();
    });

    it('should keep user agent override when device metrics are disabled', () => {
      const fingerprint = createMockFingerprint();
      const commands = generateCDPCommands(fingerprint, { deviceMetrics: false });

      expect(commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride')).toBeDefined();
      expect(
        commands.find((cmd) => cmd.method === 'Emulation.setDeviceMetricsOverride')
      ).toBeUndefined();
    });

    it('should add touch emulation command when disabled', () => {
      const fingerprint = createMockFingerprint();
      const options: StealthOptions = { touchEvents: false };
      const commands = generateCDPCommands(fingerprint, options);

      const touchCommand = commands.find(
        (cmd) => cmd.method === 'Emulation.setTouchEmulationEnabled'
      );
      expect(touchCommand).toBeDefined();
      expect(touchCommand?.params).toEqual({
        enabled: false,
      });
    });

    it('should use custom geolocation when provided', () => {
      const fingerprint = createMockFingerprint();
      const options: StealthOptions = {
        customGeolocation: {
          latitude: 39.9042,
          longitude: 116.4074,
          accuracy: 50,
        },
      };
      const commands = generateCDPCommands(fingerprint, options);

      const geoCommand = commands.find((cmd) => cmd.method === 'Emulation.setGeolocationOverride');
      expect(geoCommand?.params).toEqual({
        latitude: 39.9042,
        longitude: 116.4074,
        accuracy: 50,
      });
    });
  });

  // ========== generateDebuggerHidingCommands 测试 ==========

  describe('generateDebuggerHidingCommands', () => {
    it('should generate debugger hiding commands', () => {
      const commands = generateDebuggerHidingCommands();

      expect(commands).toBeDefined();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBe(2);
    });

    it('should include performance disable command', () => {
      const commands = generateDebuggerHidingCommands();

      const perfCommand = commands.find((cmd) => cmd.method === 'Performance.disable');
      expect(perfCommand).toBeDefined();
    });

    it('should include console discard command', () => {
      const commands = generateDebuggerHidingCommands();

      const consoleCommand = commands.find((cmd) => cmd.method === 'Runtime.discardConsoleEntries');
      expect(consoleCommand).toBeDefined();
    });
  });

  // ========== generateFullStealthScript 测试 ==========

  describe('generateFullStealthScript', () => {
    it('should generate valid JavaScript string', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toBeDefined();
      expect(typeof script).toBe('string');
      expect(script.length).toBeGreaterThan(0);
    });

    it('should include IIFE wrapper', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('(function()');
      expect(script).toContain('})();');
    });

    it('should not throw syntax error', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(() => {
        new Function(script);
      }).not.toThrow();
    });

    it('should include plugins script', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('Chrome PDF Plugin');
    });

    it('should include WebGL script', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('WebGL');
      expect(script).toContain('Google Inc.');
    });

    it('should include language script', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('en-US');
    });

    it('should include hardware script', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('hardwareConcurrency');
      expect(script).toContain('deviceMemory');
    });

    it('should include navigator props script', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('Win32');
      expect(script).toContain('platform');
    });

    it('should include PluginArray and MimeTypeArray scaffolding', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('PluginArray');
      expect(script).toContain('MimeTypeArray');
      expect(script).toContain('enabledPlugin');
    });

    it('should include matchMedia and visualViewport overrides', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('matchMedia');
      expect(script).toContain('visualViewport');
      expect(script).toContain('device-pixel-ratio');
    });

    it('should include connection override', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint);

      expect(script).toContain('effectiveType');
      expect(script).toContain('downlinkMax');
    });

    it('should include diagnostics script when enabled', () => {
      const fingerprint = createMockFingerprint();
      const script = generateFullStealthScript(fingerprint, { diagnostics: true });

      expect(script).toContain('__airpaFingerprintDiagnostics');
    });

    it('should be deterministic for same fingerprint', () => {
      const fingerprint = createMockFingerprint();
      const script1 = generateFullStealthScript(fingerprint);
      const script2 = generateFullStealthScript(fingerprint);

      expect(script1).toBe(script2);
    });
  });

  // ========== generateScriptInjectionCommand 测试 ==========

  describe('generateScriptInjectionCommand', () => {
    it('should generate Page.addScriptToEvaluateOnNewDocument command', () => {
      const fingerprint = createMockFingerprint();
      const command = generateScriptInjectionCommand(fingerprint);

      expect(command.method).toBe('Page.addScriptToEvaluateOnNewDocument');
      expect(command.params).toHaveProperty('source');
      expect(typeof (command.params as { source: string }).source).toBe('string');
    });

    it('should include full stealth script', () => {
      const fingerprint = createMockFingerprint();
      const command = generateScriptInjectionCommand(fingerprint);
      const source = (command.params as { source: string }).source;

      expect(source).toContain('(function()');
      expect(source.length).toBeGreaterThan(1000);
    });
  });

  // ========== applyFullStealth 测试 ==========

  describe('applyFullStealth', () => {
    it('should execute all CDP commands', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      await applyFullStealth(executor, fingerprint);

      expect(executor.send).toHaveBeenCalled();
      expect(executor.send.mock.calls.length).toBeGreaterThan(5);
    });

    it('should include script injection', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      await applyFullStealth(executor, fingerprint);

      const calls = executor.send.mock.calls;
      const scriptCall = calls.find((call) => call[0] === 'Page.addScriptToEvaluateOnNewDocument');
      expect(scriptCall).toBeDefined();
    });

    it('should continue on command failure', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      executor.send
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('Command failed'))
        .mockResolvedValue({});

      await expect(applyFullStealth(executor, fingerprint)).resolves.toBeUndefined();
    });

    it('should handle empty options', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      await expect(applyFullStealth(executor, fingerprint, {})).resolves.toBeUndefined();
    });
  });

  // ========== applyCDPCommands 测试 ==========

  describe('applyCDPCommands', () => {
    it('should execute CDP commands without script injection', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      await applyCDPCommands(executor, fingerprint);

      const calls = executor.send.mock.calls;
      const scriptCall = calls.find((call) => call[0] === 'Page.addScriptToEvaluateOnNewDocument');
      expect(scriptCall).toBeUndefined();
    });

    it('should include debugger hiding commands', async () => {
      const fingerprint = createMockFingerprint();
      const executor = createMockExecutor();

      await applyCDPCommands(executor, fingerprint);

      const calls = executor.send.mock.calls;
      const perfCall = calls.find((call) => call[0] === 'Performance.disable');
      expect(perfCall).toBeDefined();
    });
  });

  // ========== createCDPStealthSession (backward compatible) 测试 ==========

  describe('createCDPStealthSession', () => {
    it('should create complete CDP stealth session', () => {
      const fingerprint = createMockFingerprint();
      const commands = createCDPStealthSession(fingerprint);

      expect(commands).toBeDefined();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should include basic commands', () => {
      const fingerprint = createMockFingerprint();
      const commands = createCDPStealthSession(fingerprint);

      expect(commands.some((cmd) => cmd.method === 'Emulation.setTimezoneOverride')).toBe(true);
      expect(commands.some((cmd) => cmd.method === 'Emulation.setGeolocationOverride')).toBe(true);
      expect(commands.some((cmd) => cmd.method === 'Emulation.setUserAgentOverride')).toBe(true);
    });

    it('should include debugger hiding commands', () => {
      const fingerprint = createMockFingerprint();
      const commands = createCDPStealthSession(fingerprint);

      expect(commands.some((cmd) => cmd.method === 'Performance.disable')).toBe(true);
      expect(commands.some((cmd) => cmd.method === 'Runtime.discardConsoleEntries')).toBe(true);
    });

    it('should include script injection', () => {
      const fingerprint = createMockFingerprint();
      const commands = createCDPStealthSession(fingerprint);

      expect(commands.some((cmd) => cmd.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(
        true
      );
    });

    it('should respect config options', () => {
      const fingerprint = createMockFingerprint();
      const options: StealthOptions = {
        timezone: false,
        geolocation: false,
      };
      const commands = createCDPStealthSession(fingerprint, options);

      expect(commands.some((cmd) => cmd.method === 'Emulation.setTimezoneOverride')).toBe(false);
      expect(commands.some((cmd) => cmd.method === 'Emulation.setGeolocationOverride')).toBe(false);
    });
  });

  // ========== 边界情况测试 ==========

  describe('Edge Cases', () => {
    it('should handle missing timezone', () => {
      const fingerprint = createMockFingerprint({
        timezone: undefined as any,
      });

      expect(() => generateCDPCommands(fingerprint)).not.toThrow();
    });

    it('should handle empty languages', () => {
      const fingerprint = createMockFingerprint({
        languages: [],
      });
      const commands = generateCDPCommands(fingerprint);

      const uaCommand = commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride');
      expect((uaCommand?.params as any)?.acceptLanguage).toBe('');
    });

    it('should handle special characters in User-Agent', () => {
      const fingerprint = createMockFingerprint({
        userAgent: 'Mozilla/5.0 (Test\'s "UA")',
      });

      expect(() => generateFullStealthScript(fingerprint)).not.toThrow();
    });

    it('should handle special characters in WebGL config', () => {
      const fingerprint = createMockFingerprint({
        webgl: {
          vendor: "Google's Inc. (NVIDIA)",
          renderer: 'ANGLE "Test" Renderer',
          version: "WebGL 1.0 'Chromium'",
        },
      });

      expect(() => generateFullStealthScript(fingerprint)).not.toThrow();
    });

    it('should keep devicePixelRatio consistent with pixelRatio', () => {
      const fingerprint = createMockFingerprint({ pixelRatio: 2 });
      const script = generateFullStealthScript(fingerprint);
      expect(script).toContain('devicePixelRatio');
      expect(script).toContain('var pixelRatio = 2');
    });

    it('should handle large screen resolution', () => {
      const fingerprint = createMockFingerprint({
        screenResolution: { width: 7680, height: 4320 }, // 8K
      });
      const commands = generateCDPCommands(fingerprint);

      const metricsCommand = commands.find(
        (cmd) => cmd.method === 'Emulation.setDeviceMetricsOverride'
      );
      expect(metricsCommand?.params).toMatchObject({
        width: 7680,
        height: 4320,
      });
    });

    it('should handle all options disabled', () => {
      const fingerprint = createMockFingerprint();
      const options: StealthOptions = {
        timezone: false,
        geolocation: false,
        userAgent: false,
        deviceMetrics: false,
        touchEvents: false,
        mediaFeatures: false,
      };
      const commands = generateCDPCommands(fingerprint, options);

      // Should still include async call stack depth
      expect(commands.some((cmd) => cmd.method === 'Runtime.setAsyncCallStackDepth')).toBe(true);
    });
  });

  // ========== User-Agent Metadata 测试 ==========

  describe('User-Agent Metadata', () => {
    it('should build correct metadata for Windows', () => {
      const fingerprint = createMockFingerprint({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.6167.85 Safari/537.36',
      });
      const commands = generateCDPCommands(fingerprint);

      const uaCommand = commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride');
      const metadata = (uaCommand?.params as any)?.userAgentMetadata;

      expect(metadata).toBeDefined();
      expect(metadata.brands).toContainEqual({
        brand: 'Google Chrome',
        version: '121',
      });
      expect(metadata.fullVersion).toBe('121.0.6167.85');
      expect(metadata.platform).toBe('Windows');
    });

    it('should build correct metadata for macOS', () => {
      const fingerprint = createMockFingerprint({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36',
        platform: 'MacIntel',
      });
      const commands = generateCDPCommands(fingerprint);

      const uaCommand = commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride');
      const metadata = (uaCommand?.params as any)?.userAgentMetadata;

      expect(metadata.platform).toBe('macOS');
    });

    it('should build correct metadata for Linux', () => {
      const fingerprint = createMockFingerprint({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Linux x86_64',
      });
      const commands = generateCDPCommands(fingerprint);

      const uaCommand = commands.find((cmd) => cmd.method === 'Emulation.setUserAgentOverride');
      const metadata = (uaCommand?.params as any)?.userAgentMetadata;

      expect(metadata.platform).toBe('Linux');
    });
  });
});
