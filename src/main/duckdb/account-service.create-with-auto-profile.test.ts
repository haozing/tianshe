import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './account-service';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

describe('AccountService.createWithAutoProfile', () => {
  it('commits after creating profile and account in one transaction', async () => {
    const conn = {
      run: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AccountService(conn as never);
    const profileService = {
      create: vi.fn().mockResolvedValue({ id: 'profile-1', name: 'Profile 1' }),
    };
    const createSpy = vi.spyOn(service, 'create').mockResolvedValue({
      id: 'account-1',
      profileId: 'profile-1',
      name: 'Account 1',
      loginUrl: 'https://example.com/login',
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await service.createWithAutoProfile(profileService as never, {
      profile: { name: 'Profile 1' },
      account: {
        name: 'Account 1',
        loginUrl: 'https://example.com/login',
      },
    } as never);

    expect(conn.run).toHaveBeenNthCalledWith(1, 'BEGIN TRANSACTION');
    expect(conn.run).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Account 1',
        loginUrl: 'https://example.com/login',
        profileId: 'profile-1',
      })
    );
    expect(result.profile.id).toBe('profile-1');
    expect(result.account.id).toBe('account-1');
  });

  it('rolls back when account creation fails after profile creation', async () => {
    const conn = {
      run: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AccountService(conn as never);
    const profileService = {
      create: vi.fn().mockResolvedValue({ id: 'profile-orphan', name: 'Profile Orphan' }),
    };
    vi.spyOn(service, 'create').mockRejectedValue(new Error('create account failed'));

    await expect(
      service.createWithAutoProfile(profileService as never, {
        profile: { name: 'Profile Orphan' },
        account: {
          name: 'Broken Account',
          loginUrl: 'https://example.com/login',
        },
      } as never)
    ).rejects.toThrow('create account failed');

    expect(conn.run).toHaveBeenNthCalledWith(1, 'BEGIN TRANSACTION');
    expect(conn.run).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(conn.run).not.toHaveBeenCalledWith('COMMIT');
  });
});
