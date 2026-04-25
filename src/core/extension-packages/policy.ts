import {
  DEFAULT_EXTENSION_PACKAGES_CONFIG,
  EXTENSION_PACKAGE_ID_REGEX,
} from '../../constants/extension-packages';
import type {
  EffectiveExtensionPackagesPolicy,
  ExtensionPackagesGlobalConfig,
} from '../../types/profile';

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '')).map((item) => item.trim());
}

export function normalizeExtensionPackageId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!EXTENSION_PACKAGE_ID_REGEX.test(id)) {
    throw new Error(`Invalid extension id: ${raw}`);
  }
  return id;
}

export function normalizeExtensionPackageIdList(value: unknown, fieldName: string): string[] {
  const out = new Set<string>();
  for (const raw of toArray(value)) {
    if (!raw) continue;
    try {
      out.add(normalizeExtensionPackageId(raw));
    } catch {
      throw new Error(`${fieldName} contains invalid extension id: ${raw}`);
    }
  }
  return Array.from(out);
}

export function normalizeExtensionPackagesGlobalConfig(
  input: Partial<ExtensionPackagesGlobalConfig> | null | undefined,
  base: ExtensionPackagesGlobalConfig = DEFAULT_EXTENSION_PACKAGES_CONFIG
): ExtensionPackagesGlobalConfig {
  const enabled = input?.enabled !== undefined ? Boolean(input.enabled) : base.enabled;
  const requiredExtensionIds =
    input?.requiredExtensionIds !== undefined
      ? normalizeExtensionPackageIdList(input.requiredExtensionIds, 'requiredExtensionIds')
      : base.requiredExtensionIds;
  const onMissing = input?.onMissing ?? base.onMissing;
  if (onMissing !== 'warn' && onMissing !== 'error') {
    throw new Error(`Invalid onMissing value: ${String(onMissing)}`);
  }

  return {
    enabled,
    requiredExtensionIds,
    onMissing,
  };
}

export function resolveExtensionPackagesPolicy(
  globalConfig: ExtensionPackagesGlobalConfig
): EffectiveExtensionPackagesPolicy {
  const normalizedGlobal = normalizeExtensionPackagesGlobalConfig(globalConfig);

  return {
    enabled: normalizedGlobal.enabled,
    mode: 'inherit',
    requiredExtensionIds: normalizedGlobal.requiredExtensionIds,
    onMissing: normalizedGlobal.onMissing,
  };
}
