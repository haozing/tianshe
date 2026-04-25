/**
 * 浏览器反检测（Stealth Mode）类型定义
 *
 * 提供完整的指纹配置和反检测选项
 */

/**
 * 屏幕配置（Stealth 层）
 */
export interface StealthScreenConfig {
  /** 屏幕宽度 */
  width: number;
  /** 屏幕高度 */
  height: number;
  /** 可用宽度 */
  availWidth?: number;
  /** 可用高度 */
  availHeight?: number;
  /** 颜色深度 */
  colorDepth?: number;
  /** 像素比 */
  pixelRatio?: number;
}

/**
 * Stealth 配置
 *
 * 用于在创建浏览器时配置反检测行为
 *
 * v2 重构：
 * - 添加完整的硬件配置字段
 * - 添加噪声开关和级别配置
 * - 与 FingerprintConfig（Profile 层）字段对齐
 */
export interface StealthConfig {
  /**
   * 是否启用反检测
   * @default false
   */
  enabled: boolean;

  /**
   * 指纹身份 Key（与 Electron partition 解耦）
   *
   * 用途：
   * - 支持“换会话/换 partition，但指纹保持不变”的场景：多个 partition 复用同一个 identityKey
   * - 支持“同一 identityKey 多个实例”保持一致（BrowserFingerprint 级别一致性）
   *
   * 注意：
   * - `identityKey` 只影响运行时指纹缓存的 key，不会自动改变浏览器存储（cookie/localStorage 等仍由 partition 决定）
   * - 若上层在运行中更改指纹配置，需要同时清理对应 identityKey 的缓存
   */
  identityKey?: string;

  /**
   * 预设指纹配置 ID（优先级高于自定义配置）
   *
   * 可选值（参考 fingerprint-defaults.ts）：
   * - 'windows-chrome-120' - Windows 10 + Chrome 120 + NVIDIA GPU
   * - 'windows-chrome-121' - Windows 10 + Chrome 121 + RTX 3060
   * - 'windows-chrome-intel' - Windows 10 + Chrome + Intel 集成显卡
   * - 'macos-chrome-m1' - macOS Sonoma + Chrome 120 + Apple M1
   * - 'macos-chrome-m2' - macOS Ventura + Chrome 121 + Apple M2
   * - 'linux-chrome-120' - Ubuntu 22.04 + Chrome 120 + NVIDIA GPU
   *
   * @example
   * stealth: {
   *   enabled: true,
   *   fingerprint: 'windows-chrome-120'
   * }
   */
  fingerprint?: string;

  // ========== 基础信息 ==========

  /**
   * 自定义 User-Agent
   */
  userAgent?: string;

  /**
   * 自定义 Platform
   * 常见值：'Win32' | 'MacIntel' | 'Linux x86_64'
   */
  platform?: string;

  /**
   * UA-CH platformVersion override (e.g., "14.0.0").
   */
  platformVersion?: string;

  /**
   * 语言列表
   * @default ['en-US', 'en']
   */
  languages?: string[];

  /**
   * 时区（IANA 时区标识符）
   * @default 'America/New_York'
   */
  timezone?: string;

  // ========== 硬件信息 ==========

  /**
   * CPU 核心数
   * @default 8
   */
  hardwareConcurrency?: number;

  /**
   * 设备内存（GB）
   * @default 8
   */
  deviceMemory?: number;

  /**
   * 屏幕配置
   */
  screen?: StealthScreenConfig;

  // ========== WebGL ==========

  /**
   * WebGL 配置
   */
  webgl?: {
    /** WebGL Vendor */
    vendor: string;
    /** WebGL Renderer */
    renderer: string;
    /** WebGL 版本 */
    version?: string;
  };

  // ========== 噪声配置 ==========

  /**
   * Canvas 噪声注入
   * @default true
   */
  canvasNoise?: boolean;

  /**
   * Canvas 噪声级别 (0-1)
   * @default 0.1
   */
  canvasNoiseLevel?: number;

  /**
   * Audio 噪声注入
   * @default false
   */
  audioNoise?: boolean;

  /**
   * Audio 噪声级别 (0-1)
   * @default 0.01
   */
  audioNoiseLevel?: number;

  /**
   * WebGL 噪声注入
   * @default false
   */
  webglNoise?: boolean;

  // ========== 其他特性 ==========

  /**
   * 可用字体列表
   */
  fonts?: string[];

  /**
   * 是否支持触摸
   * @default false
   */
  touchSupport?: boolean;

  /**
   * 最大触摸点数
   * @default 0
   */
  maxTouchPoints?: number;
}

/**
 * 完整的浏览器指纹配置
 *
 * 包含所有需要伪装的浏览器特征
 *
 * v2 重构：
 * - 添加完整的屏幕配置（availWidth/Height, pixelRatio）
 * - 添加字体列表
 * - 添加触摸支持
 * - 添加噪声级别配置
 * - 与 FingerprintConfig（Profile 层）和 StealthConfig 字段对齐
 */
