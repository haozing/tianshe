import http from 'node:http';

export interface BrowserEngineSmokeServer {
  baseUrl: string;
  networkIdleUrl: string;
  apiHits: string[];
  close: () => Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function createBrowserEngineSmokeServer(options: {
  title: string;
  pingMessage: string;
  noisyMessage?: string;
  networkIdleDelayMs?: number;
}): Promise<BrowserEngineSmokeServer> {
  const apiHits: string[] = [];
  const noisyMessage = options.noisyMessage ?? 'ignored by urlFilter';
  const networkIdleDelayMs =
    typeof options.networkIdleDelayMs === 'number' && options.networkIdleDelayMs > 0
      ? options.networkIdleDelayMs
      : 700;

  const server = http.createServer((request, response) => {
    const url = request.url || '/';
    if (url === '/network-idle') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${options.title} Network Idle</title>
  </head>
  <body>
    <div id="network-idle-result">pending</div>
    <script>
      fetch('/api/slow?delay=${networkIdleDelayMs}')
        .then((res) => res.json())
        .then((data) => {
          document.getElementById('network-idle-result').textContent = data.message;
        });
    </script>
  </body>
</html>`);
      return;
    }

    if (url === '/' || url.startsWith('/?')) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${options.title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      #result, #prompt-result { margin-top: 12px; color: #0f766e; }
    </style>
  </head>
  <body>
    <h1 id="title">${options.title}</h1>
    <input id="name" value="" placeholder="type here" />
    <select id="choice">
      <option value="alpha">alpha</option>
      <option value="beta">beta</option>
    </select>
    <button id="fetch">Run Fetch</button>
    <button id="prompt">Open Prompt</button>
    <button id="alert">Open Alert</button>
    <a id="download" href="/download/report.csv" download>Download Report</a>
    <div id="result"></div>
    <div id="prompt-result">idle</div>
    <script>
      console.info('smoke-page-ready');
      document.getElementById('fetch').addEventListener('click', async () => {
        console.log('smoke-button-clicked');
        const [response] = await Promise.all([
          fetch('/api/ping'),
          fetch('/api/noisy'),
        ]);
        const data = await response.json();
        document.getElementById('result').textContent = data.message;
      });
      document.getElementById('prompt').addEventListener('click', () => {
        const value = prompt('Enter smoke value', 'airpa');
        document.getElementById('prompt-result').textContent = value ?? 'cancelled';
      });
      document.getElementById('alert').addEventListener('click', () => {
        alert('Alert smoke value');
        document.getElementById('prompt-result').textContent = 'alert closed';
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (url === '/download/report.csv') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', 'attachment; filename=\"report.csv\"');
      response.end('id,name\n1,airpa\n');
      return;
    }

    if (url === '/api/ping') {
      apiHits.push(url);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ message: options.pingMessage }));
      return;
    }

    if (url === '/api/noisy') {
      apiHits.push(url);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ message: noisyMessage }));
      return;
    }

    if (url.startsWith('/api/slow')) {
      apiHits.push(url);
      const searchParams = new URL(`http://127.0.0.1${url}`).searchParams;
      const delay = Number.parseInt(searchParams.get('delay') || String(networkIdleDelayMs), 10) || networkIdleDelayMs;
      setTimeout(() => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ message: `slow response after ${delay}ms` }));
      }, delay);
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine smoke server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    networkIdleUrl: `http://127.0.0.1:${address.port}/network-idle`,
    apiHits,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
