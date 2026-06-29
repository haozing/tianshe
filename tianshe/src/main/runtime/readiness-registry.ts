export type RuntimeReadinessStatus = 'not-started' | 'initializing' | 'ready' | 'failed';

export interface RuntimeReadinessSnapshot {
  service: string;
  status: RuntimeReadinessStatus;
  updatedAt: number | null;
  error: string | null;
  details?: unknown;
}

export class ReadinessRegistry {
  private readonly snapshots = new Map<string, RuntimeReadinessSnapshot>();

  set(snapshot: RuntimeReadinessSnapshot): RuntimeReadinessSnapshot {
    const next = { ...snapshot };
    this.snapshots.set(snapshot.service, next);
    return { ...next };
  }

  mark(
    service: string,
    status: RuntimeReadinessStatus,
    options: {
      updatedAt?: number | null;
      error?: string | null;
      details?: unknown;
    } = {}
  ): RuntimeReadinessSnapshot {
    return this.set({
      service,
      status,
      updatedAt: options.updatedAt ?? Date.now(),
      error: options.error ?? null,
      ...(options.details === undefined ? {} : { details: options.details }),
    });
  }

  get(service: string): RuntimeReadinessSnapshot | null {
    const snapshot = this.snapshots.get(service);
    return snapshot ? { ...snapshot } : null;
  }

  getAll(): RuntimeReadinessSnapshot[] {
    return Array.from(this.snapshots.values()).map((snapshot) => ({ ...snapshot }));
  }
}
