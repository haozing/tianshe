import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserInterface,
  BrowserSessionRequestOptions,
  BrowserSessionRequestResponse,
} from '../../types/browser-interface';
import type { BrowserRuntimeId } from '../../types/browser-runtime';
import { getStaticRuntimeDescriptor } from '../browser-pool/runtime-capability-registry';
import {
  BrowserSessionRequestRuntimeError,
} from '../browser-automation/session-request-runtime';
import {
  ProfileSessionGatewayError,
  createProfileSessionGateway,
  type ProfileSessionGatewayAcquireOptions,
} from './profile-session-gateway';

function createResponse(
  overrides: Partial<BrowserSessionRequestResponse> = {}
): BrowserSessionRequestResponse {
  return {
    url: 'https://example.test/api/me',
    status: 200,
    statusText: 'OK',
    ok: true,
    redirected: false,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'sid=secret',
      authorization: 'Bearer secret',
      'x-internal-token': 'secret',
      ...overrides.headers,
    },
    bodyEncoding: 'text',
    bodyText: '{"ok":true}',
    mimeType: 'application/json',
    byteLength: 11,
    ...overrides,
  };
}

function createBrowser(
  runtimeId: BrowserRuntimeId,
  sessionRequestImpl?: (options: BrowserSessionRequestOptions) => Promise<BrowserSessionRequestResponse>
): BrowserInterface {
  const descriptor = getStaticRuntimeDescriptor(runtimeId);
  return {
    describeRuntime: vi.fn(() => descriptor),
    hasCapability: vi.fn((name) => descriptor.capabilities[name]?.supported === true),
    sessionRequest: vi.fn(sessionRequestImpl || (async () => createResponse())),
  } as unknown as BrowserInterface;
}

function createGateway(browser: BrowserInterface) {
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn(async (_options: ProfileSessionGatewayAcquireOptions) => ({
    browser,
    release,
  }));
  const gateway = createProfileSessionGateway({ acquire });
  return { gateway, acquire, release };
}

function expectGatewayCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ProfileSessionGatewayError);
  expect((error as ProfileSessionGatewayError).code).toBe(code);
}

