/**
 * 指纹配置默认值
 *
 * 统一的默认指纹配置，被多处使用：
 * - ProfileFormDialog (渲染进程)
 * - profile/presets (主进程)
 * - profile-service (主进程)
 *
 * v2.1 重构：
 * - 统一为单一的预设来源（SSOT）
 * - 使用 FingerprintPreset 类型替代自定义类型
 */

import type {
  AutomationEngine,
  BrowserIdentityBrowserFamily,
  BrowserIdentityFontSystem,
  BrowserIdentityOsFamily,
  FingerprintCoreConfig,
  DeepPartial,
  FingerprintConfig,
  FingerprintPreset,
  FingerprintSourceConfig,
  OSType,
  BrowserType,
} from '../types/profile';

// =====================================================
// 指纹预设选项（用于 UI 显示）
// =====================================================

type FingerprintPresetSeedScreen = {
  width: number;
  height: number;
  availWidth?: number;
  availHeight?: number;
  colorDepth?: number;
  pixelRatio?: number;
};

type FingerprintPresetSeedWebgl = {
  vendor: string;
  renderer: string;
  version?: string;
  glslVersion?: string;
};

type FingerprintPresetSeedConfig = {
  userAgent: string;
  platform: string;
  platformVersion?: string;
  language?: string;
  languages?: string[];
  timezone: string;
  os: 'Windows' | 'macOS' | 'Linux';
  browser: 'Chrome' | 'Firefox' | 'Edge';
  browserVersion?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screen?: FingerprintPresetSeedScreen;
  webgl?: FingerprintPresetSeedWebgl;
  fonts?: string[];
  touchSupport?: boolean;
  maxTouchPoints?: number;
};

type RawFingerprintPresetOption = {
  id: string;
  name: string;
  description: string;
  os: 'Windows' | 'macOS' | 'Linux';
  browser: 'Chrome' | 'Firefox' | 'Edge';
  config: FingerprintPresetSeedConfig;
};

/**
 * 指纹预设配置（用于 UI 显示，已经转换为 canonical fingerprint config）
 */
export interface FingerprintPresetOption {
  id: string;
  name: string;
  description: string;
  os: 'Windows' | 'macOS' | 'Linux';
  browser: 'Chrome' | 'Firefox' | 'Edge';
  config: FingerprintConfig;
}

/**
 * 指纹预设列表（用于 UI 显示）
 */
const RAW_FINGERPRINT_PRESET_OPTIONS: RawFingerprintPresetOption[] = [
  {
    id: 'windows-chrome-120',
    name: 'Windows 10 + Chrome 120',
    description: '最常见配置，NVIDIA GPU',
    os: 'Windows',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'Windows',
      browser: 'Chrome',
      browserVersion: '120.0.0.0',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        pixelRatio: 1,
      },
      webgl: {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      fonts: ['Arial', 'Times New Roman', 'Courier New', 'Microsoft YaHei'],
    },
  },
  {
    id: 'windows-chrome-121',
    name: 'Windows 10 + Chrome 121',
    description: 'RTX 3060 显卡',
    os: 'Windows',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'Windows',
      browser: 'Chrome',
      browserVersion: '121.0.0.0',
      hardwareConcurrency: 12,
      deviceMemory: 16,
      screen: {
        width: 2560,
        height: 1440,
        availWidth: 2560,
        availHeight: 1400,
        colorDepth: 24,
        pixelRatio: 1,
      },
      webgl: {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      fonts: ['Arial', 'Times New Roman', 'Courier New', 'Microsoft YaHei'],
    },
  },
  {
    id: 'windows-chrome-141',
    name: 'Windows 10 + Chrome 141',
    description: 'Chromium 141 稳定桌面基线，NVIDIA GPU',
    os: 'Windows',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'Windows',
      browser: 'Chrome',
      browserVersion: '141.0.0.0',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
      },
      webgl: {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
    },
  },
  {
    id: 'windows-chrome-intel',
    name: 'Windows 10 + Chrome (Intel)',
    description: 'Intel 集成显卡',
    os: 'Windows',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'Windows',
      browser: 'Chrome',
      browserVersion: '119.0.0.0',
      hardwareConcurrency: 4,
      deviceMemory: 8,
      screen: {
        width: 1366,
        height: 768,
        availWidth: 1366,
        availHeight: 728,
        colorDepth: 24,
        pixelRatio: 1,
      },
      webgl: {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      fonts: ['Arial', 'Times New Roman', 'Courier New', 'Microsoft YaHei'],
    },
  },
  {
    id: 'macos-chrome-m1',
    name: 'macOS Sonoma + Chrome (M1)',
    description: 'Apple Silicon M1',
    os: 'macOS',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      platformVersion: '14.0.0',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'macOS',
      browser: 'Chrome',
      browserVersion: '120.0.0.0',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: {
        width: 1440,
        height: 900,
        availWidth: 1440,
        availHeight: 875,
        colorDepth: 30,
        pixelRatio: 2,
      },
      webgl: {
        vendor: 'Apple Inc.',
        renderer: 'Apple M1',
      },
      fonts: ['Arial', 'Helvetica', 'Helvetica Neue', 'PingFang SC', 'Menlo'],
    },
  },
  {
    id: 'macos-chrome-m2',
    name: 'macOS Ventura + Chrome (M2)',
    description: 'Apple Silicon M2',
    os: 'macOS',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      platformVersion: '13.6.0',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'macOS',
      browser: 'Chrome',
      browserVersion: '121.0.0.0',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: {
        width: 2560,
        height: 1600,
        availWidth: 2560,
        availHeight: 1575,
        colorDepth: 30,
        pixelRatio: 2,
      },
      webgl: {
        vendor: 'Apple Inc.',
        renderer: 'Apple M2',
      },
      fonts: ['Arial', 'Helvetica', 'Helvetica Neue', 'PingFang SC', 'Menlo'],
    },
  },
  {
    id: 'linux-chrome-120',
    name: 'Ubuntu 22.04 + Chrome 120',
    description: 'Linux 桌面配置',
    os: 'Linux',
    browser: 'Chrome',
    config: {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh', 'en-US', 'en'],
      timezone: 'Asia/Shanghai',
      os: 'Linux',
      browser: 'Chrome',
      browserVersion: '120.0.0.0',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1053,
        colorDepth: 24,
        pixelRatio: 1,
      },
      webgl: {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)',
      },
      fonts: ['DejaVu Sans', 'DejaVu Sans Mono', 'Liberation Sans', 'Ubuntu', 'Noto Sans CJK SC'],
    },
  },
];

