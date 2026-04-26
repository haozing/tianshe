import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './account-service';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

describe('AccountService input normalization', () => {
  it('normalizes trimmed account fields and de-duplicates tags on create', async () => {
    let bindings: unknown[] = [];
    const conn = {
      prepare: vi.fn(async (sql: string) => {
        const hasExistingBinding =
          sql.includes('FROM browser_profiles') || sql.includes('FROM saved_sites');
        return {
          bind: vi.fn((values: unknown[]) => {
            bindings = values;
          }),
          run: vi.fn().mockResolvedValue(undefined),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => ['id'],
            getRows: () => (hasExistingBinding ? [['bound-record']] : []),
          }),
          destroySync: vi.fn(),
        };
      }),
    };
    const service = new AccountService(conn as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'acc-created',
      profileId: 'profile-1',
      platformId: 'platform-1',
      displayName: '运营主号',
      name: '登录账号',
      shopId: '88',
      shopName: '店铺A',
      hasPassword: false,
      loginUrl: 'https://example.com/login',
      tags: ['主号', '备用'],
      notes: '备注',
      createdAt: new Date('2026-04-10T00:00:00.000Z'),
      updatedAt: new Date('2026-04-10T00:00:00.000Z'),
      syncPermission: 'mine/edit',
    } as never);

    await service.create({
      profileId: ' profile-1 ',
      platformId: ' platform-1 ',
      displayName: '  运营主号  ',
      name: '  登录账号  ',
      shopId: ' 88 ',
      shopName: ' 店铺A ',
      password: '',
      loginUrl: ' https://example.com/login ',
      tags: [' 主号 ', '备用', '', '主号'],
      notes: ' 备注 ',
    });

    expect(bindings[1]).toBe('profile-1');
    expect(bindings[2]).toBe('platform-1');
    expect(bindings[3]).toBe('运营主号');
    expect(bindings[4]).toBe('登录账号');
    expect(bindings[5]).toBe('88');
    expect(bindings[6]).toBe('店铺A');
    expect(bindings[8]).toBe('https://example.com/login');
    expect(bindings[9]).toBe(JSON.stringify(['主号', '备用']));
    expect(bindings[10]).toBe('备注');
  });

  it('rejects partial shop binding updates that would leave dirty account state', async () => {
    const conn = {
      prepare: vi.fn(),
    };
    const service = new AccountService(conn as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      id: 'acc-1',
      profileId: 'profile-1',
      platformId: 'platform-1',
      displayName: '运营主号',
      name: '登录账号',
      shopId: '88',
      shopName: '店铺A',
      hasPassword: false,
      loginUrl: 'https://example.com/login',
      tags: ['主号'],
      createdAt: new Date('2026-04-10T00:00:00.000Z'),
      updatedAt: new Date('2026-04-10T00:00:00.000Z'),
      syncPermission: 'mine/edit',
    } as never);

    await expect(
      service.update('acc-1', {
        shopId: null,
      })
    ).rejects.toThrow('店铺ID和店铺名称必须同时提供或同时为空');
    expect(conn.prepare).not.toHaveBeenCalled();
  });
});
