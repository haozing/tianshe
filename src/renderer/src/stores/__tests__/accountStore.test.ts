import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '../accountStore';
import { UNBOUND_PROFILE_ID, type Account, type SavedSite, type Tag } from '../../../../types/profile';

const buildAccount = (patch: Partial<Account> = {}): Account => ({
  id: `acc-${Math.random()}`,
  profileId: UNBOUND_PROFILE_ID,
  name: 'demo-account',
  loginUrl: 'https://account.example/login',
  tags: [],
  createdAt: new Date('2026-02-17T00:00:00.000Z'),
  updatedAt: new Date('2026-02-17T00:00:00.000Z'),
  ...patch,
});

const buildSite = (patch: Partial<SavedSite> = {}): SavedSite => ({
  id: `site-${Math.random()}`,
  name: 'Demo Platform',
  url: 'https://platform.example/login',
  usageCount: 0,
  createdAt: new Date('2026-02-17T00:00:00.000Z'),
  ...patch,
});

const buildTag = (patch: Partial<Tag> = {}): Tag => ({
  id: `tag-${Math.random()}`,
  name: 'demo-tag',
  color: '#1d4ed8',
  createdAt: new Date('2026-02-17T00:00:00.000Z'),
  ...patch,
});

const resetStoreState = () => {
  useAccountStore.setState({
    accounts: [],
    savedSites: [],
    tags: [],
    loading: {
      accounts: false,
      savedSites: false,
      tags: false,
      mutation: false,
      login: false,
    },
    errors: {
      accounts: null,
      savedSites: null,
      tags: null,
      mutation: null,
      login: null,
    },
    isLoading: false,
    error: null,
    categoryMode: 'site',
    selectedCategoryId: null,
  });
};

