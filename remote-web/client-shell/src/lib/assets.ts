export function remoteAsset(path: string) {
  if (/^https?:\/\//i.test(path) || path.startsWith("/")) return path;
  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\.?\//, "")}`;
}
