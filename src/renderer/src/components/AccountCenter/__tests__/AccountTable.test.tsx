import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Account, SavedSite } from '../../../../../types/profile';
import { AccountTable } from '../AccountTable';

function buildAccount(patch: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    profileId: 'profile-1',
    platformId: 'site-1',
    displayName: '运营主账号',
    name: '主账号',
    hasPassword: true,
    loginUrl: 'https://example.com/login',
    tags: ['主号', '电商'],
    notes: '测试备注',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    syncPermission: 'mine/edit',
    ...patch,
  };
}

function buildSite(patch: Partial<SavedSite> = {}): SavedSite {
  return {
    id: 'site-1',
    name: '淘宝',
    url: 'https://login.taobao.com',
    usageCount: 1,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

describe('AccountTable', () => {
  it('renders launch action and exposes the consolidated actions menu', () => {
    const onOpenBrowser = vi.fn();
    const onTogglePasswordVisible = vi.fn();
    const onEditAccount = vi.fn();
    const onDeleteAccount = vi.fn();

    render(
      <AccountTable
        accounts={[buildAccount()]}
        profileNameById={new Map([['profile-1', '默认环境']])}
        platformById={new Map([[buildSite().id, buildSite()]])}
        revealedPasswords={{}}
        visiblePasswords={{}}
        onOpenBrowser={onOpenBrowser}
        onTogglePasswordVisible={onTogglePasswordVisible}
        onEditAccount={onEditAccount}
        onDeleteAccount={onDeleteAccount}
      />
    );

    expect(screen.getByText('序号')).toBeInTheDocument();
    expect(screen.getByText('运营主账号')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启动' })).toBeInTheDocument();
    expect(screen.getByText('密码：••••••')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    fireEvent.click(screen.getByText('显示密码'));
    expect(onTogglePasswordVisible).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('编辑账号'));
    expect(onEditAccount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('删除账号'));
    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('shows the revealed password inline when toggled on', () => {
    render(
      <AccountTable
        accounts={[buildAccount()]}
        profileNameById={new Map([['profile-1', '默认环境']])}
        platformById={new Map([[buildSite().id, buildSite()]])}
        revealedPasswords={{ 'account-1': 'secret-123' }}
        visiblePasswords={{ 'account-1': true }}
        onOpenBrowser={vi.fn()}
        onTogglePasswordVisible={vi.fn()}
        onEditAccount={vi.fn()}
        onDeleteAccount={vi.fn()}
      />
    );

    expect(screen.getByText('密码：secret-123')).toBeInTheDocument();
  });
});
