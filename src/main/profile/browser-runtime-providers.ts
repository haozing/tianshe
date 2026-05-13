import fs from 'node:fs';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
import type { BrowserRuntimeProvider, ResolvedBrowserRuntime } from '../../core/browser-runtime';
import { getStaticRuntimeDescriptor } from '../../core/browser-pool/runtime-capability-registry';
import { getDefaultRuntimeSource } from '../../types/browser-runtime';
import type { SessionConfig } from '../../core/browser-pool/types';
import { resolveChromeExecutablePath, validateChromeRuntime } from './chrome-runtime-shared';
import { resolveFirefoxExecutablePath } from './ruyi-runtime-shared';
import {
  getCloakRuntimeDescriptor,
  installCloakRuntime,
  resolveCloakRuntimeInfo,
} from './browser-pool-integration-cloak';

type ProviderFactoryOptions = {
  electronBrowserFactory: BrowserFactory;
  extensionBrowserFactory: BrowserFactory;
  ruyiBrowserFactory: BrowserFactory;
  cloakBrowserFactory: BrowserFactory;
};

function createFactoryBackedProvider(
  runtimeId: BrowserRuntimeProvider['id'],
  browserFactory: BrowserFactory
): BrowserRuntimeProvider {
  const descriptor =
    runtimeId === 'chromium-cloak-playwright'
      ? getCloakRuntimeDescriptor()
      : getStaticRuntimeDescriptor(runtimeId);

  return {
    id: runtimeId,
    descriptor,
    async resolveRuntime(input): Promise<ResolvedBrowserRuntime> {
      if (input.sourceOverride?.type === 'custom-path') {
        return {
          runtimeId,
          source: input.sourceOverride,
          executablePath: input.sourceOverride.executablePath,
        };
      }

      if (runtimeId === 'chromium-extension-relay') {
        const executablePath = resolveChromeExecutablePath();
        return {
          runtimeId,
          source: input.sourceOverride ?? getDefaultRuntimeSource(runtimeId),
          executablePath,
        };
      }

      if (runtimeId === 'firefox-bidi') {
        const executablePath = resolveFirefoxExecutablePath();
        return {
          runtimeId,
          source: input.sourceOverride ?? getDefaultRuntimeSource(runtimeId),
          executablePath,
        };
      }

      if (runtimeId === 'chromium-cloak-playwright') {
        const info = await resolveCloakRuntimeInfo(input.sourceOverride ?? null);
        return {
          runtimeId,
          source: info.source,
          executablePath: info.executablePath,
          version: info.version,
          installDir: info.installDir,
        };
      }

      return {
        runtimeId,
        source: input.sourceOverride ?? getDefaultRuntimeSource(runtimeId),
      };
    },
    async probeRuntime(runtime) {
      if (runtime.executablePath) {
        if (!fs.existsSync(runtime.executablePath) || !fs.statSync(runtime.executablePath).isFile()) {
          return {
            healthy: false,
            version: runtime.version,
            executablePath: runtime.executablePath,
            errors: [`Runtime executable not found: ${runtime.executablePath}`],
            warnings: [],
          };
        }
      }

      if (runtimeId === 'chromium-extension-relay' && runtime.executablePath) {
        try {
          await validateChromeRuntime(runtime.executablePath);
        } catch (error) {
          return {
            healthy: false,
            version: runtime.version,
            executablePath: runtime.executablePath,
            errors: [error instanceof Error ? error.message : String(error)],
            warnings: [],
          };
        }
      }

      if (runtimeId === 'firefox-bidi' && runtime.executablePath) {
        try {
          const stat = fs.statSync(runtime.executablePath);
          if (!stat.isFile()) {
            throw new Error(`Firefox runtime path is not a file: ${runtime.executablePath}`);
          }
        } catch (error) {
          return {
            healthy: false,
            version: runtime.version,
            executablePath: runtime.executablePath,
            errors: [error instanceof Error ? error.message : String(error)],
            warnings: [],
          };
        }
      }

      if (runtimeId === 'chromium-cloak-playwright') {
        const info = await resolveCloakRuntimeInfo(runtime.source);
        return {
          installed: info.installed,
          healthy: info.installed,
          version: info.version,
          executablePath: info.executablePath,
          errors: info.installed ? [] : [info.error ?? 'CloakBrowser runtime is not installed'],
          warnings: info.warnings,
        };
      }

      return {
        healthy: true,
        version: runtime.version,
        executablePath: runtime.executablePath,
        errors: [],
        warnings: [],
      };
    },
    async installRuntime(input): Promise<ResolvedBrowserRuntime> {
      if (runtimeId !== 'chromium-cloak-playwright') {
        throw new Error(`Managed install is not implemented for ${runtimeId}`);
      }

      const info = await installCloakRuntime(input.sourceOverride ?? null);
      if (!info.installed || !info.executablePath) {
        throw new Error(info.error ?? 'CloakBrowser install did not produce an executable');
      }
      return {
        runtimeId,
        source: info.source,
        executablePath: info.executablePath,
        version: info.version,
        installDir: info.installDir,
      };
    },
    async create(session: SessionConfig) {
      const created = await browserFactory(session);
      return {
        browser: created.browser,
        runtimeId,
        runtimeDescriptor: created.runtimeDescriptor ?? getStaticRuntimeDescriptor(runtimeId),
        resolvedRuntime:
          created.resolvedRuntime ??
          (await this.resolveRuntime({
            runtimeId,
            sourceOverride: session.runtimeSourceOverride ?? null,
          })),
        viewId: created.viewId,
      };
    },
  };
}

export function createDefaultBrowserRuntimeProviders(
  options: ProviderFactoryOptions
): BrowserRuntimeProvider[] {
  return [
    createFactoryBackedProvider('electron-webcontents', options.electronBrowserFactory),
    createFactoryBackedProvider('chromium-extension-relay', options.extensionBrowserFactory),
    createFactoryBackedProvider('firefox-bidi', options.ruyiBrowserFactory),
    createFactoryBackedProvider('chromium-cloak-playwright', options.cloakBrowserFactory),
  ];
}
