import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerTagHandlers } from './tag-ipc-handler';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe('registerTagHandlers', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const tagService = {
    create: vi.fn(),
    get: vi.fn(),
    getByName: vi.fn(),
    listAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  };

  const accountService = {
    runInTransaction: vi.fn(),
    renameTagAcrossAccounts: vi.fn(),
    removeTagFromAccounts: vi.fn(),
  };
  const onOwnedBundleChanged = vi.fn().mockResolvedValue(undefined);

  const getHandler = (channel: string) => {
    const handler = registeredHandlers.get(channel);
    if (!handler) {
      throw new Error(`Handler not found: ${channel}`);
    }
    return handler;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    (ipcMain.handle as Mock).mockImplementation((channel: string, fn: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, fn as (...args: unknown[]) => Promise<unknown>);
    });

    accountService.runInTransaction.mockImplementation(async (work: () => Promise<unknown>) => work());

    registerTagHandlers(tagService as never, accountService as never, {
      onOwnedBundleChanged,
    });
  });

  it('renames account tag references inside a transaction when tag name changes', async () => {
    tagService.get.mockResolvedValue({ id: 'tag-1', name: '旧标签' });
    tagService.update.mockResolvedValue({ id: 'tag-1', name: '新标签' });

    const updateHandler = getHandler('tag:update');
    const result = (await updateHandler(null, 'tag-1', { name: '新标签' })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(accountService.runInTransaction).toHaveBeenCalledTimes(1);
    expect(accountService.renameTagAcrossAccounts).toHaveBeenCalledWith('旧标签', '新标签', {
      withinTransaction: true,
    });
    expect(tagService.update).toHaveBeenCalledWith('tag-1', { name: '新标签' });
    expect(onOwnedBundleChanged).toHaveBeenCalledTimes(1);
  });

  it('skips account rewrites when only tag metadata changes', async () => {
    tagService.get.mockResolvedValue({ id: 'tag-1', name: '旧标签' });
    tagService.update.mockResolvedValue({ id: 'tag-1', name: '旧标签', color: '#fff' });

    const updateHandler = getHandler('tag:update');
    const result = (await updateHandler(null, 'tag-1', { color: '#fff' })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(accountService.runInTransaction).not.toHaveBeenCalled();
    expect(accountService.renameTagAcrossAccounts).not.toHaveBeenCalled();
    expect(tagService.update).toHaveBeenCalledWith('tag-1', { color: '#fff' });
    expect(onOwnedBundleChanged).toHaveBeenCalledTimes(1);
  });

  it('removes tag references from accounts before deleting the tag', async () => {
    tagService.get.mockResolvedValue({ id: 'tag-1', name: '待删除' });
    tagService.delete.mockResolvedValue(undefined);

    const deleteHandler = getHandler('tag:delete');
    const result = (await deleteHandler(null, 'tag-1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(accountService.runInTransaction).toHaveBeenCalledTimes(1);
    expect(accountService.removeTagFromAccounts).toHaveBeenCalledWith('待删除', {
      withinTransaction: true,
    });
    expect(tagService.delete).toHaveBeenCalledWith('tag-1');
    expect(onOwnedBundleChanged).toHaveBeenCalledTimes(1);
  });
});
