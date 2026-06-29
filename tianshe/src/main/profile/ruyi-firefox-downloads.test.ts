import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserDownloadTracker } from '../../core/browser-automation/browser-download-tracker';
import { RuyiFirefoxDownloadController } from './ruyi-firefox-downloads';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-download-controller-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    })
  );
});

describe('RuyiFirefoxDownloadController', () => {
  it('uses browser.setDownloadBehavior when supported and falls back when unsupported', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'downloads');
    const tracker = new BrowserDownloadTracker(downloadDir);
    const emitRuntimeEvent = vi.fn();

    const supportedController = new RuyiFirefoxDownloadController({
      downloadTracker: tracker,
      defaultDownloadPath: downloadDir,
      sendBiDiCommand: vi.fn(async () => undefined),
      emitRuntimeEvent,
    });

    await expect(
      supportedController.setDownloadBehavior(
        {
          options: {
            policy: 'allow',
            downloadPath: path.join(root, 'collected'),
          },
        },
        1200
      )
    ).resolves.toBeUndefined();

    const fallbackController = new RuyiFirefoxDownloadController({
      downloadTracker: tracker,
      defaultDownloadPath: downloadDir,
      sendBiDiCommand: vi.fn(async () => {
        throw new Error('unknown command\nbrowser.setDownloadBehavior');
      }),
      emitRuntimeEvent,
    });

    await expect(
      fallbackController.setDownloadBehavior(
        {
          options: {
            policy: 'deny',
          },
        },
        1200
      )
    ).resolves.toBeUndefined();
  });

  it('reconciles BiDi download lifecycle events into tracked downloads and runtime events', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });
    const emitRuntimeEvent = vi.fn();
    const controller = new RuyiFirefoxDownloadController({
      downloadTracker: new BrowserDownloadTracker(downloadDir),
      defaultDownloadPath: downloadDir,
      sendBiDiCommand: vi.fn(async () => undefined),
      emitRuntimeEvent,
    });

    await controller.setDownloadBehavior(
      {
        options: {
          policy: 'allow',
          downloadPath: targetDir,
        },
      },
      1200
    );

    await controller.handleDownloadWillBegin({
      context: 'ctx-1',
      navigation: 'nav-1',
      timestamp: 1700000000100,
      url: 'https://example.test/download/report.csv',
      suggestedFilename: 'report.csv',
    });

    const sourcePath = path.join(downloadDir, 'report.csv');
    await fs.writeFile(sourcePath, 'download payload', 'utf8');

    await controller.handleDownloadEnd({
      context: 'ctx-1',
      navigation: 'nav-1',
      timestamp: 1700000000200,
      url: 'https://example.test/download/report.csv',
      status: 'complete',
      filepath: sourcePath,
    });

    await expect(controller.listDownloads()).resolves.toEqual([
      expect.objectContaining({
        id: 'nav-1',
        contextId: 'ctx-1',
        navigationId: 'nav-1',
        suggestedFilename: 'report.csv',
        state: 'completed',
        path: path.join(targetDir, 'report.csv'),
      }),
    ]);

    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      'download.started',
      {
        id: 'nav-1',
        url: 'https://example.test/download/report.csv',
        suggestedFilename: 'report.csv',
        navigationId: 'nav-1',
        state: 'in_progress',
        path: undefined,
        source: 'native',
      },
      {
        contextId: 'ctx-1',
        timestamp: 1700000000100,
      }
    );
    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      'download.completed',
      {
        id: 'nav-1',
        url: 'https://example.test/download/report.csv',
        suggestedFilename: 'report.csv',
        navigationId: 'nav-1',
        state: 'completed',
        path: path.join(targetDir, 'report.csv'),
        source: 'native',
      },
      {
        contextId: 'ctx-1',
        timestamp: 1700000000200,
      }
    );
  });

  it('emits runtime events from filesystem-tracked downloads when native lifecycle events are unavailable', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'downloads');
    const targetDir = path.join(root, 'collected');
    await fs.mkdir(downloadDir, { recursive: true });
    const emitRuntimeEvent = vi.fn();
    const controller = new RuyiFirefoxDownloadController({
      downloadTracker: new BrowserDownloadTracker(downloadDir),
      defaultDownloadPath: downloadDir,
      sendBiDiCommand: vi.fn(async () => undefined),
      emitRuntimeEvent,
    });

    await controller.setDownloadBehavior(
      {
        options: {
          policy: 'allow',
          downloadPath: targetDir,
        },
      },
      1200
    );

    const waitPromise = controller.waitForDownload({ timeoutMs: 3000 });
    setTimeout(() => {
      void fs.writeFile(path.join(targetDir, 'fallback.csv'), 'fallback', 'utf8');
    }, 150);

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        suggestedFilename: 'fallback.csv',
        state: 'completed',
        path: path.join(targetDir, 'fallback.csv'),
      })
    );

    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      'download.started',
      {
        id: expect.any(String),
        url: null,
        suggestedFilename: 'fallback.csv',
        navigationId: undefined,
        state: 'in_progress',
        path: path.join(targetDir, 'fallback.csv'),
        source: 'filesystem',
      },
      {
        contextId: null,
      }
    );
    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      'download.completed',
      {
        id: expect.any(String),
        url: null,
        suggestedFilename: 'fallback.csv',
        navigationId: undefined,
        state: 'completed',
        path: path.join(targetDir, 'fallback.csv'),
        source: 'filesystem',
      },
      {
        contextId: null,
      }
    );
  });

  it('does not emit duplicate runtime events when native download lifecycle messages repeat', async () => {
    const root = await createTempRoot();
    const downloadDir = path.join(root, 'downloads');
    await fs.mkdir(downloadDir, { recursive: true });
    const emitRuntimeEvent = vi.fn();
    const controller = new RuyiFirefoxDownloadController({
      downloadTracker: new BrowserDownloadTracker(downloadDir),
      defaultDownloadPath: downloadDir,
      sendBiDiCommand: vi.fn(async () => undefined),
      emitRuntimeEvent,
    });

    const sourcePath = path.join(downloadDir, 'duplicate.csv');
    await fs.writeFile(sourcePath, 'payload', 'utf8');

    await controller.handleDownloadWillBegin({
      context: 'ctx-1',
      navigation: 'nav-duplicate-1',
      timestamp: 1700000000100,
      url: 'https://example.test/download/duplicate.csv',
      suggestedFilename: 'duplicate.csv',
    });
    await controller.handleDownloadWillBegin({
      context: 'ctx-1',
      navigation: 'nav-duplicate-1',
      timestamp: 1700000000101,
      url: 'https://example.test/download/duplicate.csv',
      suggestedFilename: 'duplicate.csv',
    });
    await controller.handleDownloadEnd({
      context: 'ctx-1',
      navigation: 'nav-duplicate-1',
      timestamp: 1700000000200,
      url: 'https://example.test/download/duplicate.csv',
      status: 'complete',
      filepath: sourcePath,
    });
    await controller.handleDownloadEnd({
      context: 'ctx-1',
      navigation: 'nav-duplicate-1',
      timestamp: 1700000000201,
      url: 'https://example.test/download/duplicate.csv',
      status: 'complete',
      filepath: sourcePath,
    });

    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      'download.started',
      expect.objectContaining({
        id: 'nav-duplicate-1',
        state: 'in_progress',
        source: 'native',
      }),
      {
        contextId: 'ctx-1',
        timestamp: 1700000000100,
      }
    );
    expect(emitRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      'download.completed',
      expect.objectContaining({
        id: 'nav-duplicate-1',
        state: 'completed',
        source: 'native',
      }),
      {
        contextId: 'ctx-1',
        timestamp: 1700000000200,
      }
    );
  });
});
