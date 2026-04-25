/**
 * Stealth 模块入口
 *
 * 提供浏览器反检测功能，包括：
 * - 指纹管理：动态生成和缓存浏览器指纹
 * - Stealth 引擎：统一的反检测 API（CDP + JS 脚本）
 *
 * 使用示例：
 * ```typescript
 * import { fingerprintManager, applyFullStealth, generateFullStealthScript } from './stealth';
 *
 * // 1. 获取指纹
 * const fingerprint = fingerprintManager.getFingerprint('session-1');
 *
 * // 2. 方式 A：使用 CDP（推荐）
 * const executor = { send: (m, p) => webContents.debugger.sendCommand(m, p) };
 * await applyFullStealth(executor, fingerprint);
 *
 * // 2. 方式 B：生成脚本手动注入
 * const script = generateFullStealthScript(fingerprint);
 * await webContents.executeJavaScript(script);
 * ```
 *
 * v2 重构：
 * - 整合 CDP 和 JS 脚本为统一的 stealth-engine
 * - 移除冗余的 script-generator 和 cdp-emulation
 * - 简化 API，提供统一入口
 */

// ========== 类型导出 ==========

export type {
  StealthConfig,
  StealthScreenConfig,
  BrowserFingerprint,
  PluginInfo,
  MimeTypeInfo,
  FingerprintValidationResult,
  TimezoneInfo,
  ScriptGenerationOptions,
} from './types';

// ========== 常量导出 ==========

export {
  WEBGL_PARAMS,
  TIMEZONE_OFFSETS,
  TIMEZONE_LOCATIONS,
  DEFAULT_TIMEZONE,
  DEFAULT_GEOLOCATION_ACCURACY,
  AUTOMATION_WINDOW_OBJECTS,
  AUTOMATION_DOCUMENT_OBJECTS,
  DEFAULT_CHROME_PLUGINS,
  DEFAULT_HARDWARE,
  DEFAULT_WEBGL,
  DEFAULT_BROWSER_CONFIG,
  type TimezoneId,
  type AutomationObject,
  type AutomationDocumentObject,
} from './constants';

// ========== 指纹管理器 ==========

export {
  fingerprintManager,
  createFingerprintManager,
  FingerprintManager,
  type FingerprintOptions,
} from './fingerprint-manager';

export { validateFingerprintConfig } from '../fingerprint/fingerprint-validation';

// ========== Stealth 引擎（核心 API） ==========

export {
  // 统一 API
  applyFullStealth,
  applyCDPCommands,
  generateFullStealthScript,
  // CDP 命令生成
  generateCDPCommands,
  generateDebuggerHidingCommands,
  generateScriptInjectionCommand,
  // 向后兼容
  generateStealthScript,
  createCDPStealthSession,
  // 类型
  type CDPExecutor,
  type CDPCommand,
  type StealthOptions,
} from './stealth-engine';

// ========== 共享脚本函数（底层 API） ==========

export {
  // 工具函数
  createSeededRandom,
  hashString,
  combineScripts,
  wrapScript,
  // 脚本生成函数
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
  generateConsoleStealthScript,
  generateWorkerStealthScript,
  generateTouchSupportScript,
  generateFontsScript,
} from './shared-scripts';

// ========== UA-CH / Client Hints（网络层与 CDP/JS 一致化） ==========

export {
  buildUserAgentMetadata,
  buildLowEntropyClientHintsHeaders,
  buildHighEntropyClientHintsHeaders,
  type UserAgentMetadata,
  type LowEntropyClientHintsHeaders,
  type HighEntropyClientHintsHeaders,
} from './client-hints';

// ========== Accept-Language锛堟帹鑽?q-value锛岄伩鍏嶆帓搴忓紓甯?==========

export { buildAcceptLanguageHeaderValue } from './accept-language';
