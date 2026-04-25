import type { Event as ElectronEvent, WebContents, WebContentsWillFrameNavigateEventParams } from 'electron';

const ALLOWED_WEB_CONTENTS_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'chrome-devtools:',
  'chrome-error:',
  'data:',
  'devtools:',
  'file:',
  'http:',
  'https:',
  'javascript:',
]);

type GuardEventName = 'will-navigate' | 'will-redirect' | 'will-frame-navigate';
type WindowOpenGuardEventName = 'window-open';

type GuardCallbackPayload = {
  eventName: GuardEventName | WindowOpenGuardEventName;
  protocol: string;
  url: string;
};

type NavigationGuardOptions = {
  onBlocked?: (payload: GuardCallbackPayload) => void;
};

type GuardableWebContents = Pick<WebContents, 'on' | 'removeListener' | 'setWindowOpenHandler'>;
type WillFrameNavigateDetails = ElectronEvent<WebContentsWillFrameNavigateEventParams>;

export function extractNavigationProtocol(url: string): string | null {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).protocol.toLowerCase();
  } catch {
    const fallbackMatch = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)/);
    return fallbackMatch ? fallbackMatch[1].toLowerCase() : null;
  }
}

export function getBlockedNavigationProtocol(url: string): string | null {
  const protocol = extractNavigationProtocol(url);
  if (!protocol) {
    return null;
  }

  return ALLOWED_WEB_CONTENTS_PROTOCOLS.has(protocol) ? null : protocol;
}

export function isAllowedWebContentsNavigationUrl(url: string): boolean {
  return getBlockedNavigationProtocol(url) === null;
}

export function createBlockedNavigationError(url: string): Error | null {
  const protocol = getBlockedNavigationProtocol(url);
  if (!protocol) {
    return null;
  }

  return new Error(`Navigation blocked for unsupported protocol: ${protocol} (${url})`);
}

export function attachNavigationBlocker(
  webContents: GuardableWebContents,
  options?: NavigationGuardOptions
): () => void {
  const blockIfNeeded = (
    event: { preventDefault?: () => void } | undefined,
    url: string,
    eventName: GuardEventName
  ) => {
    const protocol = getBlockedNavigationProtocol(url);
    if (!protocol) {
      return;
    }

    event?.preventDefault?.();
    options?.onBlocked?.({ eventName, protocol, url });
  };

  const handleWillNavigate = (event: { preventDefault?: () => void }, url: string) => {
    blockIfNeeded(event, url, 'will-navigate');
  };

  const handleWillRedirect = (event: { preventDefault?: () => void }, url: string) => {
    blockIfNeeded(event, url, 'will-redirect');
  };

  const handleWillFrameNavigate = (details: WillFrameNavigateDetails) => {
    blockIfNeeded(details, details.url, 'will-frame-navigate');
  };

  webContents.on('will-navigate', handleWillNavigate);
  webContents.on('will-redirect', handleWillRedirect);
  webContents.on('will-frame-navigate', handleWillFrameNavigate);

  return () => {
    webContents.removeListener('will-navigate', handleWillNavigate);
    webContents.removeListener('will-redirect', handleWillRedirect);
    webContents.removeListener('will-frame-navigate', handleWillFrameNavigate);
  };
}

export function installWindowOpenBlocker(
  webContents: Pick<WebContents, 'setWindowOpenHandler'>,
  options?: NavigationGuardOptions
): void {
  webContents.setWindowOpenHandler((details) => {
    const protocol = getBlockedNavigationProtocol(details.url);
    if (!protocol) {
      return { action: 'allow' };
    }

    options?.onBlocked?.({ eventName: 'window-open', protocol, url: details.url });
    return { action: 'deny' };
  });
}

export function attachNavigationGuards(
  webContents: GuardableWebContents,
  options?: NavigationGuardOptions
): () => void {
  const cleanupNavigationBlocker = attachNavigationBlocker(webContents, options);
  installWindowOpenBlocker(webContents, options);
  return cleanupNavigationBlocker;
}