function clonePresetSeedConfig(config: FingerprintPresetSeedConfig): FingerprintPresetSeedConfig {
  return {
    ...config,
    languages: config.languages ? [...config.languages] : undefined,
    screen: config.screen ? { ...config.screen } : undefined,
    webgl: config.webgl ? { ...config.webgl } : undefined,
    fonts: config.fonts ? [...config.fonts] : undefined,
  };
}

function deriveRawPresetOption(options: {
  id: string;
  name: string;
  description: string;
  baseId: string;
  browser: RawFingerprintPresetOption['browser'];
  config: Partial<FingerprintPresetSeedConfig>;
}): RawFingerprintPresetOption {
  const base = RAW_FINGERPRINT_PRESET_OPTIONS.find((option) => option.id === options.baseId);
  if (!base) {
    throw new Error(`Missing base fingerprint preset: ${options.baseId}`);
  }

  const baseConfig = clonePresetSeedConfig(base.config);
  const overrideConfig = clonePresetSeedConfig(options.config as FingerprintPresetSeedConfig);

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    os: (options.config.os as RawFingerprintPresetOption['os'] | undefined) ?? base.os,
    browser: options.browser,
    config: {
      ...baseConfig,
      ...overrideConfig,
      os: overrideConfig.os ?? baseConfig.os,
      browser: options.browser,
      languages: overrideConfig.languages ?? baseConfig.languages,
      screen: overrideConfig.screen
        ? {
            ...baseConfig.screen,
            ...overrideConfig.screen,
          }
        : baseConfig.screen,
      webgl: overrideConfig.webgl
        ? {
            ...baseConfig.webgl,
            ...overrideConfig.webgl,
          }
        : baseConfig.webgl,
      fonts: overrideConfig.fonts ?? baseConfig.fonts,
    },
  };
}

const DERIVED_FINGERPRINT_PRESET_OPTIONS: RawFingerprintPresetOption[] = [
  deriveRawPresetOption({
    id: 'windows-edge-121',
    name: 'Windows 10 + Edge 121',
    description: 'Windows Edge 桌面配置',
    baseId: 'windows-chrome-121',
    browser: 'Edge',
    config: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
      browserVersion: '121.0.0.0',
    },
  }),
  deriveRawPresetOption({
    id: 'windows-firefox-151',
    name: 'Windows 10 + Firefox 151',
    description: 'Windows Firefox 桌面配置',
    baseId: 'windows-chrome-141',
    browser: 'Firefox',
    config: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
      browserVersion: '151.0',
    },
  }),
  deriveRawPresetOption({
    id: 'macos-edge-121',
    name: 'macOS Ventura + Edge 121',
    description: 'macOS Edge 桌面配置',
    baseId: 'macos-chrome-m2',
    browser: 'Edge',
    config: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
      browserVersion: '121.0.0.0',
    },
  }),
  deriveRawPresetOption({
    id: 'macos-firefox-151',
    name: 'macOS Sonoma + Firefox 151',
    description: 'macOS Firefox 桌面配置',
    baseId: 'macos-chrome-m1',
    browser: 'Firefox',
    config: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
      browserVersion: '151.0',
    },
  }),
  deriveRawPresetOption({
    id: 'linux-edge-120',
    name: 'Ubuntu 22.04 + Edge 120',
    description: 'Linux Edge 桌面配置',
    baseId: 'linux-chrome-120',
    browser: 'Edge',
    config: {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      browserVersion: '120.0.0.0',
    },
  }),
  deriveRawPresetOption({
    id: 'linux-firefox-151',
    name: 'Ubuntu 22.04 + Firefox 151',
    description: 'Linux Firefox 桌面配置',
    baseId: 'linux-chrome-120',
    browser: 'Firefox',
    config: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
      browserVersion: '151.0',
    },
  }),
];

// =====================================================
// GPU 配置选项
// =====================================================

export interface GPUVendorOption {
  vendor: string;
  renderers: string[];
}

/**
 * Windows GPU 选项
 */
export const WINDOWS_GPU_OPTIONS: GPUVendorOption[] = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderers: [
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderers: [
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderers: [
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
];

/**
 * macOS GPU 选项
 */
export const MACOS_GPU_OPTIONS: GPUVendorOption[] = [
  {
    vendor: 'Apple Inc.',
    renderers: ['Apple M1', 'Apple M1 Pro', 'Apple M1 Max', 'Apple M2', 'Apple M2 Pro', 'Apple M3'],
  },
  {
    vendor: 'Intel Inc.',
    renderers: [
      'Intel(R) Iris(TM) Plus Graphics 640',
      'Intel(R) Iris(TM) Plus Graphics 655',
      'Intel(R) UHD Graphics 630',
    ],
  },
];

/**
 * Linux GPU 选项
 */
export const LINUX_GPU_OPTIONS: GPUVendorOption[] = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderers: [
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.5)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
    ],
  },
  {
    vendor: 'Mesa',
    renderers: [
      'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
      'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
      'Mesa AMD Radeon RX 580',
    ],
  },
];

