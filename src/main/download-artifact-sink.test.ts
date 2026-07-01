import { describe, expect, it, vi } from 'vitest';
import { createDuckDBDownloadArtifactSink } from './download-artifact-sink';

describe('createDuckDBDownloadArtifactSink', () => {
  it('writes completed downloads as file-backed runtime artifacts', async () => {
    const payload = {
      kind: 'file' as const,
      storageKey: 'aa/artifact/download.csv',
      contentAddress: 'sha256:abcd',
      filename: 'download.csv',
      mimeType: 'text/csv',
      sizeBytes: 16,
      sha256: 'a'.repeat(64),
      retentionPolicy: 'download',
    };
    const recordArtifact = vi.fn(async () => undefined);
    const writeFilePayload = vi.fn(async () => payload);
    const duckdbService = {
      getRuntimeArtifactFileStore: () => ({
        writeFilePayload,
      }),
      getRuntimeObservationService: () => ({
        recordArtifact,
      }),
    };
    const sink = createDuckDBDownloadArtifactSink(duckdbService as never);

    const ref = await sink.createDownloadArtifact({
      sourcePath: 'C:\\Users\\secret\\Downloads\\download.csv',
      filename: 'download.csv',
      mimeType: 'text/csv',
      url: 'https://example.test/download.csv',
      browserRuntimeId: 'firefox-bidi',
      sessionId: 'profile-1',
      profileId: 'profile-1',
      browserId: 'browser-1',
      contextId: 'ctx-1',
      navigationId: 'nav-1',
      downloadId: 'download-1',
    });

    expect(writeFilePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: expect.any(String),
        filename: 'download.csv',
        mimeType: 'text/csv',
        retentionPolicy: 'download',
        sourcePath: 'C:\\Users\\secret\\Downloads\\download.csv',
      })
    );
    expect(recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: expect.any(String),
        type: 'download',
        component: 'download',
        label: 'download.csv',
        source: 'download',
        browserRuntimeId: 'firefox-bidi',
        sessionId: 'profile-1',
        profileId: 'profile-1',
        browserId: 'browser-1',
        payload,
        attrs: expect.objectContaining({
          url: 'https://example.test/download.csv',
          contextId: 'ctx-1',
          navigationId: 'nav-1',
          downloadId: 'download-1',
        }),
      })
    );
    expect(ref).toEqual({
      artifactId: expect.any(String),
      type: 'download',
      label: 'download.csv',
      payload: {
        kind: 'file',
        filename: 'download.csv',
        mimeType: 'text/csv',
        sizeBytes: 16,
        sha256: 'a'.repeat(64),
        contentAddress: 'sha256:abcd',
      },
    });
    expect(JSON.stringify(ref)).not.toContain('storageKey');
    expect(JSON.stringify(ref)).not.toContain('Downloads');
  });

  it('removes the just-written file payload when artifact DB recording fails', async () => {
    const payload = {
      kind: 'file' as const,
      storageKey: 'aa/artifact/download.csv',
      contentAddress: 'sha256:abcd',
      filename: 'download.csv',
      sizeBytes: 16,
      sha256: 'a'.repeat(64),
      retentionPolicy: 'download',
    };
    const recordArtifact = vi.fn(async () => {
      throw new Error('db failed');
    });
    const writeFilePayload = vi.fn(async () => payload);
    const deleteFilePayload = vi.fn(async () => true);
    const duckdbService = {
      getRuntimeArtifactFileStore: () => ({
        writeFilePayload,
        deleteFilePayload,
      }),
      getRuntimeObservationService: () => ({
        recordArtifact,
      }),
    };
    const sink = createDuckDBDownloadArtifactSink(duckdbService as never);

    await expect(
      sink.createDownloadArtifact({
        sourcePath: 'C:\\Users\\secret\\Downloads\\download.csv',
        filename: 'download.csv',
      })
    ).rejects.toThrow('db failed');

    expect(deleteFilePayload).toHaveBeenCalledWith(payload);
  });
});
