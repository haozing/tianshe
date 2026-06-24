import type { ElectronAPI } from '../../../types/electron';

type SiteAdapterRepairStudioAPI = ElectronAPI['siteAdapterRepairStudio'];

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getRepairStudioApi(): SiteAdapterRepairStudioAPI {
  return getElectronAPI().siteAdapterRepairStudio;
}

export const siteAdapterRepairStudioFacade = {
  getProviderConfigSummary: (
    ...args: Parameters<SiteAdapterRepairStudioAPI['getProviderConfigSummary']>
  ) => getRepairStudioApi().getProviderConfigSummary(...args),
  generateModelDiff: (...args: Parameters<SiteAdapterRepairStudioAPI['generateModelDiff']>) =>
    getRepairStudioApi().generateModelDiff(...args),
  reviewApplyPublish: (
    ...args: Parameters<SiteAdapterRepairStudioAPI['reviewApplyPublish']>
  ) => getRepairStudioApi().reviewApplyPublish(...args),
  saveProviderCredential: (
    ...args: Parameters<SiteAdapterRepairStudioAPI['saveProviderCredential']>
  ) => getRepairStudioApi().saveProviderCredential(...args),
  clearProviderCredential: (
    ...args: Parameters<SiteAdapterRepairStudioAPI['clearProviderCredential']>
  ) => getRepairStudioApi().clearProviderCredential(...args),
};
