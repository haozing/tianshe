import { describe, expect, it, vi } from 'vitest';
import type { BrowserInterface } from '../../../types/browser-interface';
import { getStaticRuntimeDescriptor } from '../../browser-pool/runtime-capability-registry';
import { createPluginBrowserFacade } from './profile-browser-facade';

function createBrowserFixture(): BrowserInterface {
  return {
    describeRuntime: vi.fn(() => getStaticRuntimeDescriptor('electron-webcontents')),
    hasCapability: vi.fn(() => true),
    goto: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    getCurrentUrl: vi.fn(),
    title: vi.fn(),
    snapshot: vi.fn(),
    search: vi.fn(),
    getText: vi.fn(),
    getAttribute: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    select: vi.fn(),
    evaluate: vi.fn(),
    evaluateWithArgs: vi.fn(),
    getCookies: vi.fn(),
    setCookie: vi.fn(),
    clearCookies: vi.fn(),
    sessionRequest: vi.fn(async (options) => ({
      url: options.url,
      status: 200,
      statusText: 'OK',
      ok: true,
      redirected: false,
      headers: {},
      bodyEncoding: 'text',
      bodyText: '{}',
      mimeType: 'application/json',
      byteLength: 2,
    })),
    enableRequestInterception: vi.fn(),
    disableRequestInterception: vi.fn(),
    continueRequest: vi.fn(),
    fulfillRequest: vi.fn(),
    failRequest: vi.fn(),
    setDownloadBehavior: vi.fn(async () => undefined),
    listDownloads: vi.fn(async () => [
      {
        id: 'download-1',
        suggestedFilename: 'orders.csv',
        path: 'C:\\Users\\secret\\Downloads\\orders.csv',
        state: 'completed',
        artifactRef: {
          artifactId: 'artifact-download-1',
          type: 'download',
          payload: {
            kind: 'file',
            filename: 'orders.csv',
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
          },
        },
      },
    ]),
    waitForDownload: vi.fn(async () => ({
      id: 'download-2',
      suggestedFilename: 'report.csv',
      path: 'D:\\private\\report.csv',
      state: 'completed',
      artifactRef: {
        artifactId: 'artifact-download-2',
        type: 'download',
      },
    })),
    cancelDownload: vi.fn(),
    native: {
      click: vi.fn(),
      move: vi.fn(),
      drag: vi.fn(),
      type: vi.fn(),
      keyPress: vi.fn(),
      scroll: vi.fn(),
    },
  } as unknown as BrowserInterface;
}

