import { renderBackgroundScript } from './extension-control-extension-background';

type ControlExtensionBundleInput = {
  runtimeConfig: {
    browserId: string;
    token: string;
    relayBaseUrl: string;
    proxy?: {
      type?: string;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      bypassList?: string;
    } | null;
  };
};

function renderManifest(): string {
  return JSON.stringify(
    {
      manifest_version: 3,
      name: 'Airpa Browser Control',
      version: '1.0.0',
      minimum_chrome_version: '120',
      permissions: [
        'tabs',
        'scripting',
        'debugger',
        'cookies',
        'downloads',
        'storage',
        'offscreen',
        'windows',
        'webRequest',
        'webRequestAuthProvider',
      ],
      host_permissions: ['<all_urls>'],
      background: {
        service_worker: 'background.js',
      },
      offscreen_documents: [
        {
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Maintain authenticated loopback relay for browser automation control.',
        },
      ],
    },
    null,
    2
  );
}

function renderOffscreenHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Airpa Relay</title>
  </head>
  <body>
    <script src="offscreen.js"></script>
  </body>
</html>`;
}

function renderOffscreenScript(): string {
  return String.raw`let runtimeConfigPromise = null;
let registered = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRuntimeMessage(type, payload) {
  return chrome.runtime.sendMessage({
    type,
    ...(payload && typeof payload === 'object' ? payload : {}),
  });
}

async function getRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = sendRuntimeMessage('airpa-get-relay-config')
      .then((config) => {
        if (!config || typeof config !== 'object') {
          throw new Error('Failed to resolve relay runtime config');
        }
        if (!config.browserId || !config.token || !config.relayBaseUrl) {
          throw new Error('Relay runtime config is incomplete');
        }
        return config;
      })
      .catch((error) => {
        runtimeConfigPromise = null;
        throw error;
      });
  }
  return runtimeConfigPromise;
}

async function getBackgroundDiagnostics() {
  try {
    const diagnostics = await sendRuntimeMessage('airpa-get-diagnostics');
    return diagnostics && typeof diagnostics === 'object' ? diagnostics : undefined;
  } catch {
    return undefined;
  }
}

async function reportRegisterFailure(error) {
  try {
    await sendRuntimeMessage('airpa-register-failure', {
      error: error instanceof Error ? error.message : String(error || 'register_failed'),
    });
  } catch {
    // ignore diagnostic updates
  }
}

async function postResult(payload) {
  const config = await getRuntimeConfig();
  const diagnostics = await getBackgroundDiagnostics();
  await fetch(config.relayBaseUrl + '/result', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      browserId: config.browserId,
      token: config.token,
      ...payload,
      ...(diagnostics ? { diagnostics } : {}),
    }),
  });
}

async function registerClient() {
  const config = await getRuntimeConfig();
  let state = {};
  try {
    state = (await chrome.runtime.sendMessage({ type: 'airpa-get-state' })) || {};
  } catch {
    state = {};
  }

  const response = await fetch(config.relayBaseUrl + '/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      browserId: config.browserId,
      token: config.token,
      ...state,
    }),
  });

  if (!response.ok) {
    await reportRegisterFailure(new Error('Failed to register control extension client'));
    throw new Error('Failed to register control extension client');
  }
  registered = true;
}

async function pollLoop() {
  while (true) {
    try {
      if (!registered) {
        await registerClient();
      }

      const config = await getRuntimeConfig();
      const response = await fetch(
        config.relayBaseUrl +
          '/poll?browserId=' +
          encodeURIComponent(config.browserId) +
          '&token=' +
          encodeURIComponent(config.token)
      );

      if (response.status === 204) {
        continue;
      }
      if (response.status === 410) {
        break;
      }
      if (!response.ok) {
        registered = false;
        await sleep(1000);
        continue;
      }

      const payload = await response.json();
      const command = payload && payload.command ? payload.command : null;
      if (!command || !command.requestId) {
        continue;
      }

      let resultPayload;
      try {
        const execution = await chrome.runtime.sendMessage({
          type: 'airpa-exec',
          command,
        });
        resultPayload = {
          requestId: command.requestId,
          ok: execution ? execution.ok !== false : true,
          result: execution ? execution.result : undefined,
          error: execution ? execution.error : undefined,
        };
      } catch (error) {
        resultPayload = {
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await postResult(resultPayload);
    } catch (error) {
      if (!registered) {
        await reportRegisterFailure(error);
      }
      registered = false;
      await sleep(1200);
    }
  }
}

pollLoop();`;
}

export function renderControlExtensionBundle(input: ControlExtensionBundleInput): Record<string, string> {
  return {
    'manifest.json': renderManifest(),
    'offscreen.html': renderOffscreenHtml(),
    'offscreen.js': renderOffscreenScript(),
    'background.js': renderBackgroundScript(input.runtimeConfig),
  };
}