describe('ProfileSessionGateway network.sessionRequest contract', () => {
  it.each([
    ['electron-webcontents' as const],
    ['chromium-extension-relay' as const],
  ])('passes the same session request contract for %s', async (runtimeId) => {
    const browser = createBrowser(runtimeId);
    const { gateway, acquire, release } = createGateway(browser);

    const response = await gateway.withSession(
      {
        profileId: 'profile-1',
        site: 'https://example.test',
        pluginId: 'plugin-a',
        requiredCapabilities: ['network.sessionRequest'],
        intent: 'read',
      },
      (session) =>
        session.request({
          url: 'https://example.test/api/me',
          method: 'GET',
          headers: {
            accept: 'application/json',
          },
          maxResponseBytes: 128,
        })
    );

    expect(response).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      bodyText: '{"ok":true}',
    });
    expect(response.headers).not.toHaveProperty('set-cookie');
    expect(response.headers).not.toHaveProperty('authorization');
    expect(response.headers).not.toHaveProperty('x-internal-token');
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        pluginId: 'plugin-a',
        requiredCapabilities: ['network.sessionRequest'],
        intent: 'read',
      })
    );
    expect(browser.sessionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.test/api/me',
        headers: { accept: 'application/json' },
      })
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported runtime descriptors before dispatching the request', async () => {
    const browser = createBrowser('firefox-bidi');
    const { gateway, release } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) => session.request({ url: 'https://example.test/api/me' })
      )
    ).rejects.toMatchObject({
      code: 'unsupported_runtime',
    });

    expect(browser.sessionRequest).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('enforces same-origin scope by default and allows explicit origin scope', async () => {
    const browser = createBrowser('electron-webcontents');
    const { gateway } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) => session.request({ url: 'https://other.test/api/me' })
      )
    ).rejects.toMatchObject({
      code: 'url_scope_denied',
    });

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          allowedOrigins: ['https://api.example.test'],
          intent: 'read',
        },
        (session) => session.request({ url: 'https://api.example.test/me' })
      )
    ).resolves.toMatchObject({
      status: 200,
    });
  });

  it('does not let request-level allowed origins expand the session scope', async () => {
    const browser = createBrowser('electron-webcontents');
    const { gateway } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) =>
          session.request({
            url: 'https://api.example.test/me',
            allowedOrigins: ['https://api.example.test'],
          })
      )
    ).rejects.toMatchObject({
      code: 'url_scope_denied',
    });
    expect(browser.sessionRequest).not.toHaveBeenCalled();

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          allowedOrigins: ['https://api.example.test'],
          intent: 'read',
        },
        (session) =>
          session.request({
            url: 'https://api.example.test/me',
            allowedOrigins: ['https://api.example.test'],
          })
      )
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(browser.sessionRequest).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        allowedOrigins: expect.any(Array),
      })
    );
  });

  it('blocks automatic redirects by default before dispatching to the runtime', async () => {
    const browser = createBrowser('electron-webcontents');
    const { gateway } = createGateway(browser);

    await gateway.withSession(
      {
        profileId: 'profile-1',
        site: 'https://example.test',
        intent: 'read',
      },
      (session) =>
        session.request({
          url: 'https://example.test/api/me',
        })
    );

    expect(browser.sessionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect: 'error',
      })
    );
  });

  it('rejects responses that followed redirects outside the allowed origin scope', async () => {
    const browser = createBrowser('electron-webcontents', async () =>
      createResponse({
        url: 'https://evil.test/api/me',
        redirected: true,
      })
    );
    const { gateway } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) => session.request({ url: 'https://example.test/api/me', redirect: 'follow' })
      )
    ).rejects.toMatchObject({
      code: 'url_scope_denied',
    });
  });

  it('blocks dangerous request headers before they reach the runtime', async () => {
    const browser = createBrowser('chromium-extension-relay');
    const { gateway, release } = createGateway(browser);

    let caught: unknown;
    try {
      await gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) =>
          session.request({
            url: 'https://example.test/api/me',
            headers: {
              cookie: 'sid=secret',
            },
          })
      );
    } catch (error) {
      caught = error;
    }

    expectGatewayCode(caught, 'dangerous_header');
    expect(browser.sessionRequest).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('classifies body size violations without leaking business payload details', async () => {
    const browser = createBrowser('electron-webcontents', async () =>
      createResponse({
        byteLength: 129,
        bodyText: 'x'.repeat(129),
      })
    );
    const { gateway } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
        },
        (session) =>
          session.request({
            url: 'https://example.test/api/me',
            maxResponseBytes: 128,
          })
      )
    ).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });

  it('passes cancellation to the runtime and still releases the lease', async () => {
    const controller = new AbortController();
    const browser = createBrowser('chromium-extension-relay', async () => {
      throw new BrowserSessionRequestRuntimeError('aborted', 'Browser session request aborted');
    });
    const { gateway, release } = createGateway(browser);
    controller.abort();

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'read',
          signal: controller.signal,
        },
        (session) =>
          session.request({
            url: 'https://example.test/api/me',
          })
      )
    ).rejects.toMatchObject({
      code: 'aborted',
    });

    expect(browser.sessionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      })
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('requires confirmed capability context for write intent', async () => {
    const browser = createBrowser('electron-webcontents');
    const { gateway } = createGateway(browser);

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'write',
        },
        (session) =>
          session.request({
            url: 'https://example.test/api/items',
            method: 'POST',
            body: '{}',
            headers: {
              'content-type': 'application/json',
            },
          })
      )
    ).rejects.toMatchObject({
      code: 'write_intent_denied',
    });

    await expect(
      gateway.withSession(
        {
          profileId: 'profile-1',
          site: 'https://example.test',
          intent: 'write',
          executionContext: {
            capability: 'site.items.create',
            confirmed: true,
          },
        },
        (session) =>
          session.request({
            url: 'https://example.test/api/items',
            method: 'POST',
            body: '{}',
            headers: {
              'content-type': 'application/json',
            },
          })
      )
    ).resolves.toMatchObject({
      status: 200,
    });
  });
});
