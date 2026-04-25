export interface CloudPageData<T> {
  list?: T[];
  count?: number;
  pageIndex?: number;
  pageSize?: number;
  items?: T[];
  total?: number;
}

export interface NormalizedCloudPage<T> {
  items: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

export function normalizeCloudPageData<T>(
  raw: CloudPageData<T> | null | undefined
): NormalizedCloudPage<T> {
  const items = Array.isArray(raw?.items)
    ? raw?.items || []
    : Array.isArray(raw?.list)
      ? raw?.list || []
      : [];
  const total = Number.isFinite(Number(raw?.total))
    ? Number(raw?.total)
    : Number.isFinite(Number(raw?.count))
      ? Number(raw?.count)
      : items.length;
  const pageIndex =
    Number.isFinite(Number(raw?.pageIndex)) && Number(raw?.pageIndex) > 0
      ? Math.trunc(Number(raw?.pageIndex))
      : 1;
  const pageSize =
    Number.isFinite(Number(raw?.pageSize)) && Number(raw?.pageSize) > 0
      ? Math.trunc(Number(raw?.pageSize))
      : 20;

  return {
    items,
    total: Math.max(0, Math.trunc(total)),
    pageIndex,
    pageSize,
  };
}