/**
 * 根据操作系统获取 GPU 选项
 */
export function getGPUOptions(os: 'Windows' | 'macOS' | 'Linux'): GPUVendorOption[] {
  switch (os) {
    case 'Windows':
      return WINDOWS_GPU_OPTIONS;
    case 'macOS':
      return MACOS_GPU_OPTIONS;
    case 'Linux':
      return LINUX_GPU_OPTIONS;
    default:
      return WINDOWS_GPU_OPTIONS;
  }
}

// =====================================================
// 字体配置
// =====================================================

/**
 * Windows 常用字体
 */
export const WINDOWS_FONTS = [
  'Arial',
  'Arial Black',
  'Calibri',
  'Cambria',
  'Consolas',
  'Courier New',
  'Georgia',
  'Impact',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'Segoe UI',
  'SimHei',
  'SimSun',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
];

/**
 * macOS 常用字体
 */
export const MACOS_FONTS = [
  'Arial',
  'Avenir',
  'Avenir Next',
  'Courier',
  'Courier New',
  'Geneva',
  'Georgia',
  'Helvetica',
  'Helvetica Neue',
  'Menlo',
  'Monaco',
  'PingFang SC',
  'San Francisco',
  'Times',
  'Times New Roman',
  'Verdana',
];

/**
 * Linux 常用字体
 */
export const LINUX_FONTS = [
  'DejaVu Sans',
  'DejaVu Sans Mono',
  'DejaVu Serif',
  'Droid Sans',
  'Droid Sans Mono',
  'Liberation Mono',
  'Liberation Sans',
  'Liberation Serif',
  'Noto Sans',
  'Noto Sans CJK SC',
  'Noto Serif',
  'Ubuntu',
  'Ubuntu Mono',
];

/**
 * 根据操作系统获取字体列表
 */
export function getFontsByOS(os: 'Windows' | 'macOS' | 'Linux'): string[] {
  switch (os) {
    case 'Windows':
      return WINDOWS_FONTS;
    case 'macOS':
      return MACOS_FONTS;
    case 'Linux':
      return LINUX_FONTS;
    default:
      return WINDOWS_FONTS;
  }
}

// =====================================================
// 屏幕分辨率选项
// =====================================================

export interface ScreenResolutionOption {
  label: string;
  width: number;
  height: number;
  pixelRatio?: number;
}

/**
 * 常用屏幕分辨率
 */
export const SCREEN_RESOLUTIONS: ScreenResolutionOption[] = [
  { label: '1366 x 768 (HD)', width: 1366, height: 768 },
  { label: '1440 x 900', width: 1440, height: 900 },
  { label: '1536 x 864', width: 1536, height: 864 },
  { label: '1600 x 900', width: 1600, height: 900 },
  { label: '1920 x 1080 (FHD)', width: 1920, height: 1080 },
  { label: '2560 x 1440 (QHD)', width: 2560, height: 1440 },
  { label: '2560 x 1600', width: 2560, height: 1600 },
  { label: '3840 x 2160 (4K)', width: 3840, height: 2160 },
];

/**
 * macOS Retina 分辨率
 */
export const MACOS_RETINA_RESOLUTIONS: ScreenResolutionOption[] = [
  { label: '1440 x 900 @2x (Retina)', width: 1440, height: 900, pixelRatio: 2 },
  { label: '1680 x 1050 @2x (Retina)', width: 1680, height: 1050, pixelRatio: 2 },
  { label: '1920 x 1200 @2x (Retina)', width: 1920, height: 1200, pixelRatio: 2 },
  { label: '2560 x 1600 @2x (Retina)', width: 2560, height: 1600, pixelRatio: 2 },
];

// =====================================================
// 硬件配置选项
// =====================================================

/**
 * CPU 核心数选项
 */
export const CPU_CORES_OPTIONS = [
  { value: 2, label: '2 核心' },
  { value: 4, label: '4 核心' },
  { value: 6, label: '6 核心' },
  { value: 8, label: '8 核心' },
  { value: 12, label: '12 核心' },
  { value: 16, label: '16 核心' },
];

/**
 * 设备内存选项 (GB)
 */
export const DEVICE_MEMORY_OPTIONS = [
  { value: 2, label: '2 GB' },
  { value: 4, label: '4 GB' },
  { value: 8, label: '8 GB' },
  { value: 16, label: '16 GB' },
  { value: 32, label: '32 GB' },
];

/**
 * 颜色深度选项
 */
export const COLOR_DEPTH_OPTIONS = [
  { value: 24, label: '24 位 (标准)' },
  { value: 30, label: '30 位 (HDR)' },
  { value: 32, label: '32 位' },
];

/**
 * 像素比选项
 */
export const PIXEL_RATIO_OPTIONS = [
  { value: 1, label: '1x (标准)' },
  { value: 1.25, label: '1.25x' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x (Retina)' },
  { value: 2.5, label: '2.5x' },
  { value: 3, label: '3x' },
];

/**
 * 最大触摸点数选项
 */
export const MAX_TOUCH_POINTS_OPTIONS = [
  { value: 0, label: '不支持触摸' },
  { value: 1, label: '1 点' },
  { value: 2, label: '2 点' },
  { value: 5, label: '5 点' },
  { value: 10, label: '10 点' },
];

// =====================================================
// 语言和时区选项
// =====================================================

/**
 * 常用语言选项
 */
export const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文 (zh-CN)' },
  { value: 'zh-TW', label: '繁体中文 (zh-TW)' },
  { value: 'en-US', label: '英语 - 美国 (en-US)' },
  { value: 'en-GB', label: '英语 - 英国 (en-GB)' },
  { value: 'ja-JP', label: '日语 (ja-JP)' },
  { value: 'ko-KR', label: '韩语 (ko-KR)' },
  { value: 'de-DE', label: '德语 (de-DE)' },
  { value: 'fr-FR', label: '法语 (fr-FR)' },
  { value: 'es-ES', label: '西班牙语 (es-ES)' },
  { value: 'pt-BR', label: '葡萄牙语 - 巴西 (pt-BR)' },
  { value: 'ru-RU', label: '俄语 (ru-RU)' },
  { value: 'ar-SA', label: '阿拉伯语 (ar-SA)' },
];

