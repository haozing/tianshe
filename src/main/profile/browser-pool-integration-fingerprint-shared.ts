import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrowserCore } from '../../types/browser-interface';
import { waitForCondition } from './browser-pool-integration-smoke-shared';

export interface FingerprintProbeServer {
  probeUrl: string;
  variantUrl: (view?: string) => string;
  close: () => Promise<void>;
}

export interface FingerprintProbeSnapshot {
  href: string;
  pathname: string;
  search: string;
  title: string;
  readyState: string;
  navigationType: string;
  userAgent: string;
  platform: string;
  language: string;
  languages: string[];
  locale: string;
  timezone: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  webdriver: boolean | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
  };
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    devicePixelRatio: number;
  };
  touchEventAvailable: boolean;
  webgl: {
    maskedVendor: string | null;
    maskedRenderer: string | null;
    version: string | null;
    shadingLanguageVersion: string | null;
    unmaskedVendor: string | null;
    unmaskedRenderer: string | null;
  } | null;
}

const FINGERPRINT_PROBE_SCRIPT = `(() => {
  const nav = navigator;
  const resolved =
    typeof Intl !== 'undefined' && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions()
      : {};
  const navigationEntry =
    typeof performance !== 'undefined' &&
    typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('navigation')[0]
      : null;
  const canvas = document.createElement('canvas');
  const gl =
    canvas.getContext('webgl') ||
    canvas.getContext('experimental-webgl') ||
    canvas.getContext('webgl2');
  let webgl = null;
  if (gl) {
    let maskedVendor = null;
    let maskedRenderer = null;
    let version = null;
    let shadingLanguageVersion = null;
    let unmaskedVendor = null;
    let unmaskedRenderer = null;
    try {
      maskedVendor = String(gl.getParameter(gl.VENDOR) || '');
      maskedRenderer = String(gl.getParameter(gl.RENDERER) || '');
      version = String(gl.getParameter(gl.VERSION) || '');
      shadingLanguageVersion = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '');
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        unmaskedVendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '');
        unmaskedRenderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');
      }
    } catch {
      // ignore probe failures and keep nullable fields
    }
    webgl = {
      maskedVendor: maskedVendor || null,
      maskedRenderer: maskedRenderer || null,
      version: version || null,
      shadingLanguageVersion: shadingLanguageVersion || null,
      unmaskedVendor: unmaskedVendor || null,
      unmaskedRenderer: unmaskedRenderer || null,
    };
  }

  return {
    href: String(location.href || ''),
    pathname: String(location.pathname || ''),
    search: String(location.search || ''),
    title: String(document.title || ''),
    readyState: String(document.readyState || ''),
    navigationType:
      navigationEntry && typeof navigationEntry.type === 'string' ? navigationEntry.type : '',
    userAgent: String(nav.userAgent || ''),
    platform: String(nav.platform || ''),
    language: String(nav.language || ''),
    languages: Array.isArray(nav.languages) ? Array.from(nav.languages).map((value) => String(value || '')) : [],
    locale: String((resolved && resolved.locale) || ''),
    timezone: String((resolved && resolved.timeZone) || ''),
    hardwareConcurrency: Number(nav.hardwareConcurrency || 0),
    deviceMemory: typeof nav.deviceMemory === 'number' ? Number(nav.deviceMemory) : null,
    maxTouchPoints: Number(nav.maxTouchPoints || 0),
    webdriver: typeof nav.webdriver === 'boolean' ? nav.webdriver : nav.webdriver == null ? null : Boolean(nav.webdriver),
    screen: {
      width: Number(screen.width || 0),
      height: Number(screen.height || 0),
      availWidth: Number(screen.availWidth || 0),
      availHeight: Number(screen.availHeight || 0),
      colorDepth: Number(screen.colorDepth || 0),
      pixelDepth: Number(screen.pixelDepth || 0),
    },
    viewport: {
      innerWidth: Number(window.innerWidth || 0),
      innerHeight: Number(window.innerHeight || 0),
      outerWidth: Number(window.outerWidth || 0),
      outerHeight: Number(window.outerHeight || 0),
      devicePixelRatio: Number(window.devicePixelRatio || 0),
    },
    touchEventAvailable: typeof window.TouchEvent === 'function' || 'ontouchstart' in window,
    webgl,
  };
})()`;

function buildProbeHtml(title: string, view: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      nav { display: flex; gap: 12px; margin-top: 12px; }
      .meta { margin-top: 8px; color: #334155; }
    </style>
  </head>
  <body>
    <h1 id="probe-title">${title}</h1>
    <div id="probe-view" class="meta">${view || 'base'}</div>
    <div id="probe-search" class="meta"></div>
    <nav>
      <a id="probe-nav-base" href="/probe">base</a>
      <a id="probe-nav-one" href="/probe?view=one">one</a>
      <a id="probe-nav-two" href="/probe?view=two">two</a>
    </nav>
    <script>
      document.getElementById('probe-search').textContent = location.search || '(no query)';
      console.info('fingerprint-probe-ready:' + (location.search || '(base)'));
    </script>
  </body>
</html>`;
}

export async function createFingerprintProbeServer(options: {
  title: string;
}): Promise<FingerprintProbeServer> {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

    if (requestUrl.pathname === '/') {
      response.statusCode = 302;
      response.setHeader('location', '/probe');
      response.end();
      return;
    }

    if (requestUrl.pathname === '/probe') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(buildProbeHtml(options.title, requestUrl.searchParams.get('view') || ''));
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
    throw new Error('Failed to determine fingerprint probe server address');
  }

  const origin = `http://127.0.0.1:${address.port}`;

  return {
    probeUrl: `${origin}/probe`,
    variantUrl: (view?: string) =>
      view && view.trim().length > 0
        ? `${origin}/probe?view=${encodeURIComponent(view.trim())}`
        : `${origin}/probe`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function readFingerprintProbe(
  browser: Pick<BrowserCore, 'evaluate'>
): Promise<FingerprintProbeSnapshot> {
  return browser.evaluate<FingerprintProbeSnapshot>(FINGERPRINT_PROBE_SCRIPT);
}

export async function waitForFingerprintProbe(
  browser: Pick<BrowserCore, 'evaluate'>,
  label: string
): Promise<FingerprintProbeSnapshot> {
  let latest: FingerprintProbeSnapshot | null = null;
  await waitForCondition(async () => {
    latest = await readFingerprintProbe(browser);
    return (
      latest.readyState === 'complete' &&
      latest.userAgent.length > 0 &&
      latest.timezone.length > 0 &&
      latest.screen.width > 0 &&
      latest.viewport.innerWidth > 0
    );
  }, 15_000, label);
  if (!latest) {
    throw new Error(`Fingerprint probe resolved without a snapshot for ${label}`);
  }
  return latest;
}

export async function waitForFingerprintProbeMatch(
  browser: Pick<BrowserCore, 'evaluate'>,
  label: string,
  predicate: (snapshot: FingerprintProbeSnapshot) => boolean,
  timeoutMs: number = 15_000
): Promise<FingerprintProbeSnapshot> {
  let latest: FingerprintProbeSnapshot | null = null;
  await waitForCondition(async () => {
    latest = await readFingerprintProbe(browser);
    return predicate(latest);
  }, timeoutMs, label);
  if (!latest) {
    throw new Error(`Fingerprint probe resolved without a snapshot for ${label}`);
  }
  return latest;
}

export async function writeFingerprintRealReport(
  reportPath: string,
  report: Record<string, unknown>
): Promise<void> {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
