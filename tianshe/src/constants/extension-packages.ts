import type { ExtensionPackagesGlobalConfig } from '../types/profile';

/**
 * Chrome/Edge 扩展 ID 由 32 位 a-p 小写字母组成。
 */
export const EXTENSION_PACKAGE_ID_REGEX = /^[a-p]{32}$/;

/**
 * 全局 extension packages 策略默认值：
 * - 默认开启校验
 * - 默认无必需扩展
 * - 缺失时仅告警（避免误配置导致全量启动失败）
 */
export const DEFAULT_EXTENSION_PACKAGES_CONFIG: ExtensionPackagesGlobalConfig = {
  enabled: true,
  requiredExtensionIds: [],
  onMissing: 'warn',
};