function toIdentityOsFamily(os: RawFingerprintPresetOption['os']): BrowserIdentityOsFamily {
  if (os === 'Windows') return 'windows';
  if (os === 'macOS') return 'macos';
  return 'linux';
}

function toIdentityBrowserFamily(
  browser: RawFingerprintPresetOption['browser']
): BrowserIdentityBrowserFamily {
  if (browser === 'Firefox') return 'firefox';
  return 'chromium';
}

function toFontSystem(osFamily: BrowserIdentityOsFamily): BrowserIdentityFontSystem {
  return osFamily === 'macos' ? 'mac' : osFamily;
}

const PLATFORM_BY_OS_FAMILY: Record<BrowserIdentityOsFamily, string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  linux: 'Linux x86_64',
};

function getDefaultWebglVersion(browserFamily: BrowserIdentityBrowserFamily): string {
  return browserFamily === 'firefox' ? 'WebGL 1.0' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
}

function getDefaultWebglGlslVersion(
  browserFamily: BrowserIdentityBrowserFamily,
  version: string
): string {
  const isWebgl2 = /webgl 2/i.test(version);
  if (browserFamily === 'firefox') {
    return isWebgl2 ? 'WebGL GLSL ES 3.00' : 'WebGL GLSL ES 1.0';
  }
  return isWebgl2
    ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'
    : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
}

function uniqStrings(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseBrowserVersionWeight(version: string | undefined): number {
  if (!version) return 0;
  const [major = '0', minor = '0'] = String(version).split('.');
  const majorNum = Number.parseInt(major, 10) || 0;
  const minorNum = Number.parseInt(minor, 10) || 0;
  return majorNum * 1000 + minorNum;
}

function buildFingerprintConfigFromSeed(seed: FingerprintPresetSeedConfig): FingerprintConfig {
  const osFamily = toIdentityOsFamily(seed.os);
  const browserFamily = toIdentityBrowserFamily(seed.browser);
  const languages = uniqStrings(
    Array.isArray(seed.languages) && seed.languages.length > 0
      ? seed.languages
      : seed.language
        ? [seed.language]
        : []
  );
  const primaryLanguage = seed.language || languages[0] || 'en-US';
  const screen = seed.screen ?? { width: 1920, height: 1080 };
  const maskedVendor = seed.webgl?.vendor?.trim() || undefined;
  const maskedRenderer = seed.webgl?.renderer?.trim() || undefined;
  const webglVersion = seed.webgl?.version?.trim() || getDefaultWebglVersion(browserFamily);

  return {
    identity: {
      region: {
        timezone: seed.timezone,
        primaryLanguage,
        languages: languages.length > 0 ? languages : [primaryLanguage],
      },
      hardware: {
        osFamily,
        browserFamily,
        browserVersion: seed.browserVersion,
        userAgent: seed.userAgent,
        platform: seed.platform,
        platformVersion: seed.platformVersion,
        hardwareConcurrency: seed.hardwareConcurrency ?? 8,
        deviceMemory: seed.deviceMemory ?? 8,
        fontSystem: toFontSystem(osFamily),
      },
      display: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth ?? screen.width,
        availHeight: screen.availHeight ?? Math.max(0, screen.height - 40),
        colorDepth: screen.colorDepth ?? 24,
        pixelRatio: screen.pixelRatio ?? 1,
      },
      graphics: {
        webgl:
          maskedVendor || maskedRenderer
            ? {
                maskedVendor,
                maskedRenderer,
                version: webglVersion,
                glslVersion:
                  seed.webgl?.glslVersion?.trim() ||
                  getDefaultWebglGlslVersion(browserFamily, webglVersion),
                unmaskedVendor: maskedVendor,
                unmaskedRenderer: maskedRenderer,
              }
            : undefined,
        canvasSeed: 1000,
      },
      typography: seed.fonts
        ? {
            fonts: [...seed.fonts],
          }
        : undefined,
      input: {
        touchSupport: seed.touchSupport ?? false,
        maxTouchPoints: seed.maxTouchPoints ?? 0,
      },
      automationSignals: {
        webdriver: 0,
      },
    },
    source: {
      mode: 'generated',
      fileFormat: 'txt',
    },
  };
}

function convertRawOption(option: RawFingerprintPresetOption): FingerprintPresetOption {
  return {
    ...option,
    config: buildFingerprintConfigFromSeed(option.config),
  };
}

const ALL_RAW_FINGERPRINT_PRESET_OPTIONS: RawFingerprintPresetOption[] = [
  ...RAW_FINGERPRINT_PRESET_OPTIONS,
  ...DERIVED_FINGERPRINT_PRESET_OPTIONS,
];

export const FINGERPRINT_PRESET_OPTIONS: FingerprintPresetOption[] =
  ALL_RAW_FINGERPRINT_PRESET_OPTIONS.map(convertRawOption);

/**
 * 常用时区选项
 */
