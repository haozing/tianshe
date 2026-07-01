import fs from 'node:fs';
import path from 'node:path';
import type { PluginSiteAdapterContribution } from '../../types/js-plugin';
import {
  checkSiteAdapterImportBoundary,
  type SiteAdapterModule,
  type SiteAdapterProvider,
  type SiteAdapterProviderEntry,
  type SiteAdapterProviderError,
} from '../site-adapter-runtime';
import type { PluginRegistry, PluginRegistration } from './registry';

const PROVIDER_ID = 'trusted-plugin-site-adapters';

function assertSafeRelativePath(value: string, label: string): void {
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`Plugin site adapter ${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Plugin site adapter ${label} must not be absolute: ${value}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`Plugin site adapter ${label} must not escape the plugin package: ${value}`);
  }
}

function resolvePackagePath(packageRoot: string, relativePath: string, label: string): string {
  assertSafeRelativePath(relativePath, label);
  const root = path.resolve(packageRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Plugin site adapter ${label} must stay inside the plugin package: ${relativePath}`);
  }
  return resolved;
}

function getDeclaredSiteAdapters(registration: PluginRegistration): PluginSiteAdapterContribution[] {
  return registration.manifest.contributes?.siteAdapters || [];
}

function selectAdapterModule(
  registration: PluginRegistration,
  contribution: PluginSiteAdapterContribution,
  index: number,
  declaredCount: number
): SiteAdapterModule {
  const modules = registration.module?.siteAdapters || [];
  if (!modules.length) {
    throw new Error(`Plugin ${registration.id} declares site adapter contributions but exports no siteAdapters`);
  }
  if (contribution.adapterId) {
    const module = modules.find((candidate) => candidate.manifest.id === contribution.adapterId);
    if (!module) {
      throw new Error(
        `Plugin ${registration.id} site adapter ${contribution.adapterId} is not exported by module.siteAdapters`
      );
    }
    return module;
  }
  if (modules.length === declaredCount) {
    return modules[index];
  }
  if (modules.length === 1 && declaredCount === 1) {
    return modules[0];
  }
  throw new Error(`Plugin ${registration.id} must declare adapterId for each site adapter contribution`);
}

function assertRepairScopeInsidePackage(adapter: SiteAdapterModule, packageRoot: string): void {
  const repairScope = adapter.manifest.repairScope;
  if (!repairScope?.roots?.length || !repairScope.allowedSubpaths?.length) {
    throw new Error(`Plugin site adapter ${adapter.manifest.id} must declare repairScope roots and allowedSubpaths`);
  }
  for (const root of repairScope.roots) {
    resolvePackagePath(packageRoot, root, `repairScope root for ${adapter.manifest.id}`);
  }
  for (const subpath of repairScope.allowedSubpaths) {
    assertSafeRelativePath(subpath, `repairScope allowedSubpath for ${adapter.manifest.id}`);
  }
  for (const filePath of repairScope.forbiddenFiles || []) {
    assertSafeRelativePath(filePath, `repairScope forbiddenFile for ${adapter.manifest.id}`);
  }
}

function assertCapabilityRefs(adapter: SiteAdapterModule): void {
  if (!adapter.manifest.capabilities?.length) {
    throw new Error(`Plugin site adapter ${adapter.manifest.id} must declare capability refs`);
  }
}

function assertEntryImportBoundary(entryPath: string, adapterId: string): void {
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Plugin site adapter ${adapterId} entry does not exist: ${entryPath}`);
  }
  const stat = fs.statSync(entryPath);
  const adapterRoot = stat.isDirectory() ? entryPath : path.dirname(entryPath);
  const violations = checkSiteAdapterImportBoundary({ adapterRoot });
  if (violations.length) {
    const first = violations[0];
    throw new Error(
      `Plugin site adapter ${adapterId} violates import boundary in ${first.relativeFilePath}: ` +
        `${first.moduleName} (${first.reason}). ${first.recommendation}`
    );
  }
}

function createEntriesForRegistration(registration: PluginRegistration): SiteAdapterProviderEntry[] {
  const contributions = getDeclaredSiteAdapters(registration);
  if (!contributions.length) {
    return [];
  }
  if (registration.manifest.trustModel !== 'first_party') {
    throw new Error(`Plugin ${registration.id} site adapters require trustModel: first_party`);
  }
  if (!registration.packageRoot) {
    throw new Error(`Plugin ${registration.id} site adapters require packageRoot`);
  }

  return contributions.map((contribution, index) => {
    const adapter = selectAdapterModule(registration, contribution, index, contributions.length);
    if (contribution.adapterId && contribution.adapterId !== adapter.manifest.id) {
      throw new Error(
        `Plugin ${registration.id} site adapter contribution ${contribution.adapterId} does not match ${adapter.manifest.id}`
      );
    }
    const entryPath = resolvePackagePath(
      registration.packageRoot!,
      contribution.entry,
      `entry for ${adapter.manifest.id}`
    );
    assertEntryImportBoundary(entryPath, adapter.manifest.id);
    assertCapabilityRefs(adapter);
    assertRepairScopeInsidePackage(adapter, registration.packageRoot!);
    return {
      module: adapter,
      source: 'plugin',
      pluginId: registration.id,
      packageRoot: registration.packageRoot!,
      trusted: true,
    };
  });
}

export function createPluginSiteAdapterProvider(pluginRegistry: PluginRegistry): SiteAdapterProvider {
  let lastErrors: SiteAdapterProviderError[] = [];
  return {
    id: PROVIDER_ID,
    listAdapters(): readonly SiteAdapterProviderEntry[] {
      const entries: SiteAdapterProviderEntry[] = [];
      const errors: SiteAdapterProviderError[] = [];
      for (const registration of pluginRegistry.listRegistrations()) {
        try {
          entries.push(...createEntriesForRegistration(registration));
        } catch (error) {
          errors.push({
            providerId: PROVIDER_ID,
            pluginId: registration.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      lastErrors = errors;
      return entries;
    },
    listErrors(): readonly SiteAdapterProviderError[] {
      return lastErrors;
    },
    subscribe(listener: () => void): () => void {
      pluginRegistry.on('plugin:registered', listener);
      pluginRegistry.on('plugin:unregistered', listener);
      return () => {
        pluginRegistry.off('plugin:registered', listener);
        pluginRegistry.off('plugin:unregistered', listener);
      };
    },
  };
}
