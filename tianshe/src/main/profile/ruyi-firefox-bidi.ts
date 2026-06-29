import type {
  BidiErrorMessage,
  BidiEventMessage,
  BidiSuccessMessage,
  PendingRequest,
} from './ruyi-firefox-client.types';

export class RuyiBiDiConnection {
  private socket: WebSocket | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: BidiEventMessage) => void>();
  private closed = false;

  onEvent(listener: (event: BidiEventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async connect(url: string, timeoutMs: number): Promise<void> {
    if (this.socket && !this.closed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        handler();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Timed out connecting BiDi WebSocket: ${url}`)));
      }, timeoutMs);
      timer.unref?.();

      try {
        const socket = new WebSocket(url);
        this.socket = socket;
        this.closed = false;

        socket.addEventListener(
          'open',
          () => {
            finish(() => resolve());
          },
          { once: true }
        );

        socket.addEventListener('message', (event) => {
          this.handleMessage(String(event.data || ''));
        });
        socket.addEventListener('close', () => this.handleDisconnect());
        socket.addEventListener('error', () => {
          if (!settled) {
            finish(() => reject(new Error(`Failed to connect BiDi WebSocket: ${url}`)));
          }
        });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  async close(): Promise<void> {
    if (!this.socket) {
      this.closed = true;
      return;
    }

    const socket = this.socket;
    this.closed = true;
    this.socket = null;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1000);
      timer.unref?.();
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      try {
        socket.close();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async sendCommand<TResult>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 30000
  ): Promise<TResult> {
    if (!this.socket || this.closed) {
      throw new Error('BiDi WebSocket is not connected');
    }

    this.requestId += 1;
    const id = this.requestId;
    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    return await new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi command timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      try {
        this.socket!.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(raw: string): void {
    let message: BidiSuccessMessage | BidiErrorMessage | BidiEventMessage;
    try {
      message = JSON.parse(raw) as BidiSuccessMessage | BidiErrorMessage | BidiEventMessage;
    } catch {
      return;
    }

    if (typeof (message as BidiSuccessMessage).id !== 'number') {
      for (const listener of this.eventListeners) {
        try {
          listener(message as BidiEventMessage);
        } catch {
          // ignore listener failures
        }
      }
      return;
    }

    const id = (message as BidiSuccessMessage).id;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    const errorMessage = message as BidiErrorMessage;
    if (message.type === 'error' || errorMessage.error) {
      const parts = [
        String(errorMessage.error || '').trim(),
        String(errorMessage.message || '').trim(),
        String(errorMessage.stacktrace || '').trim(),
      ].filter(Boolean);
      pending.reject(new Error(parts.join('\n') || 'BiDi command failed'));
      return;
    }

    pending.resolve((message as BidiSuccessMessage).result);
  }

  private handleDisconnect(): void {
    this.closed = true;
    this.socket = null;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('BiDi WebSocket disconnected'));
      this.pending.delete(id);
    }
  }
}
