import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserDownloadEntry } from '../../types/browser-interface';

type DownloadBehavior = {
  policy: 'allow' | 'deny';
  downloadPath?: string;
};

type ObservedDownloadFile = {
  baseName: string;
  finalPath?: string;
  finalSize?: number;
  partialPath?: string;
  partialSize?: number;
};

type TrackedDownload = BrowserDownloadEntry & {
  sourcePath?: string;
  partialPath?: string;
  createdAt: number;
  updatedAt: number;
  lastObservedFinalSize?: number;
  stableFinalObservationCount?: number;
  lastFinalSizeChangedAt?: number;
};

export type DownloadStartObservation = {
  contextId?: string | null;
  navigationId?: string | null;
  url?: string;
  suggestedFilename?: string;
};

export type DownloadEndObservation = DownloadStartObservation & {
  status: 'completed' | 'canceled';
  filepath?: string | null;
};

export type DownloadTrackerChangeSource = 'filesystem' | 'lifecycle' | 'cancel';

export type DownloadTrackerChange = {
  entry: BrowserDownloadEntry;
  previousState: BrowserDownloadEntry['state'] | null;
  source: DownloadTrackerChangeSource;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPartFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.part');
}

function getObservedBaseName(fileName: string): string {
  return isPartFile(fileName) ? fileName.slice(0, -'.part'.length) : fileName;
}

async function safeStat(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function removeFileIfExists(filePath?: string): Promise<void> {
  if (!filePath) {
    return;
  }
  await fs.unlink(filePath).catch(() => undefined);
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  if (sourcePath === targetPath) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
  } catch {
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath).catch(() => undefined);
  }
}

async function resolveUniqueTargetPath(targetPath: string): Promise<string> {
  const extension = path.extname(targetPath);
  const baseName = extension ? targetPath.slice(0, -extension.length) : targetPath;
  let candidate = targetPath;
  let attempt = 1;
  while (await safeStat(candidate)) {
    candidate = `${baseName} (${attempt})${extension}`;
    attempt += 1;
  }
  return candidate;
}

async function scanDownloadDirectory(downloadDir: string): Promise<ObservedDownloadFile[]> {
  await fs.mkdir(downloadDir, { recursive: true });
  const dirents = await fs.readdir(downloadDir, { withFileTypes: true });
  const grouped = new Map<string, ObservedDownloadFile>();

  for (const dirent of dirents) {
    if (!dirent.isFile()) {
      continue;
    }

    const fileName = dirent.name;
    const baseName = getObservedBaseName(fileName);
    if (!baseName) {
      continue;
    }

    const fullPath = path.join(downloadDir, fileName);
    const stat = await safeStat(fullPath);
    if (!stat?.isFile()) {
      continue;
    }

    const observed = grouped.get(baseName) ?? { baseName };
    if (isPartFile(fileName)) {
      observed.partialPath = fullPath;
      observed.partialSize = Number(stat.size);
    } else {
      observed.finalPath = fullPath;
      observed.finalSize = Number(stat.size);
    }
    grouped.set(baseName, observed);
  }

  return [...grouped.values()];
}

function cloneDownloadEntry(entry: BrowserDownloadEntry): BrowserDownloadEntry {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sourcePath: _sourcePath,
    partialPath: _partialPath,
    lastObservedFinalSize: _lastObservedFinalSize,
    stableFinalObservationCount: _stableFinalObservationCount,
    lastFinalSizeChangedAt: _lastFinalSizeChangedAt,
    ...publicEntry
  } = entry as TrackedDownload;
  return publicEntry;
}

function getEntryStateSignature(entry: TrackedDownload): string {
  return JSON.stringify({
    url: entry.url ?? null,
    suggestedFilename: entry.suggestedFilename ?? null,
    path: entry.path ?? null,
    sourcePath: entry.sourcePath ?? null,
    partialPath: entry.partialPath ?? null,
    contextId: entry.contextId ?? null,
    navigationId: entry.navigationId ?? null,
    state: entry.state,
    bytesReceived: entry.bytesReceived ?? null,
    totalBytes: entry.totalBytes ?? null,
  });
}

const FINAL_FILE_STABILITY_MS = 150;

