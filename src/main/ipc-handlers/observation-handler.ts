import { BrowserWindow, dialog } from 'electron';
import type { DuckDBService } from '../duckdb/service';
import { createIpcHandler } from './utils';
import { createLogger } from '../../core/logger';

const logger = createLogger('ObservationIPCHandler');

export function registerObservationHandlers(
  duckdbService: Pick<
    DuckDBService,
    | 'getTraceSummary'
    | 'getFailureBundle'
    | 'getTraceTimeline'
    | 'searchRecentFailures'
    | 'getRuntimeArtifact'
    | 'openRuntimeArtifactFile'
    | 'revealRuntimeArtifactFile'
    | 'saveRuntimeArtifactFileAsFromTrustedDialog'
    | 'deleteRuntimeArtifactFile'
  >
): void {
  createIpcHandler(
    'observation:get-trace-summary',
    async (traceId: string) => {
      return await duckdbService.getTraceSummary(String(traceId || '').trim());
    },
    'Failed to get trace summary'
  );

  createIpcHandler(
    'observation:get-failure-bundle',
    async (traceId: string) => {
      return await duckdbService.getFailureBundle(String(traceId || '').trim());
    },
    'Failed to get failure bundle'
  );

  createIpcHandler(
    'observation:get-trace-timeline',
    async (input: { traceId: string; limit?: number }) => {
      return await duckdbService.getTraceTimeline(
        String(input?.traceId || '').trim(),
        typeof input?.limit === 'number' ? input.limit : undefined
      );
    },
    'Failed to get trace timeline'
  );

  createIpcHandler(
    'observation:search-recent-failures',
    async (limit?: number) => {
      return await duckdbService.searchRecentFailures(
        typeof limit === 'number' ? limit : undefined
      );
    },
    'Failed to search recent failures'
  );

  createIpcHandler(
    'observation:get-artifact',
    async (artifactId: string) => {
      return await duckdbService.getRuntimeArtifact(String(artifactId || '').trim());
    },
    'Failed to get runtime artifact'
  );

  createIpcHandler(
    'observation:open-artifact-file',
    async (artifactId: string) => {
      return await duckdbService.openRuntimeArtifactFile(String(artifactId || '').trim());
    },
    'Failed to open runtime artifact file'
  );

  createIpcHandler(
    'observation:reveal-artifact-file',
    async (artifactId: string) => {
      return await duckdbService.revealRuntimeArtifactFile(String(artifactId || '').trim());
    },
    'Failed to reveal runtime artifact file'
  );

  createIpcHandler(
    'observation:save-artifact-file-as',
    async (artifactId: string) => {
      const result = await dialog.showSaveDialog(
        BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0],
        { title: 'Save Runtime Artifact' }
      );
      if (result.canceled || !result.filePath) {
        return { success: true as const, canceled: true as const };
      }
      const saved = await duckdbService.saveRuntimeArtifactFileAsFromTrustedDialog(
        String(artifactId || '').trim(),
        {
          path: result.filePath,
          source: 'electron-save-dialog',
        }
      );
      return { ...saved, canceled: false as const };
    },
    'Failed to save runtime artifact file'
  );

  createIpcHandler(
    'observation:delete-artifact-file',
    async (artifactId: string) => {
      return await duckdbService.deleteRuntimeArtifactFile(String(artifactId || '').trim());
    },
    'Failed to delete runtime artifact file'
  );

  logger.info('Observation handlers registered');
}
