import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ConsoleMessage, NetworkEntry } from '../../core/browser-core/types';
import type { BrowserInterceptedRequest } from '../../types/browser-interface';
import type { BrowserDialogState } from '../../types/browser-interface';

export type ExtensionRelayClientState = {
  registeredAt: number;
  tabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
};

export type ExtensionRelayCommand = {
  requestId: string;
  name: string;
  params?: unknown;
};

export type ExtensionRelayDiagnosticIssue = {
  at: number;
  message: string;
};

export type ExtensionRelayBackgroundDiagnostics = {
  queueLength: number;
  droppedEventCount: number;
  offscreenRegisterFailureCount: number;
  recentRelayErrors: ExtensionRelayDiagnosticIssue[];
  recentCommandErrors: ExtensionRelayDiagnosticIssue[];
};

export type ExtensionRelayDiagnosticsSnapshot = {
  clientState: ExtensionRelayClientState | null;
  lastRegisteredAt: number | null;
  queuedCommandCount: number;
  pendingCommandCount: number;
  oldestPendingCommandAgeMs: number | null;
  commandTimeoutCount: number;
  recentErrors: ExtensionRelayDiagnosticIssue[];
  background: ExtensionRelayBackgroundDiagnostics;
};

export type ExtensionRelayEvent =
  | { type: 'network-reset' }
  | { type: 'network-entry'; entry: NetworkEntry }
  | { type: 'console-reset' }
  | { type: 'console-message'; message: ConsoleMessage }
  | { type: 'client-state'; state: ExtensionRelayClientState }
  | { type: 'intercepted-request'; request: BrowserInterceptedRequest }
  | { type: 'dialog-opened'; dialog: BrowserDialogState }
  | { type: 'dialog-closed'; contextId?: string };

