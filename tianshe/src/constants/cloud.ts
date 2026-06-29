export const DEFAULT_CLOUD_BASE_URL = '';
export const CLOUD_WORKBENCH_URL = '';
export const CLOUD_WORKBENCH_VIEW_ID = 'pool:workbench:open';
export const CLOUD_WORKBENCH_PARTITION = 'persist:workbench:open';
export const CLOUD_AUTH_COOKIE_NAME = 'Admin-Token';
export const CLOUD_AUTH_EVENT_CHANNEL = 'cloud-auth:session-changed';

export function isLegacyCloudBaseUrl(_baseUrl: string): boolean {
  return false;
}

export function rewriteLegacyCloudBaseUrl(baseUrl: string): string {
  return baseUrl;
}
