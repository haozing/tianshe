import {
  BrowserDownloadTracker,
  type DownloadTrackerChange,
  type DownloadEndObservation,
  type DownloadStartObservation,
} from '../../core/browser-automation/browser-download-tracker';
import type {
  BrowserDownloadEntry,
  BrowserDownloadRuntimeEventSource,
  BrowserRuntimeEventPayloadMap,
  BrowserRuntimeEventType,
} from '../../types/browser-interface';
import { isUnsupportedBiDiCommandError, normalizeTimestamp } from './ruyi-firefox-client-utils';
import type {
  DispatchDownloadBehaviorParams,
  DispatchDownloadCancelParams,
  DispatchDownloadWaitParams,
} from './ruyi-firefox-client.types';

type EmitRuntimeEvent = <TType extends BrowserRuntimeEventType>(
  type: TType,
  payload: BrowserRuntimeEventPayloadMap[TType],
  options?: {
    contextId?: string | null;
    timestamp?: number;
  }
) => void;

type SendBiDiCommand = <TResult>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

type RuyiFirefoxDownloadControllerOptions = {
  downloadTracker: BrowserDownloadTracker;
  defaultDownloadPath: string;
  sendBiDiCommand: SendBiDiCommand;
  emitRuntimeEvent: EmitRuntimeEvent;
};

export class RuyiFirefoxDownloadController {
  private readonly downloadTracker: BrowserDownloadTracker;
  private readonly defaultDownloadPath: string;
  private readonly sendBiDiCommand: SendBiDiCommand;
  private readonly emitRuntimeEvent: EmitRuntimeEvent;
  private nativeDownloadBehaviorSupported: boolean | null = null;
  private readonly emittedDownloadStates = new Map<
    string,
    Set<'started' | 'completed' | 'canceled'>
  >();
  private lifecycleTrackerEmissionSuspended = false;

  constructor(options: RuyiFirefoxDownloadControllerOptions) {
    this.downloadTracker = options.downloadTracker;
    this.defaultDownloadPath = options.defaultDownloadPath;
    this.sendBiDiCommand = options.sendBiDiCommand;
    this.emitRuntimeEvent = options.emitRuntimeEvent;
    this.downloadTracker.onChange((change) => {
      if (this.lifecycleTrackerEmissionSuspended && change.source === 'lifecycle') {
        return;
      }
      this.handleTrackerChange(change);
    });
  }

  async setDownloadBehavior(
    params: DispatchDownloadBehaviorParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const policy = params?.options?.policy === 'deny' ? 'deny' : 'allow';
    const downloadPath =
      typeof params?.options?.downloadPath === 'string' && params.options.downloadPath.trim().length > 0
        ? params.options.downloadPath
        : undefined;

    await this.downloadTracker.setBehavior({
      policy,
      downloadPath,
    });

    if (this.nativeDownloadBehaviorSupported === false) {
      return;
    }

    try {
      await this.sendBiDiCommand(
        'browser.setDownloadBehavior',
        {
          downloadBehavior:
            policy === 'deny'
              ? { type: 'denied' }
              : {
                  type: 'allowed',
                  destinationFolder: downloadPath ?? this.defaultDownloadPath,
                },
        },
        timeoutMs
      );
      this.nativeDownloadBehaviorSupported = true;
    } catch (error) {
      if (isUnsupportedBiDiCommandError(error)) {
        this.nativeDownloadBehaviorSupported = false;
        return;
      }
      throw error;
    }
  }

  async listDownloads(): Promise<BrowserDownloadEntry[]> {
    return await this.downloadTracker.listDownloads();
  }

  async waitForDownload(
    params: DispatchDownloadWaitParams | undefined
  ): Promise<BrowserDownloadEntry> {
    return await this.downloadTracker.waitForDownload({
      timeoutMs: params?.timeoutMs,
      signal: params?.signal,
    });
  }

  async cancelDownload(params: DispatchDownloadCancelParams | undefined): Promise<void> {
    const id = String(params?.id || '').trim();
    if (!id) {
      throw new Error('download id is required');
    }
    await this.downloadTracker.cancelDownload(id);
  }

  async handleDownloadWillBegin(params: Record<string, unknown>): Promise<void> {
    const contextId = normalizeOptionalText(params.context);
    const navigationId = normalizeOptionalText(params.navigation);
    const observation: DownloadStartObservation = {
      contextId,
      navigationId,
      url: normalizeOptionalText(params.url) ?? undefined,
      suggestedFilename: normalizeOptionalText(params.suggestedFilename) ?? undefined,
    };
    this.lifecycleTrackerEmissionSuspended = true;
    let entry: BrowserDownloadEntry;
    try {
      entry = await this.downloadTracker.recordDownloadStarted(observation);
    } finally {
      this.lifecycleTrackerEmissionSuspended = false;
    }
    this.emitDownloadStarted(entry, {
      contextId,
      timestamp: normalizeTimestamp(params.timestamp),
    }, 'native');
  }

