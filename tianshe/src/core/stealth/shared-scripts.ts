/**
 * 共享脚本生成模块
 *
 * 提供可在 CDP 和直接 JS 注入两种方式下复用的脚本生成函数
 * 避免 cdp-emulation.ts 和 script-generator.ts 之间的代码重复
 */

export { createSeededRandom, hashString } from './shared-scripts-utils';
export { generateWebGLScript } from './shared-scripts-webgl';
export {
  generateWebdriverHideScript,
  generateAutomationCleanupScript,
  generateTimezoneScript,
  generateBatteryScript,
  generateAudioContextScript,
  generateWebRTCProtectionScript,
  generateCanvasNoiseScript,
  generateClientHintsScript,
} from './shared-scripts-core';
export {
  generateChromeObjectScript,
  generateFunctionPrototypeScript,
  generateConsoleStealthScript,
  generateWorkerStealthScript,
  combineScripts,
  generateMouseEventScript,
  wrapScript,
  generateTouchSupportScript,
  generateFontsScript,
} from './shared-scripts-browser-surface';
