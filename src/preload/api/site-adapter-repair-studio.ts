import type { IpcRenderer } from 'electron';
import type {
  SiteAdapterRepairStudioModelDiffInput,
  SiteAdapterRepairStudioModelDiffResult,
  SiteAdapterRepairStudioProviderConfigSummary,
  SiteAdapterRepairStudioReviewApplyPublishInput,
  SiteAdapterRepairStudioReviewApplyPublishResult,
  SiteAdapterRepairStudioSaveProviderCredentialInput,
} from '../../main/site-adapter-repair-studio/routes-or-ipc';

export function createSiteAdapterRepairStudioAPI(ipcRenderer: IpcRenderer) {
  return {
    getProviderConfigSummary(): Promise<{
      success: boolean;
      data?: SiteAdapterRepairStudioProviderConfigSummary;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-repair-studio:get-provider-config-summary');
    },

    generateModelDiff(input: SiteAdapterRepairStudioModelDiffInput): Promise<{
      success: boolean;
      data?: SiteAdapterRepairStudioModelDiffResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-repair-studio:generate-model-diff', input);
    },

    reviewApplyPublish(input: SiteAdapterRepairStudioReviewApplyPublishInput): Promise<{
      success: boolean;
      data?: SiteAdapterRepairStudioReviewApplyPublishResult;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-repair-studio:review-apply-publish', input);
    },

    saveProviderCredential(input: SiteAdapterRepairStudioSaveProviderCredentialInput): Promise<{
      success: boolean;
      data?: SiteAdapterRepairStudioProviderConfigSummary;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-repair-studio:save-provider-credential', input);
    },

    clearProviderCredential(): Promise<{
      success: boolean;
      data?: SiteAdapterRepairStudioProviderConfigSummary;
      error?: string;
    }> {
      return ipcRenderer.invoke('site-adapter-repair-studio:clear-provider-credential');
    },
  };
}