function shouldTrackEntryForWait(entry: TrackedDownload, waitStartedAt: number): boolean {
  return entry.state === 'in_progress' && entry.updatedAt >= waitStartedAt - 1000;
}

export class BrowserDownloadTracker {
  private behavior: DownloadBehavior = { policy: 'allow' };
  private readonly entries: TrackedDownload[] = [];
  private readonly listeners = new Set<(change: DownloadTrackerChange) => void>();

  constructor(private readonly downloadDir: string) {}

  onChange(listener: (change: DownloadTrackerChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setBehavior(options: {
    policy: 'allow' | 'deny';
    downloadPath?: string;
  }): Promise<void> {
    this.behavior = {
      policy: options.policy,
      downloadPath: options.downloadPath ? path.resolve(options.downloadPath) : undefined,
    };
    if (this.behavior.downloadPath) {
      await fs.mkdir(this.behavior.downloadPath, { recursive: true });
    }
    await this.refresh();
  }

  async listDownloads(): Promise<BrowserDownloadEntry[]> {
    await this.refresh();
    return this.entries.map((entry) => cloneDownloadEntry(entry));
  }

  async waitForDownload(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDownloadEntry> {
    if (options?.signal?.aborted) {
      throw new Error('Download wait aborted before start');
    }

    const waitStartedAt = Date.now();
    await this.refresh();
    const knownIds = new Set(this.entries.map((entry) => entry.id));
    const timeoutMs =
      typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 30000;
    const deadline = Date.now() + timeoutMs;
    const recentEntry = this.findRecentEntry(waitStartedAt - 1000);
    let candidateId: string | null =
      recentEntry && shouldTrackEntryForWait(recentEntry, waitStartedAt) ? recentEntry.id : null;

    if (candidateId) {
      const tracked = this.entries.find((entry) => entry.id === candidateId);
      if (tracked && tracked.state !== 'in_progress') {
        return cloneDownloadEntry(tracked);
      }
    }

    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new Error('Download wait aborted');
      }

      await this.refresh();
      if (candidateId) {
        const tracked = this.entries.find((entry) => entry.id === candidateId);
        if (tracked && tracked.state !== 'in_progress') {
          return cloneDownloadEntry(tracked);
        }
      }

      const nextEntry = this.entries.find((entry) => !knownIds.has(entry.id));
      if (nextEntry) {
        if (nextEntry.state !== 'in_progress') {
          return cloneDownloadEntry(nextEntry);
        }
        candidateId = nextEntry.id;
      }

      await sleep(100);
    }

    throw new Error(`Timed out waiting for download after ${timeoutMs}ms`);
  }

  async cancelDownload(id: string): Promise<void> {
    await this.refresh();
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`Download not found: ${id}`);
    }
    if (entry.state !== 'in_progress') {
      throw new Error(`Download is not in progress: ${id}`);
    }

    const previousState = entry.state;
    await removeFileIfExists(entry.partialPath);
    await removeFileIfExists(entry.path);

