import { describe, expect, it } from 'vitest';
import { ExtensionControlRelay } from './extension-control-relay';

async function postJson(
  url: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ExtensionControlRelay', () => {
  it('registers a client and resolves waitForClient', async () => {
    const relay = new ExtensionControlRelay({ browserId: 'relay-test-1', token: 'token-1' });
    await relay.start();

    try {
      const response = await postJson(`${relay.getBaseUrl()}/register`, {
        browserId: relay.getBrowserId(),
        token: relay.getToken(),
        tabId: 11,
        windowId: 7,
        url: 'https://example.test',
        title: 'Example',
      });

      expect(response.status).toBe(200);
      await expect(relay.waitForClient(500)).resolves.toMatchObject({
        tabId: 11,
        windowId: 7,
        url: 'https://example.test',
      });
    } finally {
      await relay.stop();
    }
  });

  it('dispatches commands through poll/result and rejects unauthorized requests', async () => {
    const relay = new ExtensionControlRelay({ browserId: 'relay-test-2', token: 'token-2' });
    await relay.start();

    try {
      const unauthorized = await fetch(
        `${relay.getBaseUrl()}/poll?browserId=${encodeURIComponent(relay.getBrowserId())}&token=bad-token`
      );
      expect(unauthorized.status).toBe(401);

      const commandPromise = relay.dispatchCommand<string>('ping', { ok: true }, 2_000);
      const pollResponse = await fetch(
        `${relay.getBaseUrl()}/poll?browserId=${encodeURIComponent(relay.getBrowserId())}&token=${encodeURIComponent(relay.getToken())}`
      );
      expect(pollResponse.status).toBe(200);
      const pollPayload = (await pollResponse.json()) as {
        command?: { requestId?: string; name?: string };
      };
      expect(pollPayload.command?.name).toBe('ping');

      const resultResponse = await postJson(`${relay.getBaseUrl()}/result`, {
        browserId: relay.getBrowserId(),
        token: relay.getToken(),
        requestId: pollPayload.command?.requestId,
        ok: true,
        result: 'pong',
      });
      expect(resultResponse.status).toBe(200);
      await expect(commandPromise).resolves.toBe('pong');
    } finally {
      await relay.stop();
    }
  });

  it('accepts batched events and updates diagnostics snapshots', async () => {
    const relay = new ExtensionControlRelay({ browserId: 'relay-test-3', token: 'token-3' });
    await relay.start();

    const receivedEvents: string[] = [];
    const unsubscribe = relay.onEvent((event) => {
      receivedEvents.push(event.type);
    });

    try {
      const response = await postJson(`${relay.getBaseUrl()}/event`, {
        browserId: relay.getBrowserId(),
        token: relay.getToken(),
        diagnostics: {
          queueLength: 12,
          droppedEventCount: 3,
          offscreenRegisterFailureCount: 1,
          recentRelayErrors: [{ at: 1, message: 'relay failed' }],
          recentCommandErrors: [{ at: 2, message: 'command failed' }],
        },
        events: [
          { type: 'network-reset' },
          {
            type: 'console-message',
            message: {
              level: 'info',
              message: 'hello',
              timestamp: Date.now(),
            },
          },
          {
            type: 'intercepted-request',
            request: {
              id: 'req-1',
              url: 'https://example.test/api/orders',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              resourceType: 'xhr',
              isBlocked: true,
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(receivedEvents).toEqual([
        'network-reset',
        'console-message',
        'intercepted-request',
      ]);
      expect(relay.getDiagnosticsSnapshot()).toMatchObject({
        background: {
          queueLength: 12,
          droppedEventCount: 3,
          offscreenRegisterFailureCount: 1,
          recentRelayErrors: [{ message: 'relay failed' }],
          recentCommandErrors: [{ message: 'command failed' }],
        },
      });
    } finally {
      unsubscribe();
      await relay.stop();
    }
  });

  it('rejects pending waits and commands when stopped', async () => {
    const relay = new ExtensionControlRelay({ browserId: 'relay-test-4', token: 'token-4' });
    await relay.start();

    try {
      const clientPromise = relay.waitForClient(2_000);
      const commandPromise = relay.dispatchCommand('slow-command', undefined, 2_000);
      const clientRejection = expect(clientPromise).rejects.toThrow(
        'Extension relay stopped before client registration'
      );
      const commandRejection = expect(commandPromise).rejects.toThrow(
        'Extension relay stopped while waiting for command result'
      );

      await sleep(50);
      await relay.stop();

      await clientRejection;
      await commandRejection;
    } catch (error) {
      await relay.stop().catch(() => undefined);
      throw error;
    }
  });

  it('drains the pending poll with 410 when stopped', async () => {
    const relay = new ExtensionControlRelay({ browserId: 'relay-test-5', token: 'token-5' });
    await relay.start();

    try {
      const pollPromise = fetch(
        `${relay.getBaseUrl()}/poll?browserId=${encodeURIComponent(relay.getBrowserId())}&token=${encodeURIComponent(relay.getToken())}`
      );

      await sleep(50);
      await relay.stop();

      const pollResponse = await pollPromise;
      expect(pollResponse.status).toBe(410);
    } catch (error) {
      await relay.stop().catch(() => undefined);
      throw error;
    }
  });
});
