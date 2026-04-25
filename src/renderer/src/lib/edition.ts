type CloudCapabilityName = 'cloudAuth' | 'cloudSnapshot' | 'cloudCatalog';

function getEditionCapabilities(): Record<CloudCapabilityName, boolean> | null {
  const capabilities = window.electronAPI?.edition?.capabilities;
  if (!capabilities) return null;
  return {
    cloudAuth: capabilities.cloudAuth === true,
    cloudSnapshot: capabilities.cloudSnapshot === true,
    cloudCatalog: capabilities.cloudCatalog === true,
  };
}

export function isCloudAuthAvailable(): boolean {
  const capabilities = getEditionCapabilities();
  return capabilities ? capabilities.cloudAuth && !!window.electronAPI.cloudAuth : true;
}

export function isCloudSnapshotAvailable(): boolean {
  const capabilities = getEditionCapabilities();
  return capabilities ? capabilities.cloudSnapshot && !!window.electronAPI.cloudSnapshot : true;
}

export function isCloudCatalogAvailable(): boolean {
  const capabilities = getEditionCapabilities();
  return (
    capabilities ? capabilities.cloudCatalog && !!window.electronAPI.cloudPlugin : true
  );
}

export function isCloudBrowserExtensionCatalogAvailable(): boolean {
  const capabilities = getEditionCapabilities();
  return (
    capabilities
      ? capabilities.cloudCatalog && !!window.electronAPI.cloudBrowserExtension
      : true
  );
}
