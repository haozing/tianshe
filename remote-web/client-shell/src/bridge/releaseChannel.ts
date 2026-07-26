import type { ReleaseChannel } from "./storage";

const REMOTE_WEB_ROOT = "/remote-web/";

function remoteWebTail(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    const lowerPath = url.pathname.toLowerCase();
    const rootIndex = lowerPath.indexOf(REMOTE_WEB_ROOT);
    if (rootIndex < 0) return null;
    return {
      url,
      prefix: url.pathname.slice(0, rootIndex),
      tail: url.pathname.slice(rootIndex + REMOTE_WEB_ROOT.length)
    };
  } catch {
    return null;
  }
}

export function releaseChannelFromRemoteOrigin(remoteOrigin: unknown): ReleaseChannel | null {
  const parsed = remoteWebTail(remoteOrigin);
  if (!parsed) return null;
  if (/^beta(?:\/|$)/i.test(parsed.tail)) return "beta";
  if (/^current(?:\/|$)/i.test(parsed.tail)) return "stable";
  return null;
}

export function remoteUrlForReleaseChannel(channel: ReleaseChannel, remoteOrigin: unknown) {
  const parsed = remoteWebTail(remoteOrigin);
  if (!parsed || !releaseChannelFromRemoteOrigin(remoteOrigin)) return "";
  parsed.url.pathname = `${parsed.prefix}${REMOTE_WEB_ROOT}${channel === "beta" ? "beta/current" : "current"}/new-remote-web/index.html`;
  parsed.url.search = "";
  parsed.url.hash = "";
  return parsed.url.toString();
}