type PendingCommand = {
  createdAt: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type ClientWaiter = {
  resolve: (value: ExtensionRelayClientState) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type PendingPoll = {
  response: http.ServerResponse;
  timeoutId: ReturnType<typeof setTimeout>;
};

type RelayPayloadBase = {
  browserId?: unknown;
  token?: unknown;
  diagnostics?: unknown;
  events?: unknown;
};

type RelayEventListener = (event: ExtensionRelayEvent) => void;

const MAX_RECENT_ERRORS = 20;

class ExtensionRelayHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function respondJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function respondEmpty(response: http.ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.end();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDiagnosticIssue(message: string): ExtensionRelayDiagnosticIssue {
  return {
    at: Date.now(),
    message,
  };
}

function normalizeDiagnosticIssue(
  value: unknown
): ExtensionRelayDiagnosticIssue | null {
  if (typeof value === 'string') {
    const message = value.trim();
    return message ? createDiagnosticIssue(message) : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const message = String(record.message ?? '').trim();
  if (!message) {
    return null;
  }
  const at = Number(record.at);
  return {
    at: Number.isFinite(at) && at > 0 ? Math.trunc(at) : Date.now(),
    message,
  };
}

function normalizeDiagnosticIssues(value: unknown): ExtensionRelayDiagnosticIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeDiagnosticIssue(item))
    .filter((item): item is ExtensionRelayDiagnosticIssue => item !== null)
    .slice(-MAX_RECENT_ERRORS);
}

function normalizeNumber(value: unknown, fallback: number = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function defaultBackgroundDiagnostics(): ExtensionRelayBackgroundDiagnostics {
  return {
    queueLength: 0,
    droppedEventCount: 0,
    offscreenRegisterFailureCount: 0,
    recentRelayErrors: [],
    recentCommandErrors: [],
  };
}

export class ExtensionControlRelay {
  private readonly browserId: string;
  private readonly token: string;
  private readonly host: string;
  private server: http.Server | null = null;
  private port = 0;
  private stopped = false;
  private clientState: ExtensionRelayClientState | null = null;
  private readonly commandQueue: ExtensionRelayCommand[] = [];
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly clientWaiters = new Set<ClientWaiter>();
  private pendingPoll: PendingPoll | null = null;
  private readonly eventListeners = new Set<RelayEventListener>();
  private commandTimeoutCount = 0;
  private readonly recentErrors: ExtensionRelayDiagnosticIssue[] = [];
  private backgroundDiagnostics: ExtensionRelayBackgroundDiagnostics = defaultBackgroundDiagnostics();

  constructor(input: { browserId: string; token?: string; host?: string }) {
    this.browserId = String(input.browserId || '').trim() || randomUUID();
    this.token = String(input.token || '').trim() || randomUUID();
    this.host = String(input.host || '').trim() || '127.0.0.1';
  }

  getBrowserId(): string {
    return this.browserId;
  }

  getToken(): string {
    return this.token;
  }

  getBaseUrl(): string {
    if (!this.server || !this.port) {
      throw new Error('ExtensionControlRelay has not started');
    }
    return `http://${this.host}:${this.port}`;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getLaunchConfig(): { browserId: string; token: string; relayBaseUrl: string } {
    return {
      browserId: this.browserId,
      token: this.token,
      relayBaseUrl: this.getBaseUrl(),
    };
  }

  getDiagnosticsSnapshot(): ExtensionRelayDiagnosticsSnapshot {
    const oldestPendingCommandAgeMs =
      this.pendingCommands.size === 0
        ? null
        : Math.max(
            0,
            Date.now() -
              Math.min(
                ...Array.from(this.pendingCommands.values(), (pending) => pending.createdAt)
              )
          );

    return {
      clientState: this.clientState ? { ...this.clientState } : null,
      lastRegisteredAt: this.clientState?.registeredAt ?? null,
      queuedCommandCount: this.commandQueue.length,
      pendingCommandCount: this.pendingCommands.size,
      oldestPendingCommandAgeMs,
      commandTimeoutCount: this.commandTimeoutCount,
      recentErrors: [...this.recentErrors],
      background: {
        queueLength: this.backgroundDiagnostics.queueLength,
        droppedEventCount: this.backgroundDiagnostics.droppedEventCount,
        offscreenRegisterFailureCount: this.backgroundDiagnostics.offscreenRegisterFailureCount,
        recentRelayErrors: [...this.backgroundDiagnostics.recentRelayErrors],
        recentCommandErrors: [...this.backgroundDiagnostics.recentCommandErrors],
      },
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        const statusCode =
          error instanceof ExtensionRelayHttpError ? error.statusCode : 500;
        const message = toErrorMessage(error);
        this.recordError(`[${request.method || 'GET'} ${request.url || '/'}] ${message}`);
        respondJson(response, statusCode, {
          success: false,
          error: message,
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('Relay server was not created'));
        return;
      }

      server.once('error', reject);
      server.listen(0, this.host, () => {
        server.off('error', reject);
        const address = server.address() as AddressInfo | null;
        if (!address?.port) {
          reject(new Error('Failed to bind relay port'));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.pendingPoll) {
      clearTimeout(this.pendingPoll.timeoutId);
      respondEmpty(this.pendingPoll.response, 410);
      this.pendingPoll = null;
    }

    for (const waiter of this.clientWaiters) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('Extension relay stopped before client registration'));
    }
    this.clientWaiters.clear();

    for (const [requestId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(
        new Error(`Extension relay stopped while waiting for command result: ${requestId}`)
      );
    }
    this.pendingCommands.clear();
    this.commandQueue.length = 0;

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
  }

  getClientState(): ExtensionRelayClientState | null {
    return this.clientState ? { ...this.clientState } : null;
  }

  onEvent(listener: RelayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async waitForClient(timeoutMs: number = 15000): Promise<ExtensionRelayClientState> {
    if (this.clientState) {
      return { ...this.clientState };
    }

    return new Promise<ExtensionRelayClientState>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.clientWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for extension control client after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter: ClientWaiter = {
        resolve: (state) => {
          clearTimeout(timeoutId);
          resolve({ ...state });
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timeoutId,
      };
      this.clientWaiters.add(waiter);
    });
  }

  async dispatchCommand<TResult>(
    name: string,
    params?: unknown,
    timeoutMs: number = 30000
  ): Promise<TResult> {
    if (this.stopped) {
      throw new Error('Extension relay has been stopped');
    }

    const requestId = randomUUID();
    const command: ExtensionRelayCommand = {
      requestId,
      name,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      const createdAt = Date.now();
      const timeoutId = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        this.commandTimeoutCount += 1;
        reject(new Error(`Extension command timed out: ${name}`));
      }, timeoutMs);

      this.pendingCommands.set(requestId, {
        createdAt,
        resolve: (value) => resolve(value as TResult),
        reject,
        timeoutId,
      });
      this.commandQueue.push(command);
      this.flushPendingPoll();
    });
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const method = request.method || 'GET';
    const url = new URL(request.url || '/', this.getBaseUrl());

    if (method === 'GET' && url.pathname === '/poll') {
      this.authorizeQuery(url);
      this.handlePoll(response);
      return;
    }

    const rawBody = method === 'POST' ? await readRequestBody(request) : '';
    let body: RelayPayloadBase & Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as RelayPayloadBase & Record<string, unknown>;
      } catch (error) {
        throw new ExtensionRelayHttpError(
          400,
          `Invalid relay JSON body: ${toErrorMessage(error)}`
        );
      }
    }
    this.authorizeBody(body);

    if (method === 'POST' && url.pathname === '/register') {
      this.handleRegister(body, response);
      return;
    }

    if (method === 'POST' && url.pathname === '/result') {
      this.handleResult(body, response);
      return;
    }

    if (method === 'POST' && url.pathname === '/event') {
      this.handleEvent(body, response);
      return;
    }

    throw new ExtensionRelayHttpError(
      404,
      `Unsupported relay route: ${method} ${url.pathname}`
    );
  }

  private authorizeQuery(url: URL): void {
    const browserId = String(url.searchParams.get('browserId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    if (browserId !== this.browserId || token !== this.token) {
      throw new ExtensionRelayHttpError(401, 'Unauthorized extension relay query');
    }
  }

  private authorizeBody(body: RelayPayloadBase): void {
    const browserId = String(body.browserId || '').trim();
    const token = String(body.token || '').trim();
    if (browserId !== this.browserId || token !== this.token) {
      throw new ExtensionRelayHttpError(401, 'Unauthorized extension relay payload');
    }
  }

  private handleRegister(
    body: RelayPayloadBase & Record<string, unknown>,
    response: http.ServerResponse
  ): void {
    this.applyBackgroundDiagnostics(body.diagnostics);

    this.clientState = {
      registeredAt: Date.now(),
      tabId: typeof body.tabId === 'number' ? body.tabId : null,
      windowId: typeof body.windowId === 'number' ? body.windowId : null,
      url: typeof body.url === 'string' ? body.url : null,
      title: typeof body.title === 'string' ? body.title : null,
    };

    for (const waiter of this.clientWaiters) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(this.clientState);
    }
    this.clientWaiters.clear();

    this.emitEvent({
      type: 'client-state',
      state: { ...this.clientState },
    });
    this.flushPendingPoll();

    respondJson(response, 200, {
      success: true,
    });
  }

  private handlePoll(response: http.ServerResponse): void {
    if (this.stopped) {
      respondEmpty(response, 410);
      return;
    }

    if (this.commandQueue.length > 0) {
      const nextCommand = this.commandQueue.shift() as ExtensionRelayCommand;
      respondJson(response, 200, {
        success: true,
        command: nextCommand,
      });
      return;
    }

    if (this.pendingPoll) {
      clearTimeout(this.pendingPoll.timeoutId);
      respondEmpty(this.pendingPoll.response, 204);
      this.pendingPoll = null;
    }

    const timeoutId = setTimeout(() => {
      if (this.pendingPoll?.response === response) {
        respondEmpty(response, 204);
        this.pendingPoll = null;
      }
    }, 25000);

    this.pendingPoll = {
      response,
      timeoutId,
    };
  }

  private handleResult(
    body: RelayPayloadBase & Record<string, unknown>,
    response: http.ServerResponse
  ): void {
    this.applyBackgroundDiagnostics(body.diagnostics);

    const requestId = String(body.requestId || '').trim();
    if (!requestId) {
      throw new ExtensionRelayHttpError(400, 'Missing relay requestId');
    }

    const pending = this.pendingCommands.get(requestId);
    if (!pending) {
      respondJson(response, 404, {
        success: false,
        error: `Unknown relay requestId: ${requestId}`,
      });
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingCommands.delete(requestId);

    if (body.ok === false) {
      pending.reject(new Error(String(body.error || 'Extension command failed')));
    } else {
      pending.resolve(body.result);
    }

    respondJson(response, 200, {
      success: true,
    });
  }

  private handleEvent(
    body: RelayPayloadBase & Record<string, unknown>,
    response: http.ServerResponse
  ): void {
    this.applyBackgroundDiagnostics(body.diagnostics);

    const rawEvents = Array.isArray(body.events) ? body.events : [body];
    for (const eventBody of rawEvents) {
      this.handleEventPayload(eventBody);
    }

    respondJson(response, 200, { success: true });
  }

  private handleEventPayload(body: unknown): void {
    if (!body || typeof body !== 'object') {
      throw new ExtensionRelayHttpError(400, 'Unsupported relay event payload');
    }

    const record = body as Record<string, unknown>;
    const type = String(record.type || '').trim();

    if (type === 'client-state') {
      const nextState: ExtensionRelayClientState = {
        registeredAt: this.clientState?.registeredAt ?? Date.now(),
        tabId:
          typeof record.tabId === 'number' ? record.tabId : this.clientState?.tabId ?? null,
        windowId:
          typeof record.windowId === 'number'
            ? record.windowId
            : this.clientState?.windowId ?? null,
        url: typeof record.url === 'string' ? record.url : this.clientState?.url ?? null,
        title:
          typeof record.title === 'string' ? record.title : this.clientState?.title ?? null,
      };
      this.clientState = nextState;
      this.emitEvent({ type: 'client-state', state: { ...nextState } });
      return;
    }

    if (type === 'network-reset') {
      this.emitEvent({ type: 'network-reset' });
      return;
    }

    if (type === 'network-entry') {
      this.emitEvent({
        type: 'network-entry',
        entry: record.entry as NetworkEntry,
      });
      return;
    }

    if (type === 'console-reset') {
      this.emitEvent({ type: 'console-reset' });
      return;
    }

    if (type === 'console-message') {
      this.emitEvent({
        type: 'console-message',
        message: record.message as ConsoleMessage,
      });
      return;
    }

    if (type === 'dialog-opened') {
      this.emitEvent({
        type: 'dialog-opened',
        dialog: record.dialog as BrowserDialogState,
      });
      return;
    }

    if (type === 'dialog-closed') {
      this.emitEvent({
        type: 'dialog-closed',
        contextId: typeof record.contextId === 'string' ? record.contextId : undefined,
      });
      return;
    }

    if (type === 'intercepted-request') {
      this.emitEvent({
        type: 'intercepted-request',
        request: record.request as BrowserInterceptedRequest,
      });
      return;
    }

    throw new ExtensionRelayHttpError(400, `Unsupported relay event type: ${type}`);
  }

  private emitEvent(event: ExtensionRelayEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private flushPendingPoll(): void {
    if (!this.pendingPoll || this.commandQueue.length === 0) {
      return;
    }

    const nextCommand = this.commandQueue.shift() as ExtensionRelayCommand;
    clearTimeout(this.pendingPoll.timeoutId);
    respondJson(this.pendingPoll.response, 200, {
      success: true,
      command: nextCommand,
    });
    this.pendingPoll = null;
  }

  private recordError(message: string): void {
    this.recentErrors.push(createDiagnosticIssue(message));
    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.splice(0, this.recentErrors.length - MAX_RECENT_ERRORS);
    }
  }

  private applyBackgroundDiagnostics(input: unknown): void {
    if (!input || typeof input !== 'object') {
      return;
    }
    const record = input as Record<string, unknown>;
    this.backgroundDiagnostics = {
      queueLength: normalizeNumber(record.queueLength, this.backgroundDiagnostics.queueLength),
      droppedEventCount: normalizeNumber(
        record.droppedEventCount,
        this.backgroundDiagnostics.droppedEventCount
      ),
      offscreenRegisterFailureCount: normalizeNumber(
        record.offscreenRegisterFailureCount,
        this.backgroundDiagnostics.offscreenRegisterFailureCount
      ),
      recentRelayErrors: normalizeDiagnosticIssues(record.recentRelayErrors),
      recentCommandErrors: normalizeDiagnosticIssues(record.recentCommandErrors),
    };
  }
}
