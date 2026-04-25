export type BrowserExtensionCatalogParams = {
  pageIndex?: number;
  pageSize?: number;
  keyword?: string;
};

export async function listBrowserExtensionCatalog(params: BrowserExtensionCatalogParams) {
  if (!window.electronAPI.cloudBrowserExtension) {
    return { success: false, error: 'cloud-catalog API unavailable' };
  }
  return window.electronAPI.cloudBrowserExtension.listCatalog(params);
}

export async function getBrowserExtensionCatalogCapabilities(options?: { forceRefresh?: boolean }) {
  if (!window.electronAPI.cloudBrowserExtension) {
    return { success: false, error: 'cloud-catalog API unavailable' };
  }
  return window.electronAPI.cloudBrowserExtension.getCatalogCapabilities(options);
}
