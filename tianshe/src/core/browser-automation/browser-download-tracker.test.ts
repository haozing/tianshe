import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserDownloadTracker } from './browser-download-tracker';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airpa-download-tracker-'));
  tempRoots.push(root);
  return root;
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    })
  );
});

describe('BrowserDownloadTracker', () => {
  it('moves completed downloads into the configured target directory', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });
    await fs.writeFile(path.join(downloadDir, 'orders.csv'), 'order_id\n1\n', 'utf8');

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    await waitForCondition(async () => {
      const downloads = await tracker.listDownloads();
      return downloads.some(
        (entry) => entry.suggestedFilename === 'orders.csv' && entry.state === 'completed'
      );
    });
    await expect(tracker.listDownloads()).resolves.toEqual([
      expect.objectContaining({
        suggestedFilename: 'orders.csv',
        state: 'completed',
        path: path.join(targetDir, 'orders.csv'),
      }),
    ]);
    await expect(fs.stat(path.join(targetDir, 'orders.csv'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(downloadDir, 'orders.csv'))).rejects.toThrow();
  });

  it('detects downloads written directly into the configured target directory', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    const waitPromise = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(path.join(targetDir, 'native-only.csv'), 'native', 'utf8');
    }, 150);

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'native-only.csv',
        state: 'completed',
        path: path.join(targetDir, 'native-only.csv'),
      })
    );
  });

  it('waits for a direct target-directory file to stabilize before marking it completed', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    const targetPath = path.join(targetDir, 'stabilized.csv');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    const waitPromise = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(targetPath, '', 'utf8');
    }, 100);
    setTimeout(() => {
      void fs.writeFile(targetPath, 'stable-payload', 'utf8');
    }, 250);

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'stabilized.csv',
        state: 'completed',
        path: targetPath,
        bytesReceived: 'stable-payload'.length,
      })
    );
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('stable-payload');
  });

  it('waits for new downloads and cancels in-progress .part files on demand', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
    });

    const waitPromise = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(path.join(downloadDir, 'report.csv'), 'done', 'utf8');
    }, 150);
    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'report.csv',
        state: 'completed',
      })
    );

    await fs.writeFile(path.join(downloadDir, 'draft.csv.part'), 'chunk', 'utf8');
    const [entry] = await tracker.listDownloads().then((items) =>
      items.filter((item) => item.suggestedFilename === 'draft.csv')
    );
    expect(entry).toEqual(
      expect.objectContaining({
        suggestedFilename: 'draft.csv',
        state: 'in_progress',
      })
    );

    await tracker.cancelDownload(entry.id);
    await expect(fs.stat(path.join(downloadDir, 'draft.csv.part'))).rejects.toThrow();
    await expect(tracker.listDownloads()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: entry.id,
          state: 'canceled',
        }),
      ])
    );
  });

  it('reconciles native download lifecycle events with filesystem state and path overrides', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    await expect(
      tracker.recordDownloadStarted({
        contextId: 'ctx-1',
        navigationId: 'nav-download-1',
        url: 'https://example.test/download/report.csv',
        suggestedFilename: 'report.csv',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'nav-download-1',
        contextId: 'ctx-1',
        navigationId: 'nav-download-1',
        suggestedFilename: 'report.csv',
        state: 'in_progress',
      })
    );

    const sourcePath = path.join(downloadDir, 'report.csv');
    await fs.writeFile(sourcePath, 'done', 'utf8');

    await expect(
      tracker.recordDownloadEnded({
        contextId: 'ctx-1',
        navigationId: 'nav-download-1',
        url: 'https://example.test/download/report.csv',
        suggestedFilename: 'report.csv',
        status: 'completed',
        filepath: sourcePath,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'nav-download-1',
        state: 'completed',
        path: path.join(targetDir, 'report.csv'),
      })
    );

    await expect(tracker.listDownloads()).resolves.toEqual([
      expect.objectContaining({
        id: 'nav-download-1',
        state: 'completed',
        contextId: 'ctx-1',
        navigationId: 'nav-download-1',
        path: path.join(targetDir, 'report.csv'),
      }),
    ]);
    await expect(fs.stat(path.join(targetDir, 'report.csv'))).resolves.toBeTruthy();
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('waits for a lifecycle-tracked download that started before waitForDownload was called', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    await tracker.recordDownloadStarted({
      contextId: 'ctx-1',
      navigationId: 'nav-lifecycle-1',
      url: 'https://example.test/download/native.csv',
      suggestedFilename: 'native.csv',
    });

    const waitPromise = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs
        .writeFile(path.join(targetDir, 'native.csv'), 'native-complete', 'utf8')
        .then(() =>
          tracker.recordDownloadEnded({
            contextId: 'ctx-1',
            navigationId: 'nav-lifecycle-1',
            url: 'https://example.test/download/native.csv',
            suggestedFilename: 'native.csv',
            status: 'completed',
            filepath: path.join(targetDir, 'native.csv'),
          })
        );
    }, 150);

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        id: 'nav-lifecycle-1',
        suggestedFilename: 'native.csv',
        state: 'completed',
        path: path.join(targetDir, 'native.csv'),
      })
    );
  });

  it('does not replay a previously completed download across repeated waits', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
    });

    const firstWait = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(path.join(downloadDir, 'first.csv'), 'first', 'utf8');
    }, 150);

    await expect(firstWait).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'first.csv',
        state: 'completed',
      })
    );

    const secondWait = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(path.join(downloadDir, 'second.csv'), 'second', 'utf8');
    }, 150);

    await expect(secondWait).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'second.csv',
        state: 'completed',
      })
    );
  });

  it('lets concurrent waits resolve against the same in-flight download completion', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'ruyi-downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });

    const tracker = new BrowserDownloadTracker(downloadDir);
    await tracker.setBehavior({
      policy: 'allow',
      downloadPath: targetDir,
    });

    await tracker.recordDownloadStarted({
      contextId: 'ctx-1',
      navigationId: 'nav-concurrent-1',
      url: 'https://example.test/download/concurrent.csv',
      suggestedFilename: 'concurrent.csv',
    });

    const firstWait = tracker.waitForDownload({ timeoutMs: 3000 });
    const secondWait = tracker.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs
        .writeFile(path.join(targetDir, 'concurrent.csv'), 'done', 'utf8')
        .then(() =>
          tracker.recordDownloadEnded({
            contextId: 'ctx-1',
            navigationId: 'nav-concurrent-1',
            url: 'https://example.test/download/concurrent.csv',
            suggestedFilename: 'concurrent.csv',
            status: 'completed',
            filepath: path.join(targetDir, 'concurrent.csv'),
          })
        );
    }, 150);

    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([
      expect.objectContaining({
        id: 'nav-concurrent-1',
        suggestedFilename: 'concurrent.csv',
        state: 'completed',
      }),
      expect.objectContaining({
        id: 'nav-concurrent-1',
        suggestedFilename: 'concurrent.csv',
        state: 'completed',
      }),
    ]);
  });
});
