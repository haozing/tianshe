import { describe, expect, it } from 'vitest';
import type { StructuredError } from '../types/error-codes';
import { getMcpInvokeQueueState } from './http-session-manager';
import { createMcpSessionInfo } from './mcp-http-types';

describe('McpSessionInfo grouped state', () => {
  it('can be constructed from focused subobject overrides', () => {
    const invokeQueue = Promise.resolve();
    const closeController = new AbortController();
    const session = createMcpSessionInfo({
      transport: { close: () => undefined } as never,
      maxQueueSize: 1,
      transportState: {
        sessionId: 'session-1',
      },
      queue: {
        invokeQueue,
        pendingInvocations: 2,
        activeInvocations: 1,
        maxQueueSize: 9,
      },
      browser: {
        partition: 'profile-1',
        runtimeId: 'electron-webcontents' as never,
        visible: true,
        hostWindowId: 'hidden-host-session-1',
      },
      auth: {
        authScopes: ['browser.read'],
      },
      lifecycle: {
        lastActivity: 42,
        closing: true,
        terminateAfterResponse: true,
        closeController,
      },
      viewport: {
        viewportHealth: 'ready',
        interactionReady: true,
        offscreenDetected: false,
      },
    });

    expect(session.transport.sessionId).toBe('session-1');
    expect(session.queue.invokeQueue).toBe(invokeQueue);
    expect(session.queue.pendingInvocations).toBe(2);
    expect(session.queue.activeInvocations).toBe(1);
    expect(session.queue.maxQueueSize).toBe(9);
    expect(session.browser).toMatchObject({
      partition: 'profile-1',
      runtimeId: 'electron-webcontents',
      visible: true,
      hostWindowId: 'hidden-host-session-1',
    });
    expect(session.auth.authScopes).toEqual(['browser.read']);
    expect(session.lifecycle).toMatchObject({
      lastActivity: 42,
      closing: true,
      terminateAfterResponse: true,
      closeController,
    });
    expect(session.viewport).toMatchObject({
      viewportHealth: 'ready',
      interactionReady: true,
      offscreenDetected: false,
    });
  });

  it('exposes a queue adapter that mutates grouped queue and lifecycle state', () => {
    const session = createMcpSessionInfo({
      transport: { close: () => undefined } as never,
      maxQueueSize: 4,
      lifecycle: {
        lastActivity: 10,
      },
    });
    const closeReason: StructuredError = {
      code: 'OPERATION_FAILED',
      message: 'Session is closing',
    };

    const queueState = getMcpInvokeQueueState(session);
    queueState.pendingInvocations = 3;
    queueState.activeInvocations = 2;
    queueState.lastActivity = 20;
    queueState.closeReason = closeReason;
    queueState.closing = true;

    expect(session.queue.pendingInvocations).toBe(3);
    expect(session.queue.activeInvocations).toBe(2);
    expect(session.lifecycle.lastActivity).toBe(20);
    expect(session.lifecycle.closeReason).toBe(closeReason);
    expect(session.lifecycle.closing).toBe(true);

    session.queue.pendingInvocations = 1;
    session.lifecycle.closing = false;
    expect(queueState.pendingInvocations).toBe(1);
    expect(queueState.closing).toBe(false);
  });
});
