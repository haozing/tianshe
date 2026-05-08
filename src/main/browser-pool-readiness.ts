export type BrowserPoolReadinessStatus = 'not-started' | 'initializing' | 'ready' | 'failed';

export interface BrowserPoolReadinessSnapshot {
  status: BrowserPoolReadinessStatus;
  startedAt: number | null;
  readyAt: number | null;
  failedAt: number | null;
  error: string | null;
}

export class BrowserPoolReadiness {
  private snapshot: BrowserPoolReadinessSnapshot = {
    status: 'not-started',
    startedAt: null,
    readyAt: null,
    failedAt: null,
    error: null,
  };

  markInitializing(now = Date.now()): void {
    this.snapshot = {
      status: 'initializing',
      startedAt: now,
      readyAt: null,
      failedAt: null,
      error: null,
    };
  }

  markReady(now = Date.now()): void {
    this.snapshot = {
      ...this.snapshot,
      status: 'ready',
      readyAt: now,
      failedAt: null,
      error: null,
    };
  }

  markFailed(error: unknown, now = Date.now()): void {
    this.snapshot = {
      ...this.snapshot,
      status: 'failed',
      readyAt: null,
      failedAt: now,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  getSnapshot(): BrowserPoolReadinessSnapshot {
    return { ...this.snapshot };
  }
}
