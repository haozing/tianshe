type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error' | 'debug';

type ConsoleLike = Partial<Record<ConsoleMethodName, (...args: unknown[]) => void>>;

type StreamLike = {
  on?: (event: 'error', listener: (error: unknown) => void) => void;
};

type GuardedConsoleLike = ConsoleLike & {
  __airpaConsoleBrokenPipeGuardInstalled__?: boolean;
};

type GuardedStreamLike = StreamLike & {
  __airpaBrokenPipeListenerInstalled__?: boolean;
};

const GUARDED_CONSOLE_METHODS: ConsoleMethodName[] = ['log', 'info', 'warn', 'error', 'debug'];

function isIgnorableBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as NodeJS.ErrnoException;
  const message = String(record.message || '').toLowerCase();
  return (
    record.code === 'EPIPE' ||
    record.code === 'ERR_STREAM_DESTROYED' ||
    message.includes('broken pipe') ||
    message.includes('stream destroyed')
  );
}

function wrapConsoleMethod(
  consoleRef: GuardedConsoleLike,
  methodName: ConsoleMethodName
): void {
  const original = consoleRef[methodName];
  if (typeof original !== 'function') {
    return;
  }

  const bound = original.bind(consoleRef);
  consoleRef[methodName] = ((...args: unknown[]) => {
    try {
      bound(...args);
    } catch (error) {
      if (isIgnorableBrokenPipeError(error)) {
        return;
      }
      throw error;
    }
  }) as (...args: unknown[]) => void;
}

function attachBrokenPipeListener(stream: GuardedStreamLike | undefined): void {
  if (!stream?.on || stream.__airpaBrokenPipeListenerInstalled__) {
    return;
  }

  stream.__airpaBrokenPipeListenerInstalled__ = true;
  stream.on('error', (error: unknown) => {
    if (isIgnorableBrokenPipeError(error)) {
      return;
    }
    throw error;
  });
}

export function installStdioBrokenPipeGuards(options?: {
  consoleRef?: GuardedConsoleLike;
  stdout?: GuardedStreamLike;
  stderr?: GuardedStreamLike;
}): void {
  const consoleRef = options?.consoleRef ?? (console as GuardedConsoleLike);
  if (!consoleRef.__airpaConsoleBrokenPipeGuardInstalled__) {
    for (const methodName of GUARDED_CONSOLE_METHODS) {
      wrapConsoleMethod(consoleRef, methodName);
    }
    consoleRef.__airpaConsoleBrokenPipeGuardInstalled__ = true;
  }

  attachBrokenPipeListener(options?.stdout ?? (process.stdout as GuardedStreamLike | undefined));
  attachBrokenPipeListener(options?.stderr ?? (process.stderr as GuardedStreamLike | undefined));
}

export { isIgnorableBrokenPipeError };
