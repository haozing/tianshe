export const AUTOMATION_ENGINES = ['electron', 'extension', 'ruyi'] as const;

export type AutomationEngine = (typeof AUTOMATION_ENGINES)[number];

export const PERSISTENT_AUTOMATION_ENGINES = ['extension', 'ruyi'] as const satisfies readonly AutomationEngine[];
export const PROFILE_BROWSER_INSTANCE_LIMIT = 1;

const AUTOMATION_ENGINE_SET = new Set<string>(AUTOMATION_ENGINES);
const PERSISTENT_AUTOMATION_ENGINE_SET = new Set<string>(PERSISTENT_AUTOMATION_ENGINES);

export function isAutomationEngine(value: unknown): value is AutomationEngine {
  return typeof value === 'string' && AUTOMATION_ENGINE_SET.has(value);
}

export function normalizeAutomationEngine(
  value: unknown,
  fallback: AutomationEngine = 'electron'
): AutomationEngine {
  return isAutomationEngine(value) ? value : fallback;
}

export function isPersistentAutomationEngine(
  engine: AutomationEngine | null | undefined
): engine is Extract<AutomationEngine, 'extension' | 'ruyi'> {
  return typeof engine === 'string' && PERSISTENT_AUTOMATION_ENGINE_SET.has(engine);
}

export function normalizeProfileBrowserQuota(
  requestedQuota: number
): {
  quota: number;
  forced: boolean;
  reason: 'single-profile-browser-instance' | null;
} {
  return {
    quota: PROFILE_BROWSER_INSTANCE_LIMIT,
    forced: requestedQuota !== PROFILE_BROWSER_INSTANCE_LIMIT,
    reason:
      requestedQuota !== PROFILE_BROWSER_INSTANCE_LIMIT
        ? 'single-profile-browser-instance'
        : null,
  };
}
