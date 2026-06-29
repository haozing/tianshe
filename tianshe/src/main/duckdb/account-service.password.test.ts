import { describe, expect, it, vi } from 'vitest';
import { safeStorage } from 'electron';
import { AccountService } from './account-service';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

describe('AccountService password handling', () => {
  it('rejects storing non-empty passwords when safeStorage is unavailable', () => {
    const service = new AccountService({} as never);
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    expect(() => (service as any).encryptPassword('  pass with spaces  ')).toThrow(
      '当前系统安全存储不可用'
    );
  });

  it('still allows empty passwords when safeStorage is unavailable', () => {
    const service = new AccountService({} as never);
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    const encrypted = (service as any).encryptPassword('');

    expect(encrypted).toBeNull();
  });

  it('keeps the read model sanitized while preserving hasPassword metadata', () => {
    const service = new AccountService({} as never);

    const account = (service as any).mapRowToAccount({
      id: 'acc-1',
      profile_id: 'profile-1',
      platform_id: 'platform-1',
      name: 'demo-account',
      password: 'legacy-plain-secret',
      login_url: 'https://example.com/login',
      tags: JSON.stringify(['主号']),
      notes: 'note',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:00.000Z',
      sync_managed: false,
    });

    expect(account.password).toBeUndefined();
    expect(account.hasPassword).toBe(true);
    expect(account.syncPermission).toBe('mine/edit');
  });

  it('reveals local secrets but blocks shared account secrets', async () => {
    const service = new AccountService({} as never);
    vi.spyOn(service, 'getWithSecret')
      .mockResolvedValueOnce({
        id: 'acc-local',
        profileId: 'profile-1',
        name: 'local',
        hasPassword: true,
        loginUrl: 'https://example.com/login',
        tags: [],
        createdAt: new Date('2026-04-09T00:00:00.000Z'),
        updatedAt: new Date('2026-04-09T00:00:00.000Z'),
        syncPermission: 'mine/edit',
        password: 'local-secret',
      } as never)
      .mockResolvedValueOnce({
        id: 'acc-shared',
        profileId: 'profile-1',
        name: 'shared',
        hasPassword: true,
        loginUrl: 'https://example.com/login',
        tags: [],
        createdAt: new Date('2026-04-09T00:00:00.000Z'),
        updatedAt: new Date('2026-04-09T00:00:00.000Z'),
        syncPermission: 'shared/view_use',
        password: 'shared-secret',
      } as never);

    await expect(service.revealSecret('acc-local')).resolves.toBe('local-secret');
    await expect(service.revealSecret('acc-shared')).rejects.toThrow('共享账号不允许查看密码');
  });
  it('blocks update and delete for shared mirror accounts unless internal sync explicitly allows it', async () => {
    const prepare = vi.fn(async () => ({
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue(undefined),
      destroySync: vi.fn(),
    }));
    const service = new AccountService({
      prepare,
    } as never);

    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'acc-shared',
      profileId: 'profile-1',
      name: 'shared',
      hasPassword: false,
      loginUrl: 'https://example.com/login',
      tags: [],
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
      syncPermission: 'shared/view_use',
    } as never);

    await expect(service.update('acc-shared', {})).rejects.toThrow('共享账号为只读镜像');
    await expect(service.delete('acc-shared')).rejects.toThrow('共享账号为只读镜像');

    await expect(
      service.update('acc-shared', {}, { allowSharedMutation: true })
    ).resolves.toMatchObject({
      id: 'acc-shared',
    });
    await expect(
      service.delete('acc-shared', { allowSharedMutation: true })
    ).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
