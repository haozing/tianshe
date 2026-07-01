import path from 'node:path';
import type {
  BrowserDownloadArtifactInput,
  BrowserDownloadArtifactSink,
} from '../core/browser-automation/download-artifact-sink';
import {
  createRuntimeArtifactId,
  type RuntimeArtifact,
  type RuntimeArtifactFilePayload,
} from '../core/observability/types';
import { createChildTraceContext } from '../core/observability/observation-context';
import type { DuckDBService } from './duckdb/service';

function toDownloadArtifactPayloadRef(payload: RuntimeArtifactFilePayload) {
  return {
    kind: 'file' as const,
    filename: payload.filename,
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    sizeBytes: payload.sizeBytes,
    sha256: payload.sha256,
    ...(payload.contentAddress ? { contentAddress: payload.contentAddress } : {}),
  };
}

export function createDuckDBDownloadArtifactSink(
  duckdbService: DuckDBService
): BrowserDownloadArtifactSink {
  return {
    async createDownloadArtifact(input: BrowserDownloadArtifactInput) {
      const artifactId = createRuntimeArtifactId();
      const filename = input.filename || path.basename(input.sourcePath);
      const payload = await duckdbService.getRuntimeArtifactFileStore().writeFilePayload({
        artifactId,
        filename,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        retentionPolicy: 'download',
        sourcePath: input.sourcePath,
      });
      const context = createChildTraceContext({
        source: 'download',
        ...(input.browserRuntimeId ? { browserRuntimeId: input.browserRuntimeId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.browserId ? { browserId: input.browserId } : {}),
        attributes: {
          ...(input.url ? { url: input.url } : {}),
          ...(input.contextId ? { contextId: input.contextId } : {}),
          ...(input.navigationId ? { navigationId: input.navigationId } : {}),
          ...(input.downloadId ? { downloadId: input.downloadId } : {}),
        },
      });
      const artifact: RuntimeArtifact = {
        artifactId,
        timestamp: Date.now(),
        traceId: context.traceId,
        ...(context.spanId ? { spanId: context.spanId } : {}),
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        type: 'download',
        component: 'download',
        label: filename,
        ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
        source: 'download',
        ...(input.browserRuntimeId ? { browserRuntimeId: input.browserRuntimeId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.browserId ? { browserId: input.browserId } : {}),
        attrs: {
          ...(input.url ? { url: input.url } : {}),
          ...(input.contextId ? { contextId: input.contextId } : {}),
          ...(input.navigationId ? { navigationId: input.navigationId } : {}),
          ...(input.downloadId ? { downloadId: input.downloadId } : {}),
        },
        payload,
      };
      try {
        await duckdbService.getRuntimeObservationService().recordArtifact(artifact);
      } catch (error) {
        await duckdbService
          .getRuntimeArtifactFileStore()
          .deleteFilePayload(payload)
          .catch(() => undefined);
        throw error;
      }
      return {
        artifactId,
        type: 'download' as const,
        label: filename,
        payload: toDownloadArtifactPayloadRef(payload),
      };
    },
  };
}