  async handleDownloadEnd(params: Record<string, unknown>): Promise<void> {
    const status = String(params.status ?? '').trim().toLowerCase();
    if (status !== 'complete' && status !== 'completed' && status !== 'canceled') {
      return;
    }

    const contextId = normalizeOptionalText(params.context);
    const navigationId = normalizeOptionalText(params.navigation);
    const observation: DownloadEndObservation = {
      contextId,
      navigationId,
      url: normalizeOptionalText(params.url) ?? undefined,
      suggestedFilename: normalizeOptionalText(params.suggestedFilename) ?? undefined,
      status: status === 'canceled' ? 'canceled' : 'completed',
      filepath: normalizeOptionalText(params.filepath),
    };
    this.lifecycleTrackerEmissionSuspended = true;
    let entry: BrowserDownloadEntry;
    try {
      entry = await this.downloadTracker.recordDownloadEnded(observation);
    } finally {
      this.lifecycleTrackerEmissionSuspended = false;
    }
    if (entry.state === 'completed') {
      this.emitDownloadStarted(entry, {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }, 'native');
      this.emitDownloadCompleted(entry, {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }, 'native');
      return;
    }

    this.emitDownloadStarted(entry, {
      contextId,
      timestamp: normalizeTimestamp(params.timestamp),
    }, 'native');
    this.emitDownloadCanceled(entry, {
      contextId,
      timestamp: normalizeTimestamp(params.timestamp),
    }, 'native');
  }

  private handleTrackerChange(change: DownloadTrackerChange): void {
    const contextId = change.entry.contextId ?? null;
    if (change.entry.state === 'in_progress') {
      this.emitDownloadStarted(change.entry, { contextId }, 'filesystem');
      return;
    }

    if (change.entry.state === 'completed') {
      this.emitDownloadStarted(change.entry, { contextId }, 'filesystem');
      this.emitDownloadCompleted(change.entry, { contextId }, 'filesystem');
      return;
    }

    if (change.entry.state === 'canceled') {
      const source: BrowserDownloadRuntimeEventSource =
        change.source === 'cancel' ? 'cancel' : 'filesystem';
      this.emitDownloadStarted(change.entry, { contextId }, source);
      this.emitDownloadCanceled(change.entry, { contextId }, source);
    }
  }

  private emitDownloadStarted(
    entry: BrowserDownloadEntry,
    options?: {
      contextId?: string | null;
      timestamp?: number;
    },
    source: BrowserDownloadRuntimeEventSource = 'filesystem'
  ): void {
    if (!this.markDownloadStateEmitted(entry.id, 'started')) {
      return;
    }

    this.emitRuntimeEvent(
      'download.started',
      {
        id: entry.id,
        url: entry.url ?? null,
        suggestedFilename: entry.suggestedFilename ?? null,
        navigationId: entry.navigationId,
        state: 'in_progress',
        path: entry.path,
        source,
      },
      options
    );
  }

  private emitDownloadCompleted(
    entry: BrowserDownloadEntry,
    options?: {
      contextId?: string | null;
      timestamp?: number;
    },
    source: BrowserDownloadRuntimeEventSource = 'filesystem'
  ): void {
    if (!this.markDownloadStateEmitted(entry.id, 'completed')) {
      return;
    }

    this.emitRuntimeEvent(
      'download.completed',
      {
        id: entry.id,
        url: entry.url ?? null,
        suggestedFilename: entry.suggestedFilename ?? null,
        navigationId: entry.navigationId,
        state: 'completed',
        path: entry.path ?? null,
        source,
      },
      options
    );
  }

  private emitDownloadCanceled(
    entry: BrowserDownloadEntry,
    options?: {
      contextId?: string | null;
      timestamp?: number;
    },
    source: BrowserDownloadRuntimeEventSource = 'cancel'
  ): void {
    if (!this.markDownloadStateEmitted(entry.id, 'canceled')) {
      return;
    }

    this.emitRuntimeEvent(
      'download.canceled',
      {
        id: entry.id,
        url: entry.url ?? null,
        suggestedFilename: entry.suggestedFilename ?? null,
        navigationId: entry.navigationId,
        state: 'canceled',
        source,
      },
      options
    );
  }

  private markDownloadStateEmitted(
    id: string,
    state: 'started' | 'completed' | 'canceled'
  ): boolean {
    const emittedStates = this.emittedDownloadStates.get(id) ?? new Set();
    if (emittedStates.has(state)) {
      return false;
    }
    emittedStates.add(state);
    this.emittedDownloadStates.set(id, emittedStates);
    return true;
  }
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}
