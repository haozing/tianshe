export type ShutdownStepStatus = 'completed' | 'failed' | 'timed-out';

export interface ShutdownStep {
  label: string;
  run: () => void | Promise<void>;
  timeoutMs?: number;
}

export interface ShutdownStepResult {
  label: string;
  status: ShutdownStepStatus;
  durationMs: number;
  error: string | null;
}

export interface ShutdownResult {
  ok: boolean;
  exitCode: number;
  steps: ShutdownStepResult[];
}

export interface ShutdownCoordinatorOptions {
  steps: ShutdownStep[];
  defaultStepTimeoutMs?: number;
  now?: () => number;
  consoleRef?: Pick<Console, 'error'>;
}

export class ShutdownStepTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`Shutdown step "${label}" timed out after ${timeoutMs}ms`);
    this.name = 'ShutdownStepTimeoutError';
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runWithTimeout = async (
  step: ShutdownStep,
  timeoutMs: number | undefined
): Promise<void> => {
  if (!timeoutMs || timeoutMs <= 0) {
    await step.run();
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(step.run),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new ShutdownStepTimeoutError(step.label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export class ShutdownCoordinator {
  private readonly steps: ShutdownStep[];
  private readonly defaultStepTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly consoleRef?: Pick<Console, 'error'>;

  constructor(options: ShutdownCoordinatorOptions) {
    this.steps = options.steps;
    this.defaultStepTimeoutMs = options.defaultStepTimeoutMs;
    this.now = options.now ?? Date.now;
    this.consoleRef = options.consoleRef;
  }

  async run(): Promise<ShutdownResult> {
    const results: ShutdownStepResult[] = [];
    let failed = false;

    for (const step of this.steps) {
      const startedAt = this.now();
      try {
        await runWithTimeout(step, step.timeoutMs ?? this.defaultStepTimeoutMs);
        results.push({
          label: step.label,
          status: 'completed',
          durationMs: this.now() - startedAt,
          error: null,
        });
      } catch (error) {
        failed = true;
        this.consoleRef?.error(`[ERROR] ${step.label} failed:`, error);
        results.push({
          label: step.label,
          status: error instanceof ShutdownStepTimeoutError ? 'timed-out' : 'failed',
          durationMs: this.now() - startedAt,
          error: errorMessage(error),
        });
      }
    }

    return {
      ok: !failed,
      exitCode: failed ? 1 : 0,
      steps: results,
    };
  }
}
