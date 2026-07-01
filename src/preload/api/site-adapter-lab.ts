import type { IpcRenderer } from 'electron';
import type {
  SiteAdapterLabCaptureInput,
  SiteAdapterLabCaptureResult,
  SiteAdapterLabRunnerDiffResult,
  SiteAdapterSelectorWorkbenchResult,
} from '../../core/site-adapter-lab';
import type { PageSnapshot } from '../../types/browser-interface';
import type {
  SiteAdapterFixture,
  SiteAdapterManifest,
  SiteAdapterProviderError,
  SiteAdapterRegistrationSource,
} from '../../core/site-adapter-runtime';

export interface SiteAdapterLabAdapterListItem {
  manifest: SiteAdapterManifest;
  source: SiteAdapterRegistrationSource;
  pluginId?: string;
  trusted: boolean;
  packageRoot: string;
  generation: number;
}

export interface SiteAdapterLabProviderDiagnostic extends SiteAdapterProviderError {
  stage: 'provider_refresh';
  quarantined: true;
  suggestion: string;
}

export interface SiteAdapterLabAdapterListResult {
  adapters: SiteAdapterLabAdapterListItem[];
  providerErrors: SiteAdapterLabProviderDiagnostic[];
  generation: number;
}

export interface SiteAdapterLabLoadFixtureResult {
  fixture: SiteAdapterFixture;
  expected: Record<string, unknown>;
}

export function createSiteAdapterLabAPI(ipcRenderer: IpcRenderer) {
  return {
    listAdapters(): Promise<{
      success: boolean;
      data?: SiteAdapterLabAdapterListResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:list-adapters');
    },
    loadFixture(input: { adapterId: string; fixtureName: string }): Promise<{
      success: boolean;
      data?: SiteAdapterLabLoadFixtureResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:load-fixture', input);
    },
    captureFixture(input: SiteAdapterLabCaptureInput): Promise<{
      success: boolean;
      data?: SiteAdapterLabCaptureResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:capture-fixture', input);
    },
    validateSelector(input: {
      snapshot: PageSnapshot;
      selector: string;
      limit?: number;
    }): Promise<{
      success: boolean;
      data?: SiteAdapterSelectorWorkbenchResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:validate-selector', input);
    },
    runFixture(input: {
      adapterId: string;
      fixture: SiteAdapterFixture;
      expected: Record<string, unknown>;
      browserRunner?: {
        enabled?: boolean;
        targetUrl?: string;
        profileId?: string;
        runtimeId?: string;
        timeoutMs?: number;
      };
      playwrightLabRunner?: {
        enabled?: boolean;
        targetUrl?: string;
        profileId?: string;
        runtimeId?: string;
        timeoutMs?: number;
      };
    }): Promise<{
      success: boolean;
      data?: SiteAdapterLabRunnerDiffResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:run-fixture', input);
    },
    saveExpected(input: {
      adapterId: string;
      fixtureName: string;
      fixture: SiteAdapterFixture;
      expected: Record<string, unknown>;
    }): Promise<{
      success: boolean;
      data?: {
        save: {
          adapterId: string;
          fixtureName: string;
          expectedPath: string;
          saved: true;
        };
        runner: SiteAdapterLabRunnerDiffResult;
      };
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-lab:save-expected', input);
    },
  };
}
