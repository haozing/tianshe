export interface GroupableStore {
  id: string;
  group: string;
}

export function groupStoresByName<T extends GroupableStore>(stores: readonly T[]) {
  const byName = new Map<string, T[]>();
  stores.forEach((store) => {
    const name = store.group.trim() || "未分组";
    const group = byName.get(name);
    if (group) group.push(store);
    else byName.set(name, [store]);
  });
  return [...byName.entries()]
    .map(([name, items]) => ({ name, stores: items }))
    .sort((left, right) => {
      if (left.name === "未分组") return -1;
      if (right.name === "未分组") return 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
}

export function toggleStoreIds(selectedIds: ReadonlySet<string>, ids: readonly string[]) {
  const next = new Set(selectedIds);
  const uniqueIds = [...new Set(ids)];
  const allSelected = uniqueIds.length > 0 && uniqueIds.every((id) => next.has(id));
  uniqueIds.forEach((id) => {
    if (allSelected) next.delete(id);
    else next.add(id);
  });
  return next;
}
