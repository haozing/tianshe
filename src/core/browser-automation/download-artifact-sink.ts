import type { BrowserRuntimeId } from '../../types/browser-runtime';
import type { BrowserDownloadArtifactRef } from '../../types/browser-interface';

export interface BrowserDownloadArtifactInput {
  sourcePath: string;
  filename?: string;
  mimeType?: string;
  url?: string;
  browserRuntimeId?: BrowserRuntimeId;
  sessionId?: string;
  profileId?: string;
  browserId?: string;
  contextId?: string;
  navigationId?: string;
  downloadId?: string;
}

export interface BrowserDownloadArtifactSink {
  createDownloadArtifact(input: BrowserDownloadArtifactInput): Promise<BrowserDownloadArtifactRef>;
}

export interface BrowserDownloadArtifactContext {
  browserRuntimeId?: BrowserRuntimeId;
  sessionId?: string;
  profileId?: string;
  browserId?: string;
}