export interface BrowserFingerprint {
  // ========== 基础信息 ==========

  /** User-Agent 字符串 */
  userAgent: string;

  /** Platform（navigator.platform） */
  platform: string;

  /** UA-CH platformVersion override (optional). */
  platformVersion?: string;

  /** 语言列表（navigator.languages） */
  languages: string[];

  /** 时区（IANA 时区标识符） */
  timezone: string;

  // ========== 硬件信息 ==========

  /** CPU 核心数（navigator.hardwareConcurrency） */
  hardwareConcurrency: number;

  /** 设备内存（GB）（navigator.deviceMemory） */
  deviceMemory: number;

  /** 屏幕分辨率 */
  screenResolution: {
    width: number;
    height: number;
    /** 可用宽度（减去任务栏等） */
    availWidth?: number;
    /** 可用高度 */
    availHeight?: number;
  };

  /** 颜色深度（screen.colorDepth） */
  colorDepth: number;

  /** 像素比（window.devicePixelRatio） */
  pixelRatio?: number;

  // ========== WebGL 信息 ==========

  webgl: {
    /** WebGL Vendor（如 "Google Inc. (NVIDIA)"） */
    vendor: string;

    /** WebGL Renderer（如 "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti ...)"） */
    renderer: string;

    /** WebGL 版本（如 "WebGL 1.0 (OpenGL ES 2.0 Chromium)"） */
    version: string;
  };

  // ========== 插件列表 ==========

  /**
   * 浏览器插件列表（navigator.plugins）
   *
   * Chrome 默认插件：
   * - Chrome PDF Plugin
   * - Chrome PDF Viewer
   * - Native Client
   */
  plugins: PluginInfo[];

  // ========== 字体列表 ==========

  /**
   * 可用字体列表
   *
   * 用于字体指纹伪装，不同操作系统有不同的默认字体
   */
  fonts?: string[];

  // ========== 触摸支持 ==========

  /**
   * 是否支持触摸
   * @default false
   */
  touchSupport?: boolean;

  /**
   * 最大触摸点数（navigator.maxTouchPoints）
   * @default 0
   */
  maxTouchPoints?: number;

  // ========== Canvas 配置 ==========

  /**
   * Canvas 噪声配置
   *
   * 启用后会为 canvas 指纹添加确定性噪声，
   * 同一 canvas 内容始终产生相同的噪声结果。
   */
  canvas?: {
    /** 是否启用噪声注入 */
    noise: boolean;
    /** 噪声级别 (0-1)，默认 0.1 */
    noiseLevel?: number;
  };

  // ========== Audio 配置 ==========

  /**
   * Audio 噪声配置
   *
   * 启用后会为 AudioContext 指纹添加噪声
   */
  audio?: {
    /** 是否启用噪声注入 */
    noise: boolean;
    /** 噪声级别 (0-1)，默认 0.01 */
    noiseLevel?: number;
  };

  // ========== WebGL 噪声配置 ==========

  /**
   * WebGL 噪声配置
   *
   * 启用后会为 WebGL 参数添加轻微随机变化
   */
  webglNoise?: boolean;
}

/**
 * 浏览器插件信息
 */
export interface PluginInfo {
  /** 插件名称 */
  name: string;
  /** 插件文件名 */
  filename: string;
  /** 插件描述 */
  description: string;
  /** 支持的 MIME 类型列表 */
  mimeTypes?: MimeTypeInfo[];
}

/**
 * MIME 类型信息
 */
export interface MimeTypeInfo {
  /** MIME 类型（如 "application/pdf"） */
  type: string;
  /** 文件后缀（如 "pdf"） */
  suffixes: string;
  /** 描述 */
  description: string;
}

/**
 * 指纹验证结果
 */
export interface FingerprintValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 错误列表 */
  errors: string[];
}

/**
 * 时区信息
 */
export interface TimezoneInfo {
  /** IANA 时区标识符 */
  id: string;
  /** UTC 偏移量（分钟） */
  offset: number;
  /** 城市名称 */
  city?: string;
  /** 地理坐标 */
  location?: {
    latitude: number;
    longitude: number;
  };
}

/**
 * 脚本生成选项
 */
export interface ScriptGenerationOptions {
  /** 是否包含 WebGL 伪装 */
  webgl?: boolean;
  /** 是否包含 Canvas 噪声 */
  canvasNoise?: boolean;
  /** 是否包含 WebRTC 防护 */
  webrtcProtection?: boolean;
  /** 是否包含时区伪装 */
  timezone?: boolean;
  /** 是否包含电池 API 伪装 */
  battery?: boolean;
  /** 是否包含 AudioContext 防护 */
  audioContext?: boolean;
}
