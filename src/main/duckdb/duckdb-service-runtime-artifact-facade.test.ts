import { describe, expect, it, vi } from 'vitest';
import {
  installDuckDBServiceRuntimeArtifactFacade,
} from './duckdb-service-runtime-artifact-facade';

class TestDuckDBService {
  runtimeObservationService: any;
  runtimeArtifactFileStore: any;
}

installDuckDBServiceRuntimeArtifactFacade(TestDuckDBService.prototype);

describe('DuckDBServiceRuntimeArtifactFacade', () => {
  const payload = {
    kind: 'file' as const,
    storageKey: 'aa/artifact-1/evidence.zip',
    filename: 'evidence.zip',
    sizeBytes: 10,
    sha256: 'f'.repeat(64),
  };

  function createService() {
    const service = new TestDuckDBService();
    service.runtimeObservationService = {
      getArtifactById: vi.fn(async () => ({
        artifactId: 'artifact-1',
        timestamp: 123,
        traceId: 'trace-1',
        type: 'site_adapter_repair_bundle',
        component: 'repair',
        payload,
      })),
      deleteArtifactById: vi.fn(async () => true),
    };
    service.runtimeArtifactFileStore = {
      openFilePayload: vi.fn(async () => undefined),
      revealFilePayload: vi.fn(async () => undefined),
      saveFilePayloadAsFromTrustedDialog: vi.fn(async () => ({
        bytesWritten: payload.sizeBytes,
        sha256: payload.sha256,
      })),
      deleteFilePayload: vi.fn(async () => true),
    };
    return service;
  }

  it('returns runtime artifacts from the unified observation table service', async () => {
    const service = createService();

    await expect(service.getRuntimeArtifact('artifact-1')).resolves.toMatchObject({
      artifactId: 'artifact-1',
      payload,
    });
    expect(service.runtimeObservationService.getArtifactById).toHaveBeenCalledWith('artifact-1');
  });

  it('opens, saves, and deletes file-backed artifacts by artifact id', async () => {
    const service = createService();

    await expect(service.openRuntimeArtifactFile('artifact-1')).resolves.toEqual({ success: true });
    await expect(service.revealRuntimeArtifactFile('artifact-1')).resolves.toEqual({
      success: true,
    });
    await expect(
      service.saveRuntimeArtifactFileAsFromTrustedDialog('artifact-1', {
        path: 'C:\\tmp\\evidence.zip',
        source: 'electron-save-dialog',
      })
    ).resolves.toEqual({
      success: true,
      bytesWritten: 10,
      sha256: payload.sha256,
    });
    await expect(service.deleteRuntimeArtifactFile('artifact-1')).resolves.toEqual({
      success: true,
      deleted: true,
    });

    expect(service.runtimeArtifactFileStore.openFilePayload).toHaveBeenCalledWith(payload);
    expect(service.runtimeArtifactFileStore.revealFilePayload).toHaveBeenCalledWith(payload);
    expect(service.runtimeArtifactFileStore.saveFilePayloadAsFromTrustedDialog).toHaveBeenCalledWith(
      payload,
      {
        path: 'C:\\tmp\\evidence.zip',
        source: 'electron-save-dialog',
      }
    );
    expect(service.runtimeArtifactFileStore.deleteFilePayload).toHaveBeenCalledWith(payload);
    expect(service.runtimeObservationService.deleteArtifactById).toHaveBeenCalledWith(
      'artifact-1'
    );
  });

  it('rejects non-file artifacts for file operations', async () => {
    const service = createService();
    service.runtimeObservationService.getArtifactById.mockResolvedValueOnce({
      artifactId: 'artifact-inline',
      timestamp: 123,
      traceId: 'trace-1',
      type: 'error_context',
      component: 'test',
      payload: {
        kind: 'inline',
        data: { message: 'inline' },
      },
    });

    await expect(service.openRuntimeArtifactFile('artifact-inline')).rejects.toMatchObject({
      code: 'invalid_storage_key',
    });
  });
});
