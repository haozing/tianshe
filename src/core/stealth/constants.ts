/**
 * Stealth 模块常量定义
 *
 * 集中管理所有魔数和常量，避免分散在各文件中
 */

// ========== WebGL 参数常量 ==========

/**
 * WebGL getParameter 参数常量
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Constants
 */
export const WEBGL_PARAMS = {
  /** WebGL 版本字符串 */
  VERSION: 7938,
  /** 未屏蔽的 GPU 厂商（需要 WEBGL_debug_renderer_info 扩展） */
  UNMASKED_VENDOR_WEBGL: 37445,
  /** 未屏蔽的 GPU 渲染器（需要 WEBGL_debug_renderer_info 扩展） */
  UNMASKED_RENDERER_WEBGL: 37446,
} as const;

// ========== 时区相关常量 ==========

/**
 * 时区 UTC 偏移量映射（分钟）
 *
 * 正值表示 UTC- 时区，负值表示 UTC+ 时区
 * 例如：UTC-5 (EST) = 300 分钟
 *
 * 注意：此映射不考虑夏令时，仅用于基本伪装
 */
export const TIMEZONE_OFFSETS: Record<string, number> = {
  // 美洲
  'America/New_York': 300, // UTC-5 (EST)
  'America/Chicago': 360, // UTC-6 (CST)
  'America/Denver': 420, // UTC-7 (MST)
  'America/Los_Angeles': 480, // UTC-8 (PST)
  'America/Phoenix': 420, // UTC-7 (无夏令时)
  'America/Anchorage': 540, // UTC-9 (AKST)
  'America/Honolulu': 600, // UTC-10 (HST)
  'America/Toronto': 300, // UTC-5 (EST)
  'America/Vancouver': 480, // UTC-8 (PST)
  'America/Mexico_City': 360, // UTC-6 (CST)
  'America/Sao_Paulo': 180, // UTC-3 (BRT)

  // 欧洲
  'Europe/London': 0, // UTC+0 (GMT)
  'Europe/Paris': -60, // UTC+1 (CET)
  'Europe/Berlin': -60, // UTC+1 (CET)
  'Europe/Rome': -60, // UTC+1 (CET)
  'Europe/Madrid': -60, // UTC+1 (CET)
  'Europe/Amsterdam': -60, // UTC+1 (CET)
  'Europe/Moscow': -180, // UTC+3 (MSK)

  // 亚洲
  'Asia/Shanghai': -480, // UTC+8 (CST)
  'Asia/Tokyo': -540, // UTC+9 (JST)
  'Asia/Hong_Kong': -480, // UTC+8 (HKT)
  'Asia/Singapore': -480, // UTC+8 (SGT)
  'Asia/Seoul': -540, // UTC+9 (KST)
  'Asia/Taipei': -480, // UTC+8 (CST)
  'Asia/Bangkok': -420, // UTC+7 (ICT)
  'Asia/Dubai': -240, // UTC+4 (GST)
  'Asia/Kolkata': -330, // UTC+5:30 (IST)

  // 大洋洲
  'Australia/Sydney': -600, // UTC+10 (AEST)
  'Australia/Melbourne': -600, // UTC+10 (AEST)
  'Australia/Perth': -480, // UTC+8 (AWST)
  'Pacific/Auckland': -720, // UTC+12 (NZST)
};

/**
 * 时区对应的城市地理坐标
 *
 * 用于 CDP Emulation.setGeolocationOverride
 */
