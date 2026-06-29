export type ExtensionBackgroundRuntimeConfig = {
  browserId: string;
  token: string;
  relayBaseUrl: string;
  proxy?: {
    type?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    bypassList?: string;
  } | null;
};

export function getDefaultRuntimeConfig(): ExtensionBackgroundRuntimeConfig {
  return {
    browserId: 'extension-test-browser',
    token: 'extension-test-token',
    relayBaseUrl: 'http://127.0.0.1:0',
    proxy: null,
  };
}
