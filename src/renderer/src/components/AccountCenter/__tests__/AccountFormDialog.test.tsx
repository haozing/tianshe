import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserProfile, SavedSite } from '../../../../../types/profile';
import { getDefaultFingerprint } from '../../../../../constants/fingerprint-defaults';
import { AccountFormDialog } from '../AccountFormDialog';
import type { AccountFormState } from '../accountManagementShared';

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

function buildProfile(patch: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: 'profile-1',
    name: '默认环境',
    groupId: null,
    engine: 'extension',
    partition: 'persist:profile-1',
    proxy: null,
    fingerprint: getDefaultFingerprint(),
    notes: null,
    tags: [],
    color: null,
    status: 'idle',
    lastError: null,
    lastActiveAt: null,
    totalUses: 0,
    quota: 1,
    idleTimeoutMs: 300000,
    lockTimeoutMs: 300000,
    isSystem: false,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

function buildAccountForm(patch: Partial<AccountFormState> = {}): AccountFormState {
  return {
    platformId: 'site-1',
    displayName: '运营主账号',
    accountName: 'seller-main',
    password: '',
    tabUrl: 'https://login.taobao.com',
    profileId: 'profile-1',
    profileBindingMode: 'select',
    autoProfileName: '',
    notes: '',
    tagsText: '主号,电商',
    ...patch,
  };
}

function renderDialog(
  patch: Partial<AccountFormState> = {},
  overrides: Partial<ComponentProps<typeof AccountFormDialog>> = {}
) {
  const site = buildSite();
  const profile = buildProfile();

  const props: ComponentProps<typeof AccountFormDialog> = {
    open: true,
    editingAccountId: null,
    accountForm: buildAccountForm(patch),
    submittingAccount: false,
    savedSites: [site],
    profiles: [profile],
    platformById: new Map([[site.id, site]]),
    profileNameById: new Map([[profile.id, profile.name]]),
    recommendedProfileName: profile.name,
    recommendedProfileSource: 'available-profile',
    totalProfileCount: 1,
    suggestedAutoProfileName: '淘宝-运营主账号',
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    onOpenPlatformDialog: vi.fn(),
    onPlatformChange: vi.fn(),
    onProfileBindingModeChange: vi.fn(),
    onChangeForm: vi.fn(),
    onPasswordChange: vi.fn(),
    ...overrides,
  };

  return {
    props,
    ...render(<AccountFormDialog {...props} />),
  };
}

describe('AccountFormDialog', () => {
  it('renders platform summary and exposes profile binding mode actions', () => {
    const { props } = renderDialog();

    expect(screen.getByText('平台')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://login.taobao.com')).toBeInTheDocument();
    expect(
      screen.getByText('已默认选中可复用环境「默认环境」，该环境下目前没有「淘宝」平台账号。')
    ).toBeInTheDocument();
    expect(screen.getByText('当前账号环境：默认环境')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^复用已有环境/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^自动创建环境/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^自动创建环境/ }));
    expect(props.onProfileBindingModeChange).toHaveBeenCalledWith('auto-create');
  });

  it('shows auto-create fields when the dialog is in auto-create mode', () => {
    renderDialog(
      {
        profileBindingMode: 'auto-create',
        profileId: '',
        autoProfileName: '自建环境-1',
      },
      {
        recommendedProfileName: null,
        recommendedProfileSource: 'auto-create',
      }
    );

    expect(
      screen.getByText('保存账号时自动创建一个 Extension 引擎环境，并立即完成绑定。')
    ).toBeInTheDocument();
    expect(screen.getByText('自动创建环境名称')).toBeInTheDocument();
    expect(screen.getByDisplayValue('自建环境-1')).toBeInTheDocument();
    expect(screen.queryByText('选择浏览器环境')).not.toBeInTheDocument();
  });

  it('explains why auto-create is required when all existing profiles already bind the platform', () => {
    renderDialog(
      {
        profileBindingMode: 'auto-create',
        profileId: '',
      },
      {
        profiles: [],
        recommendedProfileName: null,
        recommendedProfileSource: 'auto-create',
        totalProfileCount: 2,
      }
    );

    expect(
      screen.getByText('当前所有现有环境都已绑定「淘宝」平台账号，系统已自动切换为创建新环境。')
    ).toBeInTheDocument();
    expect(screen.getByText('自动创建环境名称')).toBeInTheDocument();
  });
});
