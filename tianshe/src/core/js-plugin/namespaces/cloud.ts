export interface CloudAuthConfig {
  baseUrl?: string;
  token?: string;
}

export interface CloudSessionUser {
  userId?: number;
  userName?: string;
  name?: string;
}

export interface CloudSessionInfo {
  loggedIn: boolean;
  baseUrl?: string;
  user?: CloudSessionUser;
}

export class CloudNamespace {
  constructor(private readonly pluginId: string) {}

  getSession(): CloudSessionInfo {
    void this.pluginId;
    return { loggedIn: false };
  }

  setAuth(_config: CloudAuthConfig): never {
    throw new Error('Cloud namespace is not available in the open-source edition');
  }

  clearAuth(): void {}
}
