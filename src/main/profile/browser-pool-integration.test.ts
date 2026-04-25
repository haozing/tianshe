import { describe, it, expect, vi } from 'vitest';
import { createBrowserDestroyer } from './browser-pool-integration';

describe('createBrowserDestroyer', () => {
  it('应始终调用 closeInternal，并删除 pool:* 视图', async () => {
    const viewManager = {
      deleteView: vi.fn().mockResolvedValue(undefined),
    } as any;

    const destroyer = createBrowserDestroyer(viewManager);
    const browser = {
      closeInternal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await destroyer(browser, 'pool:test-session:123');

    expect(browser.closeInternal).toHaveBeenCalledTimes(1);
    expect(viewManager.deleteView).toHaveBeenCalledTimes(1);
    expect(viewManager.deleteView).toHaveBeenCalledWith('pool:test-session:123');
  });

  it('非 pool:* 视图不应调用 deleteView', async () => {
    const viewManager = {
      deleteView: vi.fn().mockResolvedValue(undefined),
    } as any;

    const destroyer = createBrowserDestroyer(viewManager);
    const browser = {
      closeInternal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await destroyer(browser, 'view-regular-1');

    expect(browser.closeInternal).toHaveBeenCalledTimes(1);
    expect(viewManager.deleteView).not.toHaveBeenCalled();
  });

  it('deleteView 抛错应被忽略（不影响销毁）', async () => {
    const viewManager = {
      deleteView: vi.fn().mockRejectedValue(new Error('boom')),
    } as any;

    const destroyer = createBrowserDestroyer(viewManager);
    const browser = {
      closeInternal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(destroyer(browser, 'pool:test-session:123')).resolves.not.toThrow();
    expect(browser.closeInternal).toHaveBeenCalledTimes(1);
    expect(viewManager.deleteView).toHaveBeenCalledTimes(1);
  });
});
