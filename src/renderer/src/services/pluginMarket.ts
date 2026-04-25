export type PluginMarketCatalogParams = {
  pageIndex?: number;
  pageSize?: number;
  keyword?: string;
};

export async function listPluginMarketCatalog(params: PluginMarketCatalogParams) {
  if (!window.electronAPI.cloudPlugin) {
    return { success: false, error: 'cloud-catalog API unavailable' };
  }
  return window.electronAPI.cloudPlugin.listCatalog(params);
}

export async function getPluginMarketCatalogCapabilities(options?: { forceRefresh?: boolean }) {
  if (!window.electronAPI.cloudPlugin) {
    return { success: false, error: 'cloud-catalog API unavailable' };
  }
  return window.electronAPI.cloudPlugin.getCatalogCapabilities(options);
}

export async function installPluginMarketPlugin(params: { pluginCode: string }) {
  if (!window.electronAPI.cloudPlugin) {
    return { success: false, error: 'cloud-catalog API unavailable' };
  }
  return window.electronAPI.cloudPlugin.install(params);
}
