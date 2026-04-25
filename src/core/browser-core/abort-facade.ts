import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../../types/error-codes';

interface AbortFacadeOptions {
  signal: AbortSignal;
  label: string;
  onAbort?: () => void | Promise<void>;
  createAbortError?: () => StructuredError;
}

const isStructuredError = (value: unknown): value is StructuredError => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as StructuredError).code === 'string' &&
    typeof (value as StructuredError).message === 'string'
  );
};

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> => {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
};

const createInvocationAbortedError = (options: AbortFacadeOptions): StructuredError => {
  try {
    const customError = options.createAbortError?.();
    if (customError) {
      return customError;
    }
  } catch {
    // ignore custom abort error construction failures and fall back
  }

  const reason = options.signal.reason;
  if (isStructuredError(reason)) {
    return reason;
  }
  if (reason instanceof Error && String(reason.message || '').trim()) {
    return createStructuredError(ErrorCode.OPERATION_FAILED, reason.message, {
      context: {
        reason: 'invocation_aborted',
        target: options.label,
      },
    });
  }
  if (typeof reason === 'string' && reason.trim()) {
    return createStructuredError(ErrorCode.OPERATION_FAILED, reason.trim(), {
      context: {
        reason: 'invocation_aborted',
        target: options.label,
      },
    });
  }
  return createStructuredError(ErrorCode.OPERATION_FAILED, `Browser operation aborted: ${options.label}`, {
    context: {
      reason: 'invocation_aborted',
      target: options.label,
    },
  });
};

export const bindAbortSignalToFacade = <T extends object>(
  target: T,
  options: AbortFacadeOptions
): T => {
  const proxyCache = new WeakMap<object, object>();
  let abortCleanupTriggered = false;

  const triggerAbortCleanup = () => {
    if (abortCleanupTriggered) {
      return;
    }
    abortCleanupTriggered = true;
    try {
      const maybePromise = options.onAbort?.();
      if (isPromiseLike(maybePromise)) {
        void Promise.resolve(maybePromise).catch(() => undefined);
      }
    } catch {
      // ignore best-effort abort cleanup failures
    }
  };

  const wrapFunction = (fn: (...args: unknown[]) => unknown, thisArg: object) => {
    return (...args: unknown[]) => {
      if (options.signal.aborted) {
        triggerAbortCleanup();
        throw createInvocationAbortedError(options);
      }

      let abortListener: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          triggerAbortCleanup();
          reject(createInvocationAbortedError(options));
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
      });

      try {
        const result = Reflect.apply(fn, thisArg, args);
        if (!isPromiseLike(result)) {
          if (abortListener) {
            options.signal.removeEventListener('abort', abortListener);
          }
          return result;
        }

        return Promise.race([Promise.resolve(result), abortPromise]).finally(() => {
          if (abortListener) {
            options.signal.removeEventListener('abort', abortListener);
          }
        });
      } catch (error) {
        if (abortListener) {
          options.signal.removeEventListener('abort', abortListener);
        }
        throw error;
      }
    };
  };

  const proxify = <TValue extends object>(value: TValue): TValue => {
    const cached = proxyCache.get(value);
    if (cached) {
      return cached as TValue;
    }

    const proxy = new Proxy(value, {
      get(targetObject, prop, receiver) {
        const current = Reflect.get(targetObject, prop, receiver);
        if (prop === 'withAbortSignal') {
          return (signal: AbortSignal) => {
            if (signal === options.signal) {
              return proxy;
            }
            return typeof current === 'function'
              ? Reflect.apply(current as (...args: unknown[]) => unknown, targetObject, [signal])
              : proxy;
          };
        }
        if (typeof current === 'function') {
          return wrapFunction(current as (...args: unknown[]) => unknown, targetObject);
        }
        if (current && typeof current === 'object') {
          return proxify(current as object);
        }
        return current;
      },
    });

    proxyCache.set(value, proxy);
    return proxy as TValue;
  };

  return proxify(target);
};
