import { describe, it, expect } from 'vitest';
import { buildPluginMenuTree } from '../plugin-menu-tree';
import type { JSPluginInfo } from '../../../../../types/js-plugin';

const makePlugin = (overrides: Partial<JSPluginInfo>): JSPluginInfo => ({
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  author: 'Test Author',
  installedAt: 0,
  path: '/path/to/plugin',
  ...overrides,
});

describe('buildPluginMenuTree()', () => {
  it('should sort level1/level2 and plugins by activityBarViewOrder', () => {
    const plugins: JSPluginInfo[] = [
      makePlugin({
        id: 'root',
        name: 'Root',
        category: '电商',
        activityBarViewOrder: 90,
      }),
      makePlugin({
        id: 'tbB',
        name: 'B',
        category: '电商/淘宝',
        activityBarViewOrder: 100,
      }),
      makePlugin({
        id: 'tbA',
        name: 'Alpha',
        category: '电商/淘宝',
        activityBarViewOrder: 100,
      }),
      makePlugin({
        id: 'tbZ',
        name: 'Z',
        category: '电商/淘宝',
        activityBarViewOrder: undefined,
      }),
      makePlugin({
        id: 'a1688',
        name: '1688Plugin',
        category: '电商/1688',
        activityBarViewOrder: 200,
      }),
      makePlugin({
        id: 'tool',
        name: 'Tool',
        category: '工具',
        activityBarViewOrder: 150,
      }),
      makePlugin({
        id: 'uncat',
        name: 'Uncat',
        category: undefined,
        activityBarViewOrder: 50,
      }),
    ];

    const tree = buildPluginMenuTree(plugins);

    expect(tree.level1Order).toEqual(['电商', '工具', '未分类']);
    expect(tree.level2Order.get('电商')).toEqual(['', '淘宝', '1688']);

    const taobao = tree.byLevel1.get('电商')?.get('淘宝') ?? [];
    expect(taobao.map((p) => p.id)).toEqual(['tbA', 'tbB', 'tbZ']);

    expect(tree.flatPlugins.map((p) => p.id)).toEqual([
      'root',
      'tbA',
      'tbB',
      'tbZ',
      'a1688',
      'tool',
      'uncat',
    ]);
  });

  it('should fallback to name sort when no order is provided', () => {
    const plugins: JSPluginInfo[] = [
      makePlugin({ id: 'b1', name: 'b', category: 'B' }),
      makePlugin({ id: 'a1', name: 'a', category: 'A' }),
      makePlugin({ id: 'b2', name: 'A2', category: 'B' }),
    ];

    const tree = buildPluginMenuTree(plugins);

    expect(tree.level1Order).toEqual(['A', 'B']);
    expect((tree.byLevel1.get('B')?.get('') ?? []).map((p) => p.id)).toEqual(['b2', 'b1']);
  });
});
