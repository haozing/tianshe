import {
  AUTOMATION_ENGINES,
  isAutomationEngine,
  type AutomationEngine,
} from '../types/profile';

export const firstString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return '';
};

export const parseScopesHeader = (value: unknown): string[] => {
  const raw = firstString(value).trim();
  if (!raw) {
    return [];
  }

  const scopes = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return Array.from(new Set(scopes));
};

/**
 * 解析请求里的浏览器引擎参数。
 */
export const parseRequestedEngine = (value: string | undefined): AutomationEngine | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (isAutomationEngine(normalized)) return normalized;
  throw new Error(
    `Unsupported engine "${normalized}". Supported engines: ${AUTOMATION_ENGINES.join(', ')}.`
  );
};