export const TIMEZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: '香港时间 (UTC+8)' },
  { value: 'Asia/Taipei', label: '台北时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '东京时间 (UTC+9)' },
  { value: 'Asia/Seoul', label: '首尔时间 (UTC+9)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (UTC+8)' },
  { value: 'America/New_York', label: '美东时间 (UTC-5/-4)' },
  { value: 'America/Los_Angeles', label: '美西时间 (UTC-8/-7)' },
  { value: 'America/Chicago', label: '芝加哥时间 (UTC-6/-5)' },
  { value: 'Europe/London', label: '伦敦时间 (UTC+0/+1)' },
  { value: 'Europe/Paris', label: '巴黎时间 (UTC+1/+2)' },
  { value: 'Europe/Berlin', label: '柏林时间 (UTC+1/+2)' },
  { value: 'Europe/Moscow', label: '莫斯科时间 (UTC+3)' },
  { value: 'Australia/Sydney', label: '悉尼时间 (UTC+10/+11)' },
];

const DEFAULT_PRESET_ID_BY_ENGINE: Record<AutomationEngine, string> = {
  electron: 'windows-chrome-120',
  extension: 'windows-chrome-141',
  ruyi: 'windows-firefox-151',
};

function resolveDefaultPresetOption(engine: AutomationEngine): FingerprintPresetOption {
  const option =
    FINGERPRINT_PRESET_OPTIONS.find(
      (preset) => preset.id === DEFAULT_PRESET_ID_BY_ENGINE[engine]
    ) ?? FINGERPRINT_PRESET_OPTIONS[0];
  if (!option) {
    throw new Error('Missing fingerprint preset options');
  }
  return option;
}

const DEFAULT_FINGERPRINT_CONFIG_BY_ENGINE: Readonly<Record<AutomationEngine, FingerprintConfig>> =
  Object.freeze({
    electron: normalizeFingerprintConfigForEngine(
      cloneFingerprintConfig(resolveDefaultPresetOption('electron').config),
      'electron'
    ),
    extension: normalizeFingerprintConfigForEngine(
      cloneFingerprintConfig(resolveDefaultPresetOption('extension').config),
      'extension'
    ),
    ruyi: normalizeFingerprintConfigForEngine(
      cloneFingerprintConfig(resolveDefaultPresetOption('ruyi').config),
      'ruyi'
    ),
  });

/**
 * 默认指纹配置 - Extension/Electron 默认走 Chromium 桌面画像
 */
export const DEFAULT_FINGERPRINT_CONFIG: FingerprintConfig =
  DEFAULT_FINGERPRINT_CONFIG_BY_ENGINE.extension;

function getBrowserFamilyForEngine(engine: AutomationEngine): BrowserIdentityBrowserFamily {
  if (engine === 'ruyi') {
    return 'firefox';
  }
  if (engine === 'electron') {
    return 'electron';
  }
  return 'chromium';
}

function toPresetOptionOS(osFamily: OSType): FingerprintPresetOption['os'] {
  if (osFamily === 'macos') return 'macOS';
  if (osFamily === 'linux') return 'Linux';
  return 'Windows';
}

function toPresetOptionBrowser(browser: BrowserType): FingerprintPresetOption['browser'] {
  if (browser === 'firefox') return 'Firefox';
  if (browser === 'edge') return 'Edge';
  return 'Chrome';
}

function detectBrowserType(config: FingerprintConfig): BrowserType {
  if (config.identity.hardware.browserFamily === 'firefox') {
    return 'firefox';
  }
  if (config.identity.hardware.userAgent.includes('Edg/')) {
    return 'edge';
  }
  return 'chrome';
}

function resolvePresetOptionForCore(
  core: FingerprintCoreConfig,
  engine: AutomationEngine
): FingerprintPresetOption {
  const targetOs = toPresetOptionOS(core.osFamily);
  const targetBrowser = toPresetOptionBrowser(core.browserProfile.browser);
  const explicitPreset =
    core.browserProfile.presetId && core.browserProfile.presetId !== 'custom'
      ? FINGERPRINT_PRESET_OPTIONS.find((preset) => preset.id === core.browserProfile.presetId)
      : undefined;
  if (
    explicitPreset &&
    explicitPreset.os === targetOs &&
    explicitPreset.browser === targetBrowser
  ) {
    return explicitPreset;
  }

  const candidates = FINGERPRINT_PRESET_OPTIONS.filter(
    (preset) => preset.os === targetOs && preset.browser === targetBrowser
  );

  if (core.browserProfile.version) {
    const exactVersion = candidates.find(
      (preset) => preset.config.identity.hardware.browserVersion === core.browserProfile.version
    );
    if (exactVersion) {
      return exactVersion;
    }
  }

  return (
    candidates
      .slice()
      .sort(
        (a, b) =>
          parseBrowserVersionWeight(b.config.identity.hardware.browserVersion) -
          parseBrowserVersionWeight(a.config.identity.hardware.browserVersion)
      )[0] ?? resolveDefaultPresetOption(engine)
  );
}

export function extractFingerprintCoreConfig(config: FingerprintConfig): FingerprintCoreConfig {
  const languages = uniqStrings(config.identity.region.languages);
  const primaryLanguage =
    languages[0] || String(config.identity.region.primaryLanguage || '').trim() || 'en-US';

  return {
    osFamily: config.identity.hardware.osFamily,
    browserProfile: {
      browser: detectBrowserType(config),
      version: config.identity.hardware.browserVersion,
    },
    locale: {
      languages: languages.length > 0 ? languages : [primaryLanguage],
      timezone: config.identity.region.timezone,
    },
    hardware: {
      hardwareConcurrency: config.identity.hardware.hardwareConcurrency,
      deviceMemory: config.identity.hardware.deviceMemory,
    },
    display: {
      width: config.identity.display.width,
      height: config.identity.display.height,
    },
    graphics: {
      maskedVendor: config.identity.graphics?.webgl?.maskedVendor,
      maskedRenderer: config.identity.graphics?.webgl?.maskedRenderer,
    },
  };
}