export const TIMEZONE_LOCATIONS: Record<string, { latitude: number; longitude: number }> = {
  // 美洲
  'America/New_York': { latitude: 40.7128, longitude: -74.006 }, // 纽约
  'America/Chicago': { latitude: 41.8781, longitude: -87.6298 }, // 芝加哥
  'America/Denver': { latitude: 39.7392, longitude: -104.9903 }, // 丹佛
  'America/Los_Angeles': { latitude: 34.0522, longitude: -118.2437 }, // 洛杉矶
  'America/Phoenix': { latitude: 33.4484, longitude: -112.074 }, // 凤凰城
  'America/Toronto': { latitude: 43.6532, longitude: -79.3832 }, // 多伦多
  'America/Vancouver': { latitude: 49.2827, longitude: -123.1207 }, // 温哥华
  'America/Mexico_City': { latitude: 19.4326, longitude: -99.1332 }, // 墨西哥城
  'America/Sao_Paulo': { latitude: -23.5505, longitude: -46.6333 }, // 圣保罗

  // 欧洲
  'Europe/London': { latitude: 51.5074, longitude: -0.1278 }, // 伦敦
  'Europe/Paris': { latitude: 48.8566, longitude: 2.3522 }, // 巴黎
  'Europe/Berlin': { latitude: 52.52, longitude: 13.405 }, // 柏林
  'Europe/Rome': { latitude: 41.9028, longitude: 12.4964 }, // 罗马
  'Europe/Madrid': { latitude: 40.4168, longitude: -3.7038 }, // 马德里
  'Europe/Amsterdam': { latitude: 52.3676, longitude: 4.9041 }, // 阿姆斯特丹
  'Europe/Moscow': { latitude: 55.7558, longitude: 37.6173 }, // 莫斯科

  // 亚洲
  'Asia/Shanghai': { latitude: 31.2304, longitude: 121.4737 }, // 上海
  'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 }, // 东京
  'Asia/Hong_Kong': { latitude: 22.3193, longitude: 114.1694 }, // 香港
  'Asia/Singapore': { latitude: 1.3521, longitude: 103.8198 }, // 新加坡
  'Asia/Seoul': { latitude: 37.5665, longitude: 126.978 }, // 首尔
  'Asia/Taipei': { latitude: 25.033, longitude: 121.5654 }, // 台北
  'Asia/Bangkok': { latitude: 13.7563, longitude: 100.5018 }, // 曼谷
  'Asia/Dubai': { latitude: 25.2048, longitude: 55.2708 }, // 迪拜
  'Asia/Kolkata': { latitude: 22.5726, longitude: 88.3639 }, // 加尔各答

  // 大洋洲
  'Australia/Sydney': { latitude: -33.8688, longitude: 151.2093 }, // 悉尼
  'Australia/Melbourne': { latitude: -37.8136, longitude: 144.9631 }, // 墨尔本
  'Australia/Perth': { latitude: -31.9505, longitude: 115.8605 }, // 珀斯
  'Pacific/Auckland': { latitude: -36.8485, longitude: 174.7633 }, // 奥克兰
};

/**
 * 默认时区
 */
export const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * 默认地理位置精度（米）
 */
export const DEFAULT_GEOLOCATION_ACCURACY = 100;

// ========== 自动化工具特征 ==========

/**
 * 常见自动化工具在 window 上注入的对象名
 *
 * 用于清理自动化痕迹
 */