describe('createPluginBrowserFacade download surface', () => {
  it('hides host file paths and preserves artifact refs', async () => {
    const browser = createBrowserFixture();
    const facade = createPluginBrowserFacade(browser);

    await expect(facade.listDownloads!()).resolves.toEqual([
      {
        id: 'download-1',
        suggestedFilename: 'orders.csv',
        state: 'completed',
        artifactRef: {
          artifactId: 'artifact-download-1',
          type: 'download',
          payload: {
            kind: 'file',
            filename: 'orders.csv',
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
          },
        },
      },
    ]);
    await expect(facade.waitForDownload!()).resolves.toEqual({
      id: 'download-2',
      suggestedFilename: 'report.csv',
      state: 'completed',
      artifactRef: {
        artifactId: 'artifact-download-2',
        type: 'download',
      },
    });
  });

  it('does not let plugins provide arbitrary download paths', async () => {
    const browser = createBrowserFixture();
    const facade = createPluginBrowserFacade(browser);

    await expect(
      facade.setDownloadBehavior!({
        policy: 'allow',
        downloadPath: 'C:\\Users\\secret\\Downloads',
      })
    ).rejects.toThrow('downloadPath');
    expect(browser.setDownloadBehavior).not.toHaveBeenCalled();

    await expect(facade.setDownloadBehavior!({ policy: 'deny' })).resolves.toBeUndefined();
    expect(browser.setDownloadBehavior).toHaveBeenCalledWith({ policy: 'deny' });
  });

  it('keeps practical browser interaction methods available while blocking sensitive raw escape hatches', async () => {
    const browser = createBrowserFixture();
    const audit = vi.fn();
    const facade = createPluginBrowserFacade(browser, {
      nativeInput: {
        pluginId: 'plugin-1',
        trustModel: 'first_party',
        audit,
      },
    });

    await facade.click('#login-btn');
    await facade.type('#email', 'alice@example.test', { clear: true });
    await facade.select('#status', 'active');
    await facade.native.click(120, 240);
    await facade.native.type('super-secret-password');

    expect(browser.click).toHaveBeenCalledWith('#login-btn');
    expect(browser.type).toHaveBeenCalledWith('#email', 'alice@example.test', { clear: true });
    expect(browser.select).toHaveBeenCalledWith('#status', 'active');
    expect(browser.native.click).toHaveBeenCalledWith(120, 240, undefined);
    expect(browser.native.type).toHaveBeenCalledWith('super-secret-password', undefined);
    expect(audit).toHaveBeenCalledWith({
      capability: 'input.native',
      method: 'click',
      args: [120, 240, undefined],
      trustModel: 'first_party',
    });
    expect(audit).toHaveBeenCalledWith({
      capability: 'input.native',
      method: 'type',
      args: ['super-secret-password', undefined],
      trustModel: 'first_party',
    });
    expect(Object.keys(facade)).toContain('native');
  });

  it('keeps native input behind the explicit input.native runtime capability', async () => {
    const browser = createBrowserFixture();
    browser.hasCapability = vi.fn((capability) => capability !== 'input.native');
    const facade = createPluginBrowserFacade(browser);

    expect('native' in facade).toBe(false);
    expect(Object.keys(facade)).not.toContain('native');
  });

  it('blocks raw evaluate, cookie, and request rewrite methods from the default plugin facade', async () => {
    const browser = createBrowserFixture();
    const facade = createPluginBrowserFacade(browser) as BrowserInterface & Record<string, unknown>;

    for (const method of [
      'evaluate',
      'evaluateWithArgs',
      'getCookies',
      'setCookie',
      'clearCookies',
      'enableRequestInterception',
      'disableRequestInterception',
      'continueRequest',
      'fulfillRequest',
      'failRequest',
    ]) {
      expect(method in facade).toBe(false);
      expect(Object.keys(facade)).not.toContain(method);
      expect(() => facade[method]).toThrow('not available');
    }

    expect('sessionRequest' in facade).toBe(false);
    expect(Object.keys(facade)).not.toContain('sessionRequest');
    expect(() => facade.sessionRequest).toThrow('not available');
    expect(browser.sessionRequest).not.toHaveBeenCalled();
    expect(browser.evaluate).not.toHaveBeenCalled();
    expect(browser.getCookies).not.toHaveBeenCalled();
    expect(browser.enableRequestInterception).not.toHaveBeenCalled();
    expect(browser.disableRequestInterception).not.toHaveBeenCalled();
  });

  it('uses ProfileSessionGateway semantics for plugin sessionRequest when profile context is present', async () => {
    const browser = createBrowserFixture();
    browser.getCurrentUrl = vi.fn(async () => 'https://example.test/dashboard');
    const facade = createPluginBrowserFacade(browser, {
      sessionRequest: {
        profileId: 'profile-1',
        pluginId: 'plugin-1',
      },
    }) as BrowserInterface & Record<string, unknown>;

    await expect(
      facade.sessionRequest!({
        url: 'https://example.test/api',
        headers: {
          Accept: 'application/json',
        },
      })
    ).resolves.toMatchObject({
      status: 200,
      bodyText: '{}',
    });
    expect(browser.sessionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.test/api',
        headers: {
          accept: 'application/json',
        },
      })
    );

    await expect(
      facade.sessionRequest!({
        url: 'https://example.test/api',
        headers: {
          Cookie: 'sid=secret',
        },
      })
    ).rejects.toMatchObject({
      code: 'dangerous_header',
    });
    await expect(
      facade.sessionRequest!({
        url: 'https://example.test/api',
        method: 'POST',
      })
    ).rejects.toMatchObject({
      code: 'write_intent_denied',
    });
    await expect(
      facade.sessionRequest!({
        url: 'https://evil.test/api',
      })
    ).rejects.toMatchObject({
      code: 'url_scope_denied',
    });
  });

  it('allows plugin sessionRequest to use host-declared extra origins only', async () => {
    const browser = createBrowserFixture();
    browser.getCurrentUrl = vi.fn(async () => 'https://app.example.test/dashboard');
    const facade = createPluginBrowserFacade(browser, {
      sessionRequest: {
        profileId: 'profile-1',
        pluginId: 'plugin-1',
        allowedOrigins: ['https://api.example.test'],
      },
    }) as BrowserInterface & Record<string, unknown>;

    await expect(
      facade.sessionRequest!({
        url: 'https://api.example.test/me',
        allowedOrigins: ['https://api.example.test'],
      })
    ).resolves.toMatchObject({
      status: 200,
    });

    await expect(
      facade.sessionRequest!({
        url: 'https://evil.example.test/me',
        allowedOrigins: ['https://evil.example.test'],
      })
    ).rejects.toMatchObject({
      code: 'url_scope_denied',
    });
  });
});