export function mergeFingerprintCoreConfig(
  base: FingerprintCoreConfig,
  overrides: DeepPartial<FingerprintCoreConfig>
): FingerprintCoreConfig {
  const languages = Array.isArray(overrides.locale?.languages)
    ? uniqStrings(overrides.locale.languages)
    : [...base.locale.languages];

  return {
    osFamily: overrides.osFamily ?? base.osFamily,
    browserProfile: {
      browser: overrides.browserProfile?.browser ?? base.browserProfile.browser,
      version: overrides.browserProfile?.version ?? base.browserProfile.version,
      presetId: overrides.browserProfile?.presetId ?? base.browserProfile.presetId,
    },
    locale: {
      languages,
      timezone: overrides.locale?.timezone ?? base.locale.timezone,
    },
    hardware: {
      hardwareConcurrency:
        overrides.hardware?.hardwareConcurrency ?? base.hardware.hardwareConcurrency,
      deviceMemory: overrides.hardware?.deviceMemory ?? base.hardware.deviceMemory,
    },
    display: {
      width: overrides.display?.width ?? base.display.width,
      height: overrides.display?.height ?? base.display.height,
      screenPresetId: overrides.display?.screenPresetId ?? base.display.screenPresetId,
    },
    graphics: {
      gpuProfileId: overrides.graphics?.gpuProfileId ?? base.graphics.gpuProfileId,
      maskedVendor: overrides.graphics?.maskedVendor ?? base.graphics.maskedVendor,
      maskedRenderer: overrides.graphics?.maskedRenderer ?? base.graphics.maskedRenderer,
    },
  };
}

export function materializeFingerprintConfigFromCore(
  core: FingerprintCoreConfig,
  _source: Partial<FingerprintSourceConfig> | undefined,
  engine: AutomationEngine
): FingerprintConfig {
  const preset = resolvePresetOptionForCore(core, engine);

  return materializeFingerprintConfigForEngine(
    mergeFingerprintConfig(cloneFingerprintConfig(preset.config), {
      identity: {
        hardware: {
          osFamily: core.osFamily,
          hardwareConcurrency: core.hardware.hardwareConcurrency,
          deviceMemory: core.hardware.deviceMemory,
        },
        region: {
          languages: core.locale.languages,
          timezone: core.locale.timezone,
        },
        display: {
          width: core.display.width,
          height: core.display.height,
        },
        graphics: {
          webgl: {
            maskedVendor: core.graphics.maskedVendor,
            maskedRenderer: core.graphics.maskedRenderer,
          },
        },
      },
      source: {
        mode: 'generated',
        fileFormat: 'txt',
      },
    }),
    engine
  );
}

export function materializeFingerprintConfigForEngine(
  config: FingerprintConfig,
  engine: AutomationEngine
): FingerprintConfig {
  const materialized = cloneFingerprintConfig(config);
  const browserFamily = getBrowserFamilyForEngine(engine);
  const osFamily = materialized.identity.hardware.osFamily;
  const languages = uniqStrings(materialized.identity.region.languages);
  const primaryLanguage =
    languages[0] ||
    String(materialized.identity.region.primaryLanguage || '').trim() ||
    'en-US';
  const webgl = materialized.identity.graphics?.webgl;

  materialized.identity.region.primaryLanguage = primaryLanguage;
  materialized.identity.region.languages = languages.length > 0 ? languages : [primaryLanguage];
  materialized.identity.hardware.platform = PLATFORM_BY_OS_FAMILY[osFamily];
  materialized.identity.hardware.fontSystem = toFontSystem(osFamily);
  materialized.identity.display.availWidth = materialized.identity.display.width;
  materialized.identity.display.availHeight = Math.max(0, materialized.identity.display.height - 40);
  materialized.identity.display.colorDepth =
    typeof materialized.identity.display.colorDepth === 'number' &&
    Number.isFinite(materialized.identity.display.colorDepth) &&
    materialized.identity.display.colorDepth > 0
      ? materialized.identity.display.colorDepth
      : 24;

  if (
    engine === 'electron' &&
    !(
      typeof materialized.identity.display.pixelRatio === 'number' &&
      Number.isFinite(materialized.identity.display.pixelRatio) &&
      materialized.identity.display.pixelRatio > 0
    )
  ) {
    materialized.identity.display.pixelRatio = 1;
  }

  if (webgl) {
    const version = webgl.version?.trim() || getDefaultWebglVersion(browserFamily);
    webgl.version = version;
    webgl.glslVersion = webgl.glslVersion?.trim() || getDefaultWebglGlslVersion(browserFamily, version);
    webgl.unmaskedVendor = webgl.unmaskedVendor ?? webgl.maskedVendor;
    webgl.unmaskedRenderer = webgl.unmaskedRenderer ?? webgl.maskedRenderer;
  }

  materialized.identity.automationSignals = {
    ...materialized.identity.automationSignals,
    webdriver: 0,
  };

  return normalizeFingerprintConfigForEngine(materialized, engine);
}

