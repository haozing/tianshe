import { describe, expect, it } from 'vitest';
import { renderControlExtensionBundle } from './extension-control-extension-bundle';

function createBundle() {
  return renderControlExtensionBundle({
    runtimeConfig: {
      browserId: 'browser-1',
      token: 'token-1',
      relayBaseUrl: 'http://127.0.0.1:39090',
      proxy: {
        host: '127.0.0.1',
        port: 7890,
        username: 'airpa',
        password: 'secret',
      },
    },
  });
}

describe('extension control extension bundle', () => {
  it('does not emit a web-accessible runtime-config file', () => {
    const bundle = createBundle();
    const manifest = JSON.parse(bundle['manifest.json']);

    expect(bundle['runtime-config.json']).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('uses runtime messages for relay config and avoids DOM dataset markers', () => {
    const bundle = createBundle();
    const manifest = JSON.parse(bundle['manifest.json']);

    expect(bundle['offscreen.js']).toContain("sendRuntimeMessage('airpa-get-relay-config')");
    expect(bundle['offscreen.js']).not.toContain("runtime-config.json");
    expect(bundle['page-init.js']).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(bundle['background.js']).toContain('const AIRPA_RUNTIME_CONFIG =');
  });
});