describe('accountStore site category behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
  });

  it('should default to site category mode for account management', () => {
    expect(useAccountStore.getState().categoryMode).toBe('site');
  });

  it('should count valid, unbound, and missing platform categories separately', () => {
    const taobao = buildSite({ id: 'site-taobao', name: '淘宝' });
    const jd = buildSite({ id: 'site-jd', name: '京东' });
    const pdd = buildSite({ id: 'site-pdd', name: '拼多多' });

    useAccountStore.setState({
      savedSites: [taobao, jd, pdd],
      accounts: [
        buildAccount({ id: 'a1', platformId: 'site-taobao' }),
        buildAccount({ id: 'a2', platformId: 'site-taobao' }),
        buildAccount({ id: 'a3', platformId: 'deleted-platform' }),
        buildAccount({ id: 'a4' }),
      ],
    });

    const categories = useAccountStore.getState().getCategoriesBySite();
    const taobaoCategory = categories.find((item) => item.id === 'site:site-taobao');
    const jdCategory = categories.find((item) => item.id === 'site:site-jd');
    const pddCategory = categories.find((item) => item.id === 'site:site-pdd');
    const unboundCategory = categories.find((item) => item.id === 'site:__unbound__');
    const missingCategory = categories.find(
      (item) => item.id === 'site:__missing__:deleted-platform'
    );

    expect(taobaoCategory?.count).toBe(2);
    expect(jdCategory).toBeUndefined();
    expect(pddCategory).toBeUndefined();
    expect(unboundCategory?.count).toBe(1);
    expect(missingCategory?.count).toBe(1);
  });

  it('should filter missing platform bindings by the exact stale platform id', () => {
    useAccountStore.setState({
      savedSites: [buildSite({ id: 'site-taobao', name: '淘宝' })],
      accounts: [
        buildAccount({ id: 'valid', platformId: 'site-taobao' }),
        buildAccount({ id: 'stale-1', platformId: 'deleted-platform' }),
        buildAccount({ id: 'stale-3', platformId: 'deleted-platform-2' }),
        buildAccount({ id: 'stale-2', platformId: 'deleted-platform' }),
        buildAccount({ id: 'no-platform' }),
      ],
      categoryMode: 'site',
      selectedCategoryId: 'site:__missing__:deleted-platform',
    });

    const filtered = useAccountStore.getState().getFilteredAccounts();
    const ids = filtered.map((item) => item.id).sort();

    expect(ids).toEqual(['stale-1', 'stale-2']);
  });

  it('should expose accounts without platform bindings in a dedicated unbound category', () => {
    useAccountStore.setState({
      savedSites: [buildSite({ id: 'site-taobao', name: '淘宝' })],
      accounts: [
        buildAccount({ id: 'valid', platformId: 'site-taobao' }),
        buildAccount({ id: 'stale', platformId: 'deleted-platform' }),
        buildAccount({ id: 'no-platform' }),
      ],
      categoryMode: 'site',
      selectedCategoryId: 'site:__unbound__',
    });

    const filtered = useAccountStore.getState().getFilteredAccounts();
    const ids = filtered.map((item) => item.id).sort();

    expect(ids).toEqual(['no-platform']);
  });

  it('should include only exact platform records in selected site filter', () => {
    useAccountStore.setState({
      savedSites: [buildSite({ id: 'site-taobao', name: '淘宝' })],
      accounts: [
        buildAccount({ id: 'valid-platform', platformId: 'site-taobao' }),
        buildAccount({ id: 'no-platform' }),
        buildAccount({ id: 'stale-fallback', platformId: 'deleted-platform' }),
        buildAccount({ id: 'other-site', platformId: 'site-other' }),
      ],
      categoryMode: 'site',
      selectedCategoryId: 'site:site-taobao',
    });

    const filtered = useAccountStore.getState().getFilteredAccounts();
    const ids = filtered.map((item) => item.id).sort();

    expect(ids).toEqual(['valid-platform']);
  });

  it('should include account-only tags when tags table does not contain them', () => {
    useAccountStore.setState({
      tags: [buildTag({ id: 'tag-known', name: '已登记标签', color: '#0ea5e9' })],
      accounts: [
        buildAccount({ id: 'acc-1', tags: ['已登记标签', '账号内标签'] }),
        buildAccount({ id: 'acc-2', tags: ['账号内标签'] }),
        buildAccount({ id: 'acc-3', tags: [] }),
      ],
      categoryMode: 'tag',
      selectedCategoryId: 'tag:账号内标签',
    });

    const categories = useAccountStore.getState().getCategoriesByTag();
    const accountOnlyTag = categories.find((item) => item.id === 'tag:账号内标签');
    const filtered = useAccountStore.getState().getFilteredAccounts();

    expect(accountOnlyTag).toBeDefined();
    expect(accountOnlyTag?.count).toBe(2);
    expect(filtered.map((item) => item.id).sort()).toEqual(['acc-1', 'acc-2']);
  });
});

describe('accountStore account ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
  });

  it('keeps newest accounts first after loading and creating local accounts', async () => {
    const older = buildAccount({
      id: 'acc-old',
      createdAt: new Date('2026-02-17T00:00:00.000Z'),
      updatedAt: new Date('2026-02-17T00:00:00.000Z'),
    });
    const newer = buildAccount({
      id: 'acc-newer',
      createdAt: new Date('2026-02-18T00:00:00.000Z'),
      updatedAt: new Date('2026-02-18T00:00:00.000Z'),
    });
    const newest = buildAccount({
      id: 'acc-newest',
      createdAt: new Date('2026-02-19T00:00:00.000Z'),
      updatedAt: new Date('2026-02-19T00:00:00.000Z'),
    });

    const mockedWindow = {
      electronAPI: {
        account: {
          listAll: vi.fn().mockResolvedValue({
            success: true,
            data: [older, newer],
          }),
          create: vi.fn().mockResolvedValue({
            success: true,
            data: newest,
          }),
        },
      },
    } as unknown as Window & typeof globalThis;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: mockedWindow,
    });

    await useAccountStore.getState().loadAllAccounts();
    expect(useAccountStore.getState().accounts.map((item) => item.id)).toEqual([
      'acc-newer',
      'acc-old',
    ]);

    await useAccountStore.getState().createAccount({
      profileId: UNBOUND_PROFILE_ID,
      name: '最新账号',
      loginUrl: 'https://example.com/login',
    });
    expect(useAccountStore.getState().accounts.map((item) => item.id)).toEqual([
      'acc-newest',
      'acc-newer',
      'acc-old',
    ]);
  });
});
