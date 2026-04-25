/**
 * Tag IPC Handler
 * 处理标签相关的 IPC 请求
 */

import type { TagService } from '../duckdb/tag-service';
import type { AccountService } from '../duckdb/account-service';
import type { CreateTagParams, UpdateTagParams } from '../../types/profile';
import { createIpcHandler, createIpcVoidHandler } from './utils';

interface RegisterTagHandlersOptions {
  onOwnedBundleChanged?: () => Promise<void> | void;
}

/**
 * 注册标签相关的 IPC 处理器
 */
export function registerTagHandlers(
  tagService: TagService,
  accountService: AccountService,
  options: RegisterTagHandlersOptions = {}
) {
  const notifyOwnedBundleChanged = async () => {
    if (!options.onOwnedBundleChanged) return;
    try {
      await options.onOwnedBundleChanged();
    } catch (error) {
      console.warn('[TagIPC] Failed to mark owned account bundle dirty:', error);
    }
  };

  // =====================================================
  // Tag CRUD
  // =====================================================

  createIpcHandler(
    'tag:create',
    async (params: CreateTagParams) => {
      const created = await tagService.create(params);
      await notifyOwnedBundleChanged();
      return created;
    },
    '创建标签失败'
  );

  createIpcHandler('tag:get', (id: string) => tagService.get(id), '获取标签失败');

  createIpcHandler('tag:get-by-name', (name: string) => tagService.getByName(name), '获取标签失败');

  createIpcHandler('tag:list', () => tagService.listAll(), '获取标签列表失败');

  createIpcHandler(
    'tag:update',
    async (id: string, params: UpdateTagParams) => {
      const existingTag = await tagService.get(id);
      const nextName = String(params.name ?? '').trim();
      const currentName = String(existingTag?.name ?? '').trim();
      const shouldRenameAccounts =
        Boolean(existingTag) &&
        typeof params.name === 'string' &&
        nextName.length > 0 &&
        currentName.length > 0 &&
        nextName !== currentName;

      if (!shouldRenameAccounts) {
        const updated = await tagService.update(id, params);
        await notifyOwnedBundleChanged();
        return updated;
      }

      const updated = await accountService.runInTransaction(async () => {
        await accountService.renameTagAcrossAccounts(currentName, nextName, {
          withinTransaction: true,
        });
        return tagService.update(id, params);
      });
      await notifyOwnedBundleChanged();
      return updated;
    },
    '更新标签失败'
  );

  createIpcVoidHandler(
    'tag:delete',
    async (id: string) => {
      const existingTag = await tagService.get(id);
      if (!existingTag) {
        await tagService.delete(id);
        return;
      }

      await accountService.runInTransaction(async () => {
        await accountService.removeTagFromAccounts(existingTag.name, {
          withinTransaction: true,
        });
        await tagService.delete(id);
      });
      await notifyOwnedBundleChanged();
    },
    '删除标签失败'
  );

  createIpcHandler('tag:exists', (name: string) => tagService.exists(name), '检查标签失败');

  console.log('[TagIPC] Tag handlers registered');
}
