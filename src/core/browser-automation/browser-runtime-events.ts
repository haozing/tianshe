import type { BrowserRuntimeEvent, BrowserRuntimeEventType } from '../../types/browser-interface';

function cloneRuntimeEventValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneRuntimeEventValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneRuntimeEventValue(entry),
      ])
    );
  }
  return value;
}

export function cloneBrowserRuntimeEvent<TType extends BrowserRuntimeEventType>(
  event: BrowserRuntimeEvent<TType>
): BrowserRuntimeEvent<TType> {
  return {
    ...event,
    payload: cloneRuntimeEventValue(event.payload) as BrowserRuntimeEvent<TType>['payload'],
  };
}

export class BrowserRuntimeEventHub {
  private readonly listeners = new Set<(event: BrowserRuntimeEvent) => void>();

  on(listener: (event: BrowserRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: BrowserRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneBrowserRuntimeEvent(event));
      } catch {
        // ignore listener failures
      }
    }
  }
}
