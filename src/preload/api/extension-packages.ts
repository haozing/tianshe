import type { IpcRenderer } from 'electron';
import type { ExtensionPackage, ProfileExtensionBinding } from '../../types/profile';

export function createExtensionPackagesAPI(ipcRenderer: IpcRenderer) {
  return {
    selectLocalDirectories: (): Promise<{
      success: boolean;
      data?: {
        canceled: boolean;
        paths: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:select-local-directories');
    },

    selectLocalArchives: (): Promise<{
      success: boolean;
      data?: {
        canceled: boolean;
        paths: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:select-local-archives');
    },

    listPackages: (): Promise<{
      success: boolean;
      data?: ExtensionPackage[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:list-packages');
    },

    importLocalPackages: (
      inputs: Array<{ path: string; extensionIdHint?: string }>
    ): Promise<{
      success: boolean;
      data?: {
        succeeded: ExtensionPackage[];
        failed: Array<{
          path: string;
          extensionIdHint?: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:import-local-packages', inputs);
    },

    downloadCloudCatalogPackages: (
      inputs: Array<{
        extensionId: string;
        name?: string;
      }>
    ): Promise<{
      success: boolean;
      data?: {
        succeeded: ExtensionPackage[];
        failed: Array<{
          extensionId: string;
          name?: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:download-cloud-catalog-packages', inputs);
    },

    listProfileBindings: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: ProfileExtensionBinding[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:list-profile-bindings', profileId);
    },

    batchBind: (input: {
      profileIds: string[];
      packages: Array<{
        extensionId: string;
        version?: string | null;
        installMode?: 'required' | 'optional';
        sortOrder?: number;
        enabled?: boolean;
      }>;
    }): Promise<{
      success: boolean;
      data?: {
        success: boolean;
        affectedProfiles: string[];
        destroyedBrowsers: number;
        restartFailures: Array<{
          profileId: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:batch-bind', input);
    },

    batchUnbind: (input: {
      profileIds: string[];
      extensionIds: string[];
      removePackageWhenUnused?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        removedBindings: number;
        removedPackages: string[];
        affectedProfiles: string[];
        destroyedBrowsers: number;
        restartFailures: Array<{
          profileId: string;
          error: string;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('extension-packages:batch-unbind', input);
    },
  };
}
