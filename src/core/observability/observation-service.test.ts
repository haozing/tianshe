import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootTraceContext, withTraceContext } from './observation-context';
import { observationService, setObservationSink } from './observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from './types';

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

describe('ObservationService', () => {
  afterEach(() => {
    setObservationSink(null);
    vi.useRealTimers();
  });

  it('records events against the active trace context', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-obs-1',
        source: 'test',
      }),
      async () => {
        await observationService.event({
          component: 'test',
          event: 'capability.invoke.started',
          outcome: 'started',
          attrs: {
            capability: 'browser_snapshot',
          },
        });
      }
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      traceId: 'trace-obs-1',
      source: 'test',
      component: 'test',
      event: 'capability.invoke.started',
      outcome: 'started',
      attrs: {
        capability: 'browser_snapshot',
      },
    });
  });

  it('startSpan emits started and succeeded events and keeps artifacts on the same trace', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-obs-2',
        source: 'test',
      }),
      async () => {
        const span = await observationService.startSpan({
          component: 'browser',
          event: 'browser.action.click',
          attrs: {
            selector: '#submit',
          },
        });

        await span.attachArtifact({
          component: 'browser',
          type: 'snapshot',
          label: 'click failure snapshot',
          data: {
            url: 'https://example.com',
          },
        });

        await span.succeed({
          attrs: {
            selector: '#submit',
          },
        });
      }
    );

    expect(sink.events.map((event) => event.event)).toEqual([
      'browser.action.click.started',
      'browser.action.click.succeeded',
    ]);
    expect(sink.events.every((event) => event.traceId === 'trace-obs-2')).toBe(true);
    expect(sink.artifacts).toHaveLength(1);
    expect(sink.artifacts[0]).toMatchObject({
      traceId: 'trace-obs-2',
      type: 'snapshot',
      label: 'click failure snapshot',
    });
  });

  it('returns events after a bounded wait when the sink is stuck', async () => {
    vi.useFakeTimers();
    setObservationSink({
      recordEvent: vi.fn(() => new Promise<void>(() => undefined)),
      recordArtifact: vi.fn(),
    });

    const eventPromise = observationService.event({
      component: 'test',
      event: 'slow.sink',
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(eventPromise).resolves.toMatchObject({
      component: 'test',
      event: 'slow.sink',
    });
  });

  it('redacts sensitive values in observation events and artifacts', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const error = new Error('Authorization: Bearer error-secret');
    error.stack = 'Error: failed\nSet-Cookie: sid=stack-secret; Path=/';

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-redaction',
        source: 'test',
      }),
      async () => {
        await observationService.event({
          component: 'test',
          event: 'redaction.event',
          message: 'Failed with token=message-secret',
          error,
          attrs: {
            authorization: 'Bearer event-secret',
            consoleLine: 'Set-Cookie: sid=console-secret; Path=/',
            harmless: {
              value: 'visible-value',
            },
          },
        });
        await observationService.attachArtifact({
          component: 'test',
          type: 'network_summary',
          data: {
            requestHeaders: {
              Authorization: 'Bearer request-secret',
              accept: 'application/json',
            },
            responseHeaders: {
              'set-cookie': 'sid=response-secret; Path=/',
            },
            cookies: [
              {
                name: 'sid',
                value: 'cookie-secret',
                domain: 'example.com',
                path: '/',
                httpOnly: true,
              },
            ],
            nested: {
              accessToken: 'nested-token-secret',
            },
            harmless: {
              value: 'visible-value',
            },
          },
        });
      }
    );

    const serialized = JSON.stringify({
      events: sink.events,
      artifacts: sink.artifacts,
    });
    expect(serialized).not.toContain('event-secret');
    expect(serialized).not.toContain('message-secret');
    expect(serialized).not.toContain('error-secret');
    expect(serialized).not.toContain('stack-secret');
    expect(serialized).not.toContain('console-secret');
    expect(serialized).not.toContain('request-secret');
    expect(serialized).not.toContain('response-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('nested-token-secret');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('visible-value');
  });

  it('records file-backed artifact payloads without exposing managed file paths', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await observationService.attachArtifact({
      context: createRootTraceContext({
        traceId: 'trace-file-artifact',
        capability: 'browser.screenshot',
        pluginId: 'plugin-1',
        profileId: 'profile-1',
        datasetId: 'dataset-1',
      }),
      component: 'browser',
      type: 'screenshot',
      label: 'failure screenshot',
      payload: {
        kind: 'file',
        storageKey: 'ab/artifact-1/evidence.png',
        filename: 'evidence.png',
        mimeType: 'image/png',
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        retentionPolicy: '7d',
      },
      attrs: {
        localPath: 'C:\\Users\\alice\\secret\\evidence.png',
      },
    });

    expect(sink.artifacts).toEqual([
      expect.objectContaining({
        traceId: 'trace-file-artifact',
        capability: 'browser.screenshot',
        pluginId: 'plugin-1',
        profileId: 'profile-1',
        datasetId: 'dataset-1',
        payload: {
          kind: 'file',
          storageKey: 'ab/artifact-1/evidence.png',
          filename: 'evidence.png',
          mimeType: 'image/png',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
          retentionPolicy: '7d',
        },
      }),
    ]);
    expect(JSON.stringify(sink.artifacts[0].payload)).not.toContain('C:\\Users');
  });

  it('applies a golden redaction gate to failure, repair, browser, and profile artifacts', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-artifact-golden-redaction',
        source: 'test',
        profileId: 'profile-1',
      }),
      async () => {
        await observationService.attachArtifact({
          component: 'site-adapter',
          type: 'site_adapter_failure',
          label: 'failure artifact',
          attrs: {
            credentialId: 'failure-credential-secret',
            safe: 'visible-attr',
          },
          data: {
            currentUrl: 'https://example.test/path?token=failure-url-secret&safe=1',
            headers: {
              authorization: 'Bearer failure-header-secret',
            },
            errorMessage: 'password=failure-password-secret',
            selectorHits: [
              {
                selector: '#login',
                text: 'Authorization: Bearer failure-text-secret',
              },
            ],
          },
        });

        await observationService.attachArtifact({
          component: 'repair-studio',
          type: 'site_adapter_repair_bundle',
          label: 'repair artifact',
          attrs: {
            accessKey: 'repair-attr-secret',
          },
          data: {
            changeSet: {
              patch: 'set password=repair-patch-secret',
            },
            reviewer: {
              credential: 'repair-credential-secret',
            },
            cookies: [
              {
                name: 'sid',
                value: 'repair-cookie-secret',
                domain: 'example.test',
                path: '/',
              },
            ],
            sql: 'SELECT * FROM users WHERE token=repair-sql-secret',
          },
        });

        await observationService.attachArtifact({
          component: 'browser',
          type: 'snapshot',
          label: 'browser artifact',
          attrs: {
            cookie: 'sid=browser-attr-secret',
          },
          data: {
            currentUrl:
              'https://alice:browser-url-secret@example.test/?access_key=browser-query-secret',
            snapshot: {
              text: 'Set-Cookie: sid=browser-text-secret; Path=/',
              linkText: 'Bearer browser-link-secret',
            },
            localStorage: {
              session: 'browser-session-secret',
            },
          },
        });

        await observationService.attachArtifact({
          component: 'profile',
          type: 'error_context',
          label: 'profile artifact',
          attrs: {
            profileSessionId: 'profile-attr-secret',
            safe: 'visible-profile-attr',
          },
          data: {
            status: 'expired',
            profileId: 'profile-1',
            cookies: [
              {
                name: 'sid',
                value: 'profile-cookie-secret',
                domain: 'example.test',
                path: '/',
                httpOnly: true,
              },
            ],
            localStorage: {
              token: 'profile-token-secret',
              safe: 'visible-profile',
            },
            password: 'profile-password-secret',
            note: 'Authorization: Bearer profile-note-secret',
          },
        });
      }
    );

    const stableArtifacts = sink.artifacts.map((artifact) => ({
      type: artifact.type,
      label: artifact.label,
      attrs: artifact.attrs,
      data: artifact.data,
    }));

    expect(stableArtifacts).toMatchInlineSnapshot(`
      [
        {
          "attrs": {
            "credentialId": "[redacted]",
            "safe": "visible-attr",
          },
          "data": {
            "currentUrl": "https://example.test/path?token=[redacted]&safe=1",
            "errorMessage": "password=[redacted]",
            "headers": {
              "authorization": "[redacted]",
            },
            "selectorHits": [
              {
                "selector": "#login",
                "text": "Authorization: Bearer [redacted]",
              },
            ],
          },
          "label": "failure artifact",
          "type": "site_adapter_failure",
        },
        {
          "attrs": {
            "accessKey": "[redacted]",
          },
          "data": {
            "changeSet": {
              "patch": "set password=[redacted]",
            },
            "cookies": "[redacted]",
            "reviewer": {
              "credential": "[redacted]",
            },
            "sql": "[REDACTED_SQL]",
          },
          "label": "repair artifact",
          "type": "site_adapter_repair_bundle",
        },
        {
          "attrs": {
            "cookie": "[redacted]",
          },
          "data": {
            "currentUrl": "https://[redacted]:[redacted]@example.test/?access_key=[redacted]",
            "localStorage": {
              "session": "[redacted]",
            },
            "snapshot": {
              "linkText": "Bearer [redacted]",
              "text": "Set-Cookie: [redacted]",
            },
          },
          "label": "browser artifact",
          "type": "snapshot",
        },
        {
          "attrs": {
            "profileSessionId": "[redacted]",
            "safe": "visible-profile-attr",
          },
          "data": {
            "cookies": "[redacted]",
            "localStorage": {
              "safe": "visible-profile",
              "token": "[redacted]",
            },
            "note": "Authorization: Bearer [redacted]",
            "password": "[redacted]",
            "profileId": "profile-1",
            "status": "expired",
          },
          "label": "profile artifact",
          "type": "error_context",
        },
      ]
    `);

    const serialized = JSON.stringify(stableArtifacts);
    for (const secret of [
      'failure-credential-secret',
      'failure-url-secret',
      'failure-header-secret',
      'failure-password-secret',
      'failure-text-secret',
      'repair-attr-secret',
      'repair-patch-secret',
      'repair-credential-secret',
      'repair-cookie-secret',
      'repair-sql-secret',
      'browser-attr-secret',
      'browser-url-secret',
      'browser-query-secret',
      'browser-text-secret',
      'browser-link-secret',
      'browser-session-secret',
      'profile-attr-secret',
      'profile-cookie-secret',
      'profile-token-secret',
      'profile-password-secret',
      'profile-note-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
