import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SavedSite, Tag } from '../../../../../types/profile';
import { SavedSiteFormDialog } from '../SavedSiteFormDialog';
import { TagFormDialog } from '../TagFormDialog';

const accountStoreState = vi.hoisted(() => ({
  savedSites: [] as SavedSite[],
  tags: [] as Tag[],
  accounts: [] as Account[],
  createSavedSite: vi.fn(),
  updateSavedSite: vi.fn(),
  deleteSavedSite: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
}));

vi.mock('../../../stores/accountStore', () => ({
  useAccountStore: () => accountStoreState,
}));

vi.mock('../../../stores/cloudAuthStore', () => ({
  useCloudAuthStore: (selector: (state: { session: { user?: { userId?: number } } }) => unknown) =>
    selector({
      session: {
        user: {
          userId: 101,
        },
      },
    }),
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function buildSite(patch: Partial<SavedSite> = {}): SavedSite {
  return {
    id: 'site-1',
    name: '淘宝',
    url: 'https://login.taobao.com',
    icon: '🌐',
    usageCount: 1,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

function buildTag(patch: Partial<Tag> = {}): Tag {
  return {
    id: 'tag-1',
    name: '主号',
    color: '#2563eb',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

function buildAccount(patch: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    profileId: 'profile-1',
    platformId: 'site-1',
    name: 'seller-main',
    displayName: '运营主账号',
    loginUrl: 'https://login.taobao.com',
    tags: ['主号'],
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

describe('Catalog dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountStoreState.savedSites = [buildSite()];
    accountStoreState.tags = [buildTag()];
    accountStoreState.accounts = [buildAccount()];
    accountStoreState.createSavedSite.mockResolvedValue(buildSite({ id: 'site-2', name: '京东' }));
    accountStoreState.updateSavedSite.mockResolvedValue(buildSite());
    accountStoreState.deleteSavedSite.mockResolvedValue(true);
    accountStoreState.createTag.mockResolvedValue(buildTag({ id: 'tag-2', name: '店铺' }));
    accountStoreState.updateTag.mockResolvedValue(buildTag());
    accountStoreState.deleteTag.mockResolvedValue(true);
  });

  it('creates a saved site from the management dialog', async () => {
    const onDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <SavedSiteFormDialog
        open
        onOpenChange={vi.fn()}
        onClose={vi.fn()}
        onDataChanged={onDataChanged}
      />
    );

    fireEvent.change(screen.getByLabelText('平台名称'), { target: { value: '京东' } });
    fireEvent.change(screen.getByLabelText('默认 URL'), {
      target: { value: 'https://passport.jd.com/new/login.aspx' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加平台' }));

    await waitFor(() => {
      expect(accountStoreState.createSavedSite).toHaveBeenCalledWith({
        name: '京东',
        url: 'https://passport.jd.com/new/login.aspx',
        icon: '🌐',
      });
      expect(onDataChanged).toHaveBeenCalledTimes(1);
    });
  });

  it('creates a tag from the management dialog', async () => {
    const onDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <TagFormDialog open onOpenChange={vi.fn()} onClose={vi.fn()} onDataChanged={onDataChanged} />
    );

    fireEvent.change(screen.getByPlaceholderText('例如：主号、代运营、店铺'), {
      target: { value: '店铺' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加标签' }));

    await waitFor(() => {
      expect(accountStoreState.createTag).toHaveBeenCalledWith({ name: '店铺' });
      expect(onDataChanged).toHaveBeenCalledTimes(1);
    });
  });
});
