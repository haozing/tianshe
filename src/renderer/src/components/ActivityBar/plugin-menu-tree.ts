import type { JSPluginInfo } from '../../../../types/js-plugin';

export type PluginCategoryPath = {
  level1: string;
  level2?: string;
};

export function parsePluginCategoryPath(category?: string): PluginCategoryPath {
  const raw = category?.trim();
  if (!raw) return { level1: '未分类' };

  // 支持 “一级/二级” 或 “一级 > 二级” 等常见分隔符（最多取两级）
  const parts = raw
    .split(/\/|\\|>|::/g)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return { level1: '未分类' };
  if (parts.length === 1) return { level1: parts[0] };
  return { level1: parts[0], level2: parts[1] };
}

export type PluginMenuTree = {
  level1Order: string[];
  level2Order: Map<string, string[]>;
  byLevel1: Map<string, Map<string, JSPluginInfo[]>>;
  flatPlugins: JSPluginInfo[];
};

export function buildPluginMenuTree(plugins: JSPluginInfo[]): PluginMenuTree {
  const byLevel1 = new Map<string, Map<string, JSPluginInfo[]>>();
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

  const getPluginOrder = (plugin: JSPluginInfo): number => {
    const order = plugin.activityBarViewOrder;
    return Number.isFinite(order) ? (order as number) : Number.POSITIVE_INFINITY;
  };

  const comparePlugins = (a: JSPluginInfo, b: JSPluginInfo): number => {
    const orderA = getPluginOrder(a);
    const orderB = getPluginOrder(b);
    if (orderA !== orderB) return orderA - orderB;

    const nameCmp = collator.compare(a.name, b.name);
    if (nameCmp !== 0) return nameCmp;

    return collator.compare(a.id, b.id);
  };

  for (const plugin of plugins) {
    const { level1, level2 } = parsePluginCategoryPath(plugin.category);
    const l2 = level2 ?? '';

    let level2Map = byLevel1.get(level1);
    if (!level2Map) {
      level2Map = new Map<string, JSPluginInfo[]>();
      byLevel1.set(level1, level2Map);
    }

    if (!level2Map.has(l2)) {
      level2Map.set(l2, []);
    }

    level2Map.get(l2)?.push(plugin);
  }

  // ✅ 先对每个桶里的插件排序（order -> name）
  for (const level2Map of byLevel1.values()) {
    for (const bucket of level2Map.values()) {
      bucket.sort(comparePlugins);
    }
  }

  // ✅ 再排序分类（按该分类下最小的插件 order；无 order 的排后；同值按名称）
  const getGroupOrder = (groupPlugins: JSPluginInfo[]): number => {
    let min = Number.POSITIVE_INFINITY;
    for (const plugin of groupPlugins) {
      const order = getPluginOrder(plugin);
      if (order < min) min = order;
    }
    return min;
  };

  const getLevel1MinOrder = (level1: string): number => {
    const level2Map = byLevel1.get(level1);
    if (!level2Map) return Number.POSITIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const bucket of level2Map.values()) {
      const bucketMin = getGroupOrder(bucket);
      if (bucketMin < min) min = bucketMin;
    }
    return min;
  };

  const level1Order = Array.from(byLevel1.keys()).sort((a, b) => {
    if (a === b) return 0;
    if (a === '未分类') return 1;
    if (b === '未分类') return -1;

    const orderA = getLevel1MinOrder(a);
    const orderB = getLevel1MinOrder(b);
    if (orderA !== orderB) return orderA - orderB;

    return collator.compare(a, b);
  });

  const level2Order = new Map<string, string[]>();
  for (const level1 of level1Order) {
    const level2Map = byLevel1.get(level1);
    if (!level2Map) {
      level2Order.set(level1, []);
      continue;
    }

    const keys = Array.from(level2Map.keys());
    keys.sort((a, b) => {
      if (a === b) return 0;
      // 空子分类（仅一级分类）固定排在最前面
      if (a === '') return -1;
      if (b === '') return 1;

      const pluginsA = level2Map.get(a) ?? [];
      const pluginsB = level2Map.get(b) ?? [];
      const orderA = getGroupOrder(pluginsA);
      const orderB = getGroupOrder(pluginsB);
      if (orderA !== orderB) return orderA - orderB;

      return collator.compare(a, b);
    });

    level2Order.set(level1, keys);
  }

  const flatPlugins: JSPluginInfo[] = [];
  for (const level1 of level1Order) {
    const level2Map = byLevel1.get(level1);
    if (!level2Map) continue;
    const order = level2Order.get(level1) ?? [];
    for (const level2 of order) {
      const list = level2Map.get(level2) ?? [];
      flatPlugins.push(...list);
    }
  }

  return {
    level1Order,
    level2Order,
    byLevel1,
    flatPlugins,
  };
}
