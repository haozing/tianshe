import type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../types/sync-contract';

export interface SyncEngineOptions {}

export interface SyncEngineErrorRecord {
  at: number;
  source: string;
  code: string;
  message: string;
}

export interface SyncEngineErrorSummary {
  count: number;
  last?: SyncEngineErrorRecord;
}

export interface SyncEngineStatus {
  isRunning: boolean;
  autoSyncEnabled: boolean;
  errorSummary: SyncEngineErrorSummary;
}

export interface SyncEngineAutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface SyncGatewayClient {
  setToken(token?: string): void;
  setBaseUrl(baseUrl: string): void;
  handshake(request: SyncHandshakeRequest): Promise<SyncHandshakeResponse>;
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(request: SyncPullRequest): Promise<SyncPullResponse>;
  artifactUploadUrl?: (
    request: SyncArtifactUploadUrlRequest
  ) => Promise<SyncArtifactUploadUrlResponse>;
  artifactDownloadUrl?: (
    request: SyncArtifactDownloadUrlRequest
  ) => Promise<SyncArtifactDownloadUrlResponse>;
  uploadArtifactFile?: (
    uploadUrl: string,
    fileName: string,
    bytes: Uint8Array | ArrayBuffer
  ) => Promise<Record<string, unknown>>;
  downloadArtifactFile?: (downloadUrl: string) => Promise<Uint8Array>;
}

const DISABLED_ERROR = 'SyncEngine is not available in the open-source edition';

export class SyncEngineService {
  constructor(..._args: unknown[]) {}

  getStatus(): SyncEngineStatus {
    return {
      isRunning: false,
      autoSyncEnabled: false,
      errorSummary: { count: 0 },
    };
  }

  getAutoSyncConfig(): SyncEngineAutoSyncConfig {
    return { enabled: false, intervalMinutes: 0 };
  }

  setAutoSyncConfig(_config: Partial<SyncEngineAutoSyncConfig>): SyncEngineAutoSyncConfig {
    return this.getAutoSyncConfig();
  }

  async pushOnce(_limit?: number): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  async pullOnce(_pageSize?: number): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  async runOnce(): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  startAutoSync(): void {}
  stopAutoSync(): void {}
  async shutdown(): Promise<void> {}
}
