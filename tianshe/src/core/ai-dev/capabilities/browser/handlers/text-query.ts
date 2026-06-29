import type { Bounds } from '../../../../coordinate';
import type { BrowserWithViewportFeatures } from './shared';

export function normalizeRegion(
  region: unknown,
  browser: BrowserWithViewportFeatures
): Promise<Bounds | undefined> {
  if (!region || typeof region !== 'object') {
    return Promise.resolve(undefined);
  }

  const raw = region as {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    space?: unknown;
  };
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    return Promise.resolve(undefined);
  }

  const space = raw.space === 'viewport' ? 'viewport' : 'normalized';
  if (space === 'viewport') {
    return Promise.resolve({ x, y, width, height });
  }

  return browser.getViewport().then((viewport) => ({
    x: Math.round((x / 100) * viewport.width),
    y: Math.round((y / 100) * viewport.height),
    width: Math.round((width / 100) * viewport.width),
    height: Math.round((height / 100) * viewport.height),
  }));
}

export function getTextQueryOptions(
  params: {
    strategy?: 'auto' | 'dom' | 'ocr';
    exactMatch?: boolean;
    timeoutMs?: number;
    region?: unknown;
  },
  browser: BrowserWithViewportFeatures
) {
  return normalizeRegion(params.region, browser).then((region) => ({
    strategy: params.strategy || 'auto',
    exactMatch: params.exactMatch === true,
    timeoutMs: params.timeoutMs,
    ...(region ? { region } : {}),
  }));
}