export function normalizeFingerprintConfigForEngine(
  config: FingerprintConfig,
  engine: AutomationEngine
): FingerprintConfig {
  const normalized = cloneFingerprintConfig(config);
  const browserFamily = getBrowserFamilyForEngine(engine);

  normalized.identity.hardware.browserFamily = browserFamily;

  normalized.source.mode = 'generated';

  if (engine === 'extension') {
    normalized.identity.hardware.platformVersion = undefined;
    normalized.identity.hardware.fontSystem = undefined;
    normalized.identity.display.pixelRatio = undefined;
    const stableWebgl = normalized.identity.graphics?.webgl
      ? (() => {
          const version =
            normalized.identity.graphics.webgl.version?.trim() ||
            getDefaultWebglVersion(browserFamily);
          return {
            maskedVendor: normalized.identity.graphics.webgl.maskedVendor,
            maskedRenderer: normalized.identity.graphics.webgl.maskedRenderer,
            version,
            glslVersion:
              normalized.identity.graphics.webgl.glslVersion?.trim() ||
              getDefaultWebglGlslVersion(browserFamily, version),
            unmaskedVendor:
              normalized.identity.graphics.webgl.unmaskedVendor ??
              normalized.identity.graphics.webgl.maskedVendor,
            unmaskedRenderer:
              normalized.identity.graphics.webgl.unmaskedRenderer ??
              normalized.identity.graphics.webgl.maskedRenderer,
          };
        })()
      : undefined;
    normalized.identity.graphics = stableWebgl ? { webgl: stableWebgl } : undefined;
    normalized.identity.typography = undefined;
    normalized.identity.network = undefined;
    normalized.identity.speech = undefined;
    normalized.identity.input = {
      touchSupport: false,
      maxTouchPoints: 0,
    };
  }

  if (engine === 'ruyi') {
    normalized.identity.display.pixelRatio = undefined;
    normalized.identity.input = undefined;
  }

  normalized.source.fileFormat = 'txt';

  return normalized;
}

/**
 * 获取默认指纹配置的副本
 * 每次调用返回新对象，避免意外修改
 */
export function getDefaultFingerprint(engine: AutomationEngine = 'extension'): FingerprintConfig {
  return normalizeFingerprintConfigForEngine(
    cloneFingerprintConfig(
      DEFAULT_FINGERPRINT_CONFIG_BY_ENGINE[engine] ?? DEFAULT_FINGERPRINT_CONFIG
    ),
    engine
  );
}

export function getDefaultFingerprintForEngine(engine: AutomationEngine): FingerprintConfig {
  return getDefaultFingerprint(engine);
}

// =====================================================
// 主进程使用的预设（转换为 FingerprintPreset 类型）
// =====================================================

export function cloneFingerprintConfig(config: FingerprintConfig): FingerprintConfig {
  return {
    identity: {
      region: {
        timezone: config.identity.region.timezone,
        primaryLanguage: config.identity.region.primaryLanguage,
        languages: [...config.identity.region.languages],
      },
      hardware: {
        ...config.identity.hardware,
      },
      display: {
        ...config.identity.display,
      },
      graphics: config.identity.graphics
        ? {
            ...config.identity.graphics,
            webgl: config.identity.graphics.webgl
              ? {
                  ...config.identity.graphics.webgl,
                  supportedExt: config.identity.graphics.webgl.supportedExt
                    ? [...config.identity.graphics.webgl.supportedExt]
                    : undefined,
                  extensionParameters: config.identity.graphics.webgl.extensionParameters
                    ? { ...config.identity.graphics.webgl.extensionParameters }
                    : undefined,
                  contextAttributes: config.identity.graphics.webgl.contextAttributes
                    ? { ...config.identity.graphics.webgl.contextAttributes }
                    : undefined,
                }
              : undefined,
          }
        : undefined,
      typography: config.identity.typography
        ? {
            fonts: config.identity.typography.fonts
              ? [...config.identity.typography.fonts]
              : undefined,
            textMetrics: config.identity.typography.textMetrics
              ? { ...config.identity.typography.textMetrics }
              : undefined,
          }
        : undefined,
      network: config.identity.network
        ? {
            ...config.identity.network,
            proxyAuth: config.identity.network.proxyAuth
              ? { ...config.identity.network.proxyAuth }
              : undefined,
          }
        : undefined,
      speech: config.identity.speech
        ? {
            localNames: config.identity.speech.localNames
              ? [...config.identity.speech.localNames]
              : undefined,
            remoteNames: config.identity.speech.remoteNames
              ? [...config.identity.speech.remoteNames]
              : undefined,
            localLangs: config.identity.speech.localLangs
              ? [...config.identity.speech.localLangs]
              : undefined,
            remoteLangs: config.identity.speech.remoteLangs
              ? [...config.identity.speech.remoteLangs]
              : undefined,
            defaultName: config.identity.speech.defaultName,
            defaultLang: config.identity.speech.defaultLang,
          }
        : undefined,
      input: config.identity.input ? { ...config.identity.input } : undefined,
      automationSignals: config.identity.automationSignals
        ? { ...config.identity.automationSignals }
        : undefined,
    },
    source: {
      ...config.source,
    },
  };
}

