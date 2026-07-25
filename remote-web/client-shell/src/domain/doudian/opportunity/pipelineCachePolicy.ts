export function resolvePipelineCacheScope(
  requestedScope: string,
  globalEnabled: boolean,
  tenantId: string
): "shop" | "global" {
  return requestedScope.toLowerCase() === "global" && globalEnabled && tenantId !== "local-user"
    ? "global"
    : "shop";
}

export function evaluateSharedCacheProbe(args: {
  cachedIds: string[];
  probeIds: string[];
  cachedRemoteTotal: number;
  cachedRemoteTotalKnown: boolean;
  probeRemoteTotal?: number;
}) {
  const normalize = (values: string[]) => [...values].sort();
  const cachedIds = normalize(args.cachedIds);
  const probeIds = normalize(args.probeIds);
  const totalMatches = !args.cachedRemoteTotalKnown
    || args.probeRemoteTotal === undefined
    || args.probeRemoteTotal === args.cachedRemoteTotal;
  const fingerprintMatches = cachedIds.length === probeIds.length
    && cachedIds.every((value, index) => value === probeIds[index]);
  return { ok: totalMatches && fingerprintMatches, totalMatches, fingerprintMatches };
}