    entry.state = 'canceled';
    entry.path = undefined;
    entry.sourcePath = undefined;
    entry.partialPath = undefined;
    entry.bytesReceived = 0;
    entry.totalBytes = undefined;
    entry.lastObservedFinalSize = undefined;
    entry.stableFinalObservationCount = undefined;
    entry.lastFinalSizeChangedAt = undefined;
    entry.updatedAt = Date.now();
    this.emitChange({
      entry,
      previousState,
      source: 'cancel',
    });
  }

  async recordDownloadStarted(
    observation: DownloadStartObservation
  ): Promise<BrowserDownloadEntry> {
    const { entry, isNewEntry } = this.findOrCreateLifecycleEntry(observation);
    const previousSignature = getEntryStateSignature(entry);
    const previousState = isNewEntry ? null : entry.state;
    entry.contextId = normalizeOptionalText(observation.contextId) ?? undefined;
    entry.navigationId = normalizeOptionalText(observation.navigationId) ?? undefined;
    entry.url = normalizeOptionalText(observation.url) ?? entry.url;
    entry.suggestedFilename =
      normalizeOptionalText(observation.suggestedFilename) ?? entry.suggestedFilename;
    entry.state = 'in_progress';
    this.emitChangeIfNeeded(entry, previousSignature, previousState, 'lifecycle', isNewEntry);
    return cloneDownloadEntry(entry);
  }

  async recordDownloadEnded(observation: DownloadEndObservation): Promise<BrowserDownloadEntry> {
    const { entry, isNewEntry } = this.findOrCreateLifecycleEntry(observation);
    const previousSignature = getEntryStateSignature(entry);
    const previousState = isNewEntry ? null : entry.state;
    entry.contextId = normalizeOptionalText(observation.contextId) ?? undefined;
    entry.navigationId = normalizeOptionalText(observation.navigationId) ?? undefined;
    entry.url = normalizeOptionalText(observation.url) ?? entry.url;
    entry.suggestedFilename =
      normalizeOptionalText(observation.suggestedFilename) ?? entry.suggestedFilename;
    entry.partialPath = undefined;

    if (observation.status === 'canceled') {
      entry.state = 'canceled';
      entry.path = undefined;
      entry.sourcePath = undefined;
      entry.bytesReceived = 0;
      entry.totalBytes = undefined;
      entry.lastObservedFinalSize = undefined;
      entry.stableFinalObservationCount = undefined;
      entry.lastFinalSizeChangedAt = undefined;
      this.emitChangeIfNeeded(entry, previousSignature, previousState, 'lifecycle', isNewEntry);
      return cloneDownloadEntry(entry);
    }

    entry.state = 'completed';
    const resolvedPath = normalizeOptionalText(observation.filepath)
      ? path.resolve(String(observation.filepath))
      : undefined;
    if (resolvedPath) {
      entry.path = resolvedPath;
      entry.sourcePath = resolvedPath;
      await this.applyDownloadPathOverride(entry);
    }

    if (entry.path) {
      const finalStat = await safeStat(entry.path);
      if (finalStat?.isFile()) {
        entry.bytesReceived = Number(finalStat.size);
        entry.totalBytes = Number(finalStat.size);
      }
    }
    entry.lastObservedFinalSize = entry.totalBytes;
    entry.stableFinalObservationCount = 2;
    entry.lastFinalSizeChangedAt = Date.now() - FINAL_FILE_STABILITY_MS;

    this.emitChangeIfNeeded(entry, previousSignature, previousState, 'lifecycle', isNewEntry);
    return cloneDownloadEntry(entry);
  }

  private async refresh(): Promise<void> {
    const observedDownloads = await this.scanObservedDownloads();
    const seenIds = new Set<string>();

    for (const observed of observedDownloads) {
      const { entry, isNewEntry } = this.findOrCreateEntry(observed);
      const previousSignature = getEntryStateSignature(entry);
      const previousState = isNewEntry ? null : entry.state;
      seenIds.add(entry.id);
      entry.suggestedFilename = observed.baseName;

      if (this.behavior.policy === 'deny') {
        await removeFileIfExists(observed.partialPath);
        await removeFileIfExists(observed.finalPath);
        entry.state = 'canceled';
        entry.path = undefined;
        entry.sourcePath = undefined;
        entry.partialPath = undefined;
        entry.bytesReceived = 0;
        entry.totalBytes = undefined;
        entry.lastObservedFinalSize = undefined;
        entry.stableFinalObservationCount = undefined;
        entry.lastFinalSizeChangedAt = undefined;
        this.emitChangeIfNeeded(entry, previousSignature, previousState, 'filesystem', isNewEntry);
        continue;
      }

      entry.partialPath = observed.partialPath;
      entry.bytesReceived = observed.partialSize ?? observed.finalSize;

      if (observed.partialPath) {
        entry.state = 'in_progress';
        entry.path = observed.finalPath;
        entry.sourcePath = observed.finalPath;
        entry.totalBytes = undefined;
        entry.lastObservedFinalSize = observed.finalSize;
        entry.stableFinalObservationCount = 0;
        entry.lastFinalSizeChangedAt = Date.now();
        this.emitChangeIfNeeded(entry, previousSignature, previousState, 'filesystem', isNewEntry);
        continue;
      }

      if (observed.finalPath) {
        entry.path = observed.finalPath;
        entry.sourcePath = observed.finalPath;
        const observedFinalSize = observed.finalSize;
        const now = Date.now();
        const isStableFinalSize =
          typeof observedFinalSize === 'number' &&
          entry.lastObservedFinalSize === observedFinalSize;
        entry.lastObservedFinalSize = observedFinalSize;
        entry.stableFinalObservationCount = isStableFinalSize
          ? (entry.stableFinalObservationCount ?? 0) + 1
          : 1;
        entry.lastFinalSizeChangedAt = isStableFinalSize
          ? entry.lastFinalSizeChangedAt ?? now
          : now;

        const canMarkCompleted =
          previousState === 'completed' ||
          (typeof entry.lastFinalSizeChangedAt === 'number' &&
            now - entry.lastFinalSizeChangedAt >= FINAL_FILE_STABILITY_MS);

        if (canMarkCompleted) {
          entry.state = 'completed';
          entry.totalBytes = observedFinalSize;
          await this.applyDownloadPathOverride(entry);

          if (entry.path) {
            const finalStat = await safeStat(entry.path);
            if (finalStat?.isFile()) {
              entry.bytesReceived = Number(finalStat.size);
              entry.totalBytes = Number(finalStat.size);
            }
          }
        } else {
          entry.state = 'in_progress';
          entry.totalBytes = undefined;
        }
      }

      this.emitChangeIfNeeded(entry, previousSignature, previousState, 'filesystem', isNewEntry);
    }

    for (const entry of this.entries) {
      if (seenIds.has(entry.id)) {
        continue;
      }
      const isLifecycleTracked =
        Boolean(entry.navigationId) || Boolean(entry.contextId) || Boolean(entry.url);
      if (entry.state === 'in_progress' && !isLifecycleTracked) {
        const previousSignature = getEntryStateSignature(entry);
        const previousState = entry.state;
        entry.state = 'interrupted';
        entry.path = undefined;
        entry.sourcePath = undefined;
        entry.partialPath = undefined;
        entry.lastObservedFinalSize = undefined;
        entry.stableFinalObservationCount = undefined;
        entry.lastFinalSizeChangedAt = undefined;
        this.emitChangeIfNeeded(entry, previousSignature, previousState, 'filesystem');
      }
    }
  }

  private findOrCreateEntry(observed: ObservedDownloadFile): {
    entry: TrackedDownload;
    isNewEntry: boolean;
  } {
    const existing = this.findExistingEntry(observed);
    if (existing) {
      return {
        entry: existing,
        isNewEntry: false,
      };
    }

    const entry: TrackedDownload = {
      id: `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      suggestedFilename: observed.baseName,
      path: observed.finalPath,
      state: observed.partialPath ? 'in_progress' : 'completed',
      bytesReceived: observed.partialSize ?? observed.finalSize,
      totalBytes: observed.finalSize,
      sourcePath: observed.finalPath,
      partialPath: observed.partialPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedFinalSize: observed.finalSize,
      stableFinalObservationCount: observed.partialPath ? 0 : 1,
      lastFinalSizeChangedAt: Date.now(),
    };
    this.entries.push(entry);
    return {
      entry,
      isNewEntry: true,
    };
  }

  private findExistingEntry(observed: ObservedDownloadFile): TrackedDownload | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.suggestedFilename !== observed.baseName) {
        continue;
      }
      if (observed.partialPath && entry.partialPath === observed.partialPath) {
        return entry;
      }
      if (
        observed.finalPath &&
        (entry.sourcePath === observed.finalPath || entry.path === observed.finalPath)
      ) {
        return entry;
      }
      if (entry.state === 'completed' && !entry.path && !entry.sourcePath) {
        return entry;
      }
      if (entry.state === 'in_progress' || entry.state === 'canceled') {
        return entry;
      }
    }
    return undefined;
  }

  private findOrCreateLifecycleEntry(
    observation: DownloadStartObservation | DownloadEndObservation
  ): {
    entry: TrackedDownload;
    isNewEntry: boolean;
  } {
    const navigationId = normalizeOptionalText(observation.navigationId);
    const suggestedFilename = normalizeOptionalText(observation.suggestedFilename);
    const filepath = 'filepath' in observation ? normalizeOptionalText(observation.filepath) : undefined;

    const existing = this.findExistingLifecycleEntry({
      navigationId,
      suggestedFilename,
      filepath,
    });
    if (existing) {
      return {
        entry: existing,
        isNewEntry: false,
      };
    }

    const entry: TrackedDownload = {
      id: navigationId || `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: normalizeOptionalText(observation.url) ?? undefined,
      suggestedFilename: suggestedFilename ?? undefined,
      path: filepath ? path.resolve(filepath) : undefined,
      contextId: normalizeOptionalText(observation.contextId) ?? undefined,
      navigationId: navigationId ?? undefined,
      state: 'in_progress',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedFinalSize: filepath ? 0 : undefined,
      stableFinalObservationCount: filepath ? 1 : undefined,
      lastFinalSizeChangedAt: filepath ? Date.now() : undefined,
    };
    this.entries.push(entry);
    return {
      entry,
      isNewEntry: true,
    };
  }

  private findExistingLifecycleEntry(criteria: {
    navigationId?: string | null;
    suggestedFilename?: string | null;
    filepath?: string | null;
  }): TrackedDownload | undefined {
    const navigationId = normalizeOptionalText(criteria.navigationId);
    if (navigationId) {
      const byNavigationId = this.entries.find((entry) => entry.navigationId === navigationId);
      if (byNavigationId) {
        return byNavigationId;
      }
    }

    const filepath = normalizeOptionalText(criteria.filepath);
    if (filepath) {
      const resolvedPath = path.resolve(filepath);
      const byFilePath = this.entries.find(
        (entry) => entry.path === resolvedPath || entry.sourcePath === resolvedPath
      );
      if (byFilePath) {
        return byFilePath;
      }
    }

    const suggestedFilename = normalizeOptionalText(criteria.suggestedFilename);
    if (suggestedFilename) {
      const byFilename = [...this.entries]
        .reverse()
        .find(
          (entry) =>
            entry.suggestedFilename === suggestedFilename &&
            (entry.state === 'in_progress' ||
              entry.state === 'canceled' ||
              (entry.state === 'completed' && !entry.path && !entry.sourcePath))
        );
      if (byFilename) {
        return byFilename;
      }
    }

    return undefined;
  }

  private async applyDownloadPathOverride(entry: TrackedDownload): Promise<void> {
    const downloadPath = this.behavior.downloadPath;
    if (!downloadPath || !entry.path) {
      return;
    }
    if (path.dirname(entry.path) === downloadPath) {
      return;
    }

    const targetPath = await resolveUniqueTargetPath(
      path.join(downloadPath, entry.suggestedFilename || path.basename(entry.path))
    );
    await moveFile(entry.path, targetPath);
    entry.path = targetPath;
    entry.sourcePath = targetPath;
  }

  private async scanObservedDownloads(): Promise<ObservedDownloadFile[]> {
    const uniqueDirs = new Set<string>([path.resolve(this.downloadDir)]);
    if (this.behavior.downloadPath) {
      uniqueDirs.add(path.resolve(this.behavior.downloadPath));
    }

    const observedDownloads: ObservedDownloadFile[] = [];
    for (const downloadDir of uniqueDirs) {
      observedDownloads.push(...(await scanDownloadDirectory(downloadDir)));
    }
    return observedDownloads;
  }

  private findRecentEntry(sinceTimestamp: number): TrackedDownload | undefined {
    return [...this.entries]
      .reverse()
      .find((entry) => entry.updatedAt >= sinceTimestamp);
  }

  private markEntryUpdatedIfChanged(entry: TrackedDownload, previousSignature: string): void {
    if (getEntryStateSignature(entry) !== previousSignature) {
      entry.updatedAt = Date.now();
    }
  }

  private emitChangeIfNeeded(
    entry: TrackedDownload,
    previousSignature: string,
    previousState: BrowserDownloadEntry['state'] | null,
    source: DownloadTrackerChangeSource,
    forceEmit = false
  ): void {
    const changed = getEntryStateSignature(entry) !== previousSignature;
    if (!changed && !forceEmit) {
      return;
    }

    if (changed) {
      entry.updatedAt = Date.now();
    }

    this.emitChange({
      entry,
      previousState,
      source,
    });
  }

  private emitChange(change: {
    entry: TrackedDownload;
    previousState: BrowserDownloadEntry['state'] | null;
    source: DownloadTrackerChangeSource;
  }): void {
    const payload: DownloadTrackerChange = {
      entry: cloneDownloadEntry(change.entry),
      previousState: change.previousState,
      source: change.source,
    };
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}