export function mergeFingerprintConfig(
  base: FingerprintConfig,
  overrides: DeepPartial<FingerprintConfig>
): FingerprintConfig {
  const cloned = cloneFingerprintConfig(base);
  const identity = overrides.identity ?? {};
  const region = identity.region ?? {};
  const hardware = identity.hardware ?? {};
  const display = identity.display ?? {};
  const graphics = identity.graphics ?? {};
  const webgl = graphics.webgl ?? {};
  const typography = identity.typography ?? {};
  const network = identity.network ?? {};
  const speech = identity.speech ?? {};
  const input = identity.input ?? {};
  const automationSignals = identity.automationSignals ?? {};
  const mergedLanguages = Array.isArray(region.languages)
    ? uniqStrings(region.languages)
    : [...cloned.identity.region.languages];
  const primaryLanguage =
    typeof region.primaryLanguage === 'string' && region.primaryLanguage.trim()
      ? region.primaryLanguage.trim()
      : mergedLanguages[0] || cloned.identity.region.primaryLanguage;
  return {
    identity: {
      region: {
        timezone: region.timezone ?? cloned.identity.region.timezone,
        primaryLanguage,
        languages: mergedLanguages.length > 0 ? mergedLanguages : [primaryLanguage],
      },
      hardware: {
        ...cloned.identity.hardware,
        ...hardware,
      },
      display: {
        ...cloned.identity.display,
        ...display,
      },
      graphics:
        cloned.identity.graphics || graphics
          ? {
              ...cloned.identity.graphics,
              ...graphics,
              webgl:
                cloned.identity.graphics?.webgl || webgl
                  ? {
                      ...cloned.identity.graphics?.webgl,
                      ...webgl,
                      supportedExt: Array.isArray(webgl.supportedExt)
                        ? [...webgl.supportedExt]
                        : cloned.identity.graphics?.webgl?.supportedExt
                          ? [...cloned.identity.graphics.webgl.supportedExt]
                          : undefined,
                      extensionParameters: webgl.extensionParameters
                        ? { ...webgl.extensionParameters }
                        : cloned.identity.graphics?.webgl?.extensionParameters
                          ? { ...cloned.identity.graphics.webgl.extensionParameters }
                          : undefined,
                      contextAttributes: webgl.contextAttributes
                        ? { ...webgl.contextAttributes }
                        : cloned.identity.graphics?.webgl?.contextAttributes
                          ? { ...cloned.identity.graphics.webgl.contextAttributes }
                          : undefined,
                    }
                  : undefined,
            }
          : undefined,
      typography:
        cloned.identity.typography || typography
          ? {
              ...cloned.identity.typography,
              ...typography,
              fonts: Array.isArray(typography.fonts)
                ? [...typography.fonts]
                : cloned.identity.typography?.fonts
                  ? [...cloned.identity.typography.fonts]
                  : undefined,
              textMetrics: typography.textMetrics
                ? {
                    ...cloned.identity.typography?.textMetrics,
                    ...typography.textMetrics,
                  }
                : cloned.identity.typography?.textMetrics
                  ? { ...cloned.identity.typography.textMetrics }
                  : undefined,
            }
          : undefined,
      network:
        cloned.identity.network || network
          ? {
              ...cloned.identity.network,
              ...network,
              proxyAuth: network.proxyAuth
                ? { ...cloned.identity.network?.proxyAuth, ...network.proxyAuth }
                : cloned.identity.network?.proxyAuth
                  ? { ...cloned.identity.network.proxyAuth }
                  : undefined,
            }
          : undefined,
      speech:
        cloned.identity.speech || speech
          ? {
              ...cloned.identity.speech,
              ...speech,
              localNames: Array.isArray(speech.localNames)
                ? [...speech.localNames]
                : cloned.identity.speech?.localNames
                  ? [...cloned.identity.speech.localNames]
                  : undefined,
              remoteNames: Array.isArray(speech.remoteNames)
                ? [...speech.remoteNames]
                : cloned.identity.speech?.remoteNames
                  ? [...cloned.identity.speech.remoteNames]
                  : undefined,
              localLangs: Array.isArray(speech.localLangs)
                ? [...speech.localLangs]
                : cloned.identity.speech?.localLangs
                  ? [...cloned.identity.speech.localLangs]
                  : undefined,
              remoteLangs: Array.isArray(speech.remoteLangs)
                ? [...speech.remoteLangs]
                : cloned.identity.speech?.remoteLangs
                  ? [...cloned.identity.speech.remoteLangs]
                  : undefined,
            }
          : undefined,
      input:
        cloned.identity.input || input
          ? {
              ...cloned.identity.input,
              ...input,
            }
          : undefined,
      automationSignals:
        cloned.identity.automationSignals || automationSignals
          ? {
              ...cloned.identity.automationSignals,
              ...automationSignals,
            }
          : undefined,
    },
    source: {
      mode: 'generated',
      fileFormat: 'txt',
    },
  };
}

/**
 * OS 名称映射（UI 显示名称 -> 内部类型）
 */
const osNameMap: Record<'Windows' | 'macOS' | 'Linux', OSType> = {
  Windows: 'windows',
  macOS: 'macos',
  Linux: 'linux',
};

/**
 * Browser 名称映射（UI 显示名称 -> 内部类型）
 */
const browserNameMap: Record<'Chrome' | 'Firefox' | 'Edge', BrowserType> = {
  Chrome: 'chrome',
  Firefox: 'firefox',
  Edge: 'edge',
};

/**
 * 将 FingerprintPresetOption 转换为 FingerprintPreset
 * 用于主进程使用（需要小写的 os/browser 字段）
 */
function convertToPreset(option: FingerprintPresetOption): FingerprintPreset {
  return {
    id: option.id,
    name: option.name,
    description: option.description,
    os: osNameMap[option.os],
    browser: browserNameMap[option.browser],
    config: cloneFingerprintConfig(option.config),
  };
}

/**
 * 主进程使用的预设列表（FingerprintPreset[] 类型）
 *
 * 这是预设数据的单一来源（SSOT），供以下模块使用：
 * - main/profile/presets/index.ts
 * - 其他需要 FingerprintPreset 类型的模块
 */
export const FINGERPRINT_PRESETS: FingerprintPreset[] =
  FINGERPRINT_PRESET_OPTIONS.map(convertToPreset);

/**
 * 根据预设 ID 获取预设
 */
export function getPresetById(id: string): FingerprintPreset | undefined {
  return FINGERPRINT_PRESETS.find((p) => p.id === id);
}

/**
 * 根据 OS 获取预设列表
 */
export function getPresetsByOS(os: OSType): FingerprintPreset[] {
  return FINGERPRINT_PRESETS.filter((p) => p.os === os);
}