export const AUTOMATION_WINDOW_OBJECTS = [
  // Selenium
  'domAutomation',
  'domAutomationController',
  '_Selenium_IDE_Recorder',
  '_selenium',
  'callSelenium',
  '_WEBDRIVER_ELEM_CACHE',
  'webdriver',
  '__webdriverFunc',
  '__lastWatirAlert',
  '__lastWatirConfirm',
  '__lastWatirPrompt',
  '__selenium_unwrapped',
  '__webdriver_unwrapped',
  '__driver_evaluate',
  '__webdriver_evaluate',
  '__selenium_evaluate',
  '__fxdriver_evaluate',
  '__driver_unwrapped',
  '__webdriver_script_function',
  '__webdriver_script_func',
  '__webdriver_script_fn',
  '__fxdriver_unwrapped',

  // Puppeteer / Chrome DevTools
  'cdc_adoQpoasnfa76pfcZLmcfl_Array',
  'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
  'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',

  // Watir / Selenium helpers
  'ChromeDriverw',
  'ClientUtils',
  '__utils__',

  // NW.js
  '__nw_windows',
  '__nw_remove_all_listeners',
  '__nw_ondestruct',
  '__nw_removeOuterEventCB',
  '__nw_ondocumentcreated',
  '__nw_initwindow',

  // BrowserAutomationStudio
  'BrowserAutomationStudio_GetFrameIndex',
  'BrowserAutomationStudio_Open',
  'BrowserAutomationStudio_GetInternalBoundingRect',
  'BrowserAutomationStudio_ScrollToElement',
  'BrowserAutomationStudio_ScrollToCoordinates',
  'BrowserAutomationStudio_ScrollUp',
  'BrowserAutomationStudio_ScrollToCoordinatesNoResult',
  'BrowserAutomationStudio_FindElement',
  'BrowserAutomationStudio_Sleep',
  'browser_automation_studio_frame_find_result',
  'browser_automation_studio_eval',
  'browser_automation_studio_result',
  'browser_automation_studio_inspect_result',
  'BrowserAutomationStudio_RecaptchaSolved',
  'BrowserAutomationStudio_OriginalDate',
  'BrowserAutomationStudio_MatchAllIteration',
  'BrowserAutomationStudio_SetGeolocation',
  'BrowserAutomationStudio_GeolocationRestore',

  // Nightmare.js
  '__nightmare',

  // PhantomJS
  '__phantomas',
  'callPhantom',
  '_phantom',
] as const;

/**
 * 常见自动化工具在 document 上注入的对象名
 *
 * 用于清理 document 层面的自动化痕迹
 */
export const AUTOMATION_DOCUMENT_OBJECTS = [
  '__webdriver_script_fn',
  '__driver_evaluate',
  '__webdriver_evaluate',
  '__fxdriver_evaluate',
  '__driver_unwrapped',
  '__webdriver_unwrapped',
  '__fxdriver_unwrapped',
  '__webdriver_script_func',
  '__webdriver_script_function',
  '$cdc_asdjflasutopfhvcZLmcf',
  '$cdc_asdjflasutopfhvcZLmcfl_',
  '$chrome_asyncScriptInfo',
  '__$webdriverAsyncExecutor',
  'webdriver',
  'driver-evaluate',
  'webdriver-evaluate',
  'webdriverCommand',
  'webdriver-evaluate-response',
] as const;

// ========== 默认 Chrome 插件 ==========

/**
 * 默认的 Chrome 插件列表
 *
 * 这些是所有平台 Chrome 浏览器都有的标准插件
 */
export const DEFAULT_CHROME_PLUGINS = [
  {
    name: 'PDF Viewer',
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
  {
    name: 'Chrome PDF Viewer',
    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    description: '',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: '',
      },
    ],
  },
  {
    name: 'Chromium PDF Viewer',
    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    description: '',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: '',
      },
    ],
  },
] as const;

// ========== 默认硬件配置 ==========

/**
 * 默认硬件配置
 */
export const DEFAULT_HARDWARE = {
  /** 默认 CPU 核心数 */
  hardwareConcurrency: 8,
  /** 默认设备内存 (GB) */
  deviceMemory: 8,
  /** 默认屏幕分辨率 */
  screenResolution: {
    width: 1920,
    height: 1080,
  },
  /** 默认颜色深度 */
  colorDepth: 24,
} as const;

// ========== 默认 WebGL 配置 ==========

/**
 * 默认 WebGL 配置
 */
export const DEFAULT_WEBGL = {
  vendor: 'Google Inc. (NVIDIA)',
  renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
  version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
} as const;

// ========== 浏览器默认配置 ==========

/**
 * 默认浏览器配置
 */
export const DEFAULT_BROWSER_CONFIG = {
  /** 最低 Chrome 版本 */
  minChromeVersion: 120,
  /** 默认语言列表 */
  languages: ['en-US', 'en'],
} as const;

// ========== 类型导出 ==========

export type TimezoneId = keyof typeof TIMEZONE_OFFSETS;
export type AutomationObject = (typeof AUTOMATION_WINDOW_OBJECTS)[number];
export type AutomationDocumentObject = (typeof AUTOMATION_DOCUMENT_OBJECTS)[number];
