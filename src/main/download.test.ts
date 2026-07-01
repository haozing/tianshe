import { describe, expect, it, vi } from 'vitest';
import { DownloadManager, type DownloadInfo } from './download';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\tianshe-test'),
  },
  session: {
    fromPartition: vi.fn(() => ({
      on: vi.fn(),
    })),
  },
}));

describe('DownloadManager', () => {
  it('emits completed downloads with an artifact ref after file-backed finalization', async () => {
    const manager = new DownloadManager();
    const createDownloadArtifact = vi.fn(async () => ({
      artifactId: 'artifact-download-1',
      type: 'download' as const,
      label: 'orders.csv',
      payload: {
        kind: 'file' as const,
        filename: 'orders.csv',
        sizeBytes: 12,
        sha256: 'a'.repeat(64),
      },
    }));
    manager.setArtifactSink({ createDownloadArtifact });
    const completed = vi.fn();
    manager.on('download:completed', completed);
    const info: DownloadInfo = {
      id: 'download-1',
      partition: 'persist:profile-1',
      filename: 'orders.csv',
      savePath: 'C:\\Users\\secret\\Downloads\\orders.csv',
      url: 'https://example.test/orders.csv',
      state: 'progressing',
      totalBytes: 0,
      receivedBytes: 0,
      startTime: Date.now(),
    };

    await (manager as any).finalizeCompletedDownload(info, {
      getReceivedBytes: () => 12,
      getTotalBytes: () => 12,
    });

    expect(createDownloadArtifact).toHaveBeenCalledWith({
      sourcePath: 'C:\\Users\\secret\\Downloads\\orders.csv',
      filename: 'orders.csv',
      url: 'https://example.test/orders.csv',
      downloadId: 'download-1',
    });
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'download-1',
        state: 'completed',
        artifactRef: {
          artifactId: 'artifact-download-1',
          type: 'download',
          label: 'orders.csv',
          payload: {
            kind: 'file',
            filename: 'orders.csv',
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
          },
        },
      })
    );
  });
});
