/**
 * Profile IPC Handler
 * 处理前端浏览器配置相关的 IPC 请求
 *
 * v2 架构：Profile-First + BrowserPoolManager
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';
import type { ProfileService } from '../duckdb/profile-service';
import type { ProfileGroupService } from '../duckdb/profile-group-service';
import type { AccountService } from '../duckdb/account-service';
import type {
  CreateProfileParams,
  UpdateProfileParams,
  ProfileListParams,
  CreateGroupParams,
  UpdateGroupParams,
  PoolBrowserInfo,
  ProfileStatus,
  AutomationEngine,
} from '../../types/profile';
import {
  type BrowserPoolConfig,
  DEFAULT_BROWSER_POOL_CONFIG,
  BROWSER_POOL_PRESETS,
  BROWSER_POOL_LIMITS,
} from '../../constants/browser-pool';
import {
  getBrowserPoolManager,
  hasBrowserInstance,
  showBrowserViewInPopup,
  type BrowserHandle,
} from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../core/browser-pool/profile-live-session-lease';
import { fingerprintManager } from '../../core/stealth';
import { createIpcHandler, handleIPCError, IpcError } from './utils';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import type { WindowManager } from '../window-manager';

// 用于持久化浏览器池配置的 electron-store 实例
const poolConfigStore = new Store<{ browserPoolConfig?: Partial<BrowserPoolConfig> }>({
  name: 'browser-pool-config',
});

function isPersistentBrowserClosedError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'Unknown error');
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('TargetClosedError') ||
    message.includes('browser context has been closed') ||
    message.includes('Extension browser has been closed') ||
    message.includes('Extension relay has been stopped')
  );
}

/**
 * 注册 Profile 相关的 IPC 处理器
 *
 * v2 重构：浏览器操作通过 BrowserPoolManager，不再需要 viewManager/windowManager
 */
export function registerProfileHandlers(
  profileService: ProfileService,
  groupService: ProfileGroupService,
  _accountService: AccountService,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager
) {
  const launchedPoolHandles = new Map<string, BrowserHandle>();

  // =====================================================
  // Profile CRUD (使用工厂函数减少重复代码)
  // =====================================================

  createIpcHandler(
    'profile:create',
    (params: CreateProfileParams) => profileService.create(params),
    '创建浏览器配置失败'
  );

  createIpcHandler('profile:get', (id: string) => profileService.get(id), '获取浏览器配置失败');

  createIpcHandler(
    'profile:list',
    (params?: ProfileListParams) => profileService.list(params),
    '获取浏览器配置列表失败'
  );

  createIpcHandler(
    'profile:update',
    async (id: string, params: UpdateProfileParams) => {
      const updated = await profileService.update(id, params);

      const runtimeChanged =
        params.fingerprint !== undefined ||
        params.engine !== undefined ||
        params.proxy !== undefined ||
        params.quota !== undefined ||
        params.idleTimeoutMs !== undefined ||
        params.lockTimeoutMs !== undefined;

      if (runtimeChanged) {
        try {
          fingerprintManager.clearCache(updated.id);
        } catch {
          // ignore
        }

        try {
          fingerprintManager.clearCache(updated.partition);
        } catch {
          // ignore
        }

        try {
          const poolManager = getBrowserPoolManager();
          const destroyedCount = await poolManager.destroyProfileBrowsers(id);
          if (destroyedCount > 0) {
            console.log(
              `[IPC] profile:update: runtime fields changed, destroyed ${destroyedCount} browser(s) for profile: ${id}`
            );
          }
        } catch {
          // ignore
        }

      }

      return updated;
    },
    '更新浏览器配置失败'
  );

  // 删除 Profile（保留账号数据，仅解绑账号环境并销毁浏览器实例）
  // v2 架构：使用事务确保数据库操作的原子性
  ipcMain.handle('profile:delete', async (_, id: string) => {
    try {
      // 1. 先销毁该 Profile 的所有浏览器实例（内存操作，不参与事务）
      try {
        const poolManager = getBrowserPoolManager();
        const destroyedCount = await poolManager.destroyProfileBrowsers(id);
        if (destroyedCount > 0) {
          console.log(
            `[IPC] profile:delete: Destroyed ${destroyedCount} browser(s) for profile: ${id}`
          );
        }
      } catch {
        // 池可能未初始化，忽略
      }

      // 2. 事务性删除 Profile（并将关联账号置为未绑定）
      // deleteWithCascade 使用数据库事务，确保解绑和删除原子性
      await profileService.deleteWithCascade(id);
      return { success: true };
    } catch (error) {
      console.error('[IPC] profile:delete error:', error);
      return handleIPCError(error, '删除浏览器配置失败');
    }
  });

  // =====================================================
  // Profile 状态管理
  // =====================================================

  // 更新状态
  ipcMain.handle(
    'profile:update-status',
    async (_, id: string, status: ProfileStatus, error?: string) => {
      try {
        await profileService.updateStatus(id, status, error);
        return { success: true };
      } catch (err) {
        console.error('[IPC] profile:update-status error:', err);
        return handleIPCError(err, '更新状态失败');
      }
    }
  );

  createIpcHandler(
    'profile:is-available',
    (id: string) => profileService.isAvailable(id),
    '检查可用性失败'
  );

  // =====================================================
  // Profile 统计
  // =====================================================

  createIpcHandler('profile:get-stats', () => profileService.getStats(), '获取统计信息失败');

  // =====================================================
  // Profile Group CRUD (使用工厂函数减少重复代码)
  // =====================================================

  createIpcHandler(
    'profile-group:create',
    (params: CreateGroupParams) => groupService.create(params),
    '创建分组失败'
  );

  createIpcHandler('profile-group:get', (id: string) => groupService.get(id), '获取分组失败');

  createIpcHandler('profile-group:list', () => groupService.list(), '获取分组列表失败');

  createIpcHandler('profile-group:list-tree', () => groupService.listTree(), '获取分组树失败');

  createIpcHandler(
    'profile-group:update',
    (id: string, params: UpdateGroupParams) => groupService.update(id, params),
    '更新分组失败'
  );

  // 删除分组（保留原始实现，因为有 recursive 参数）
  ipcMain.handle('profile-group:delete', async (_, id: string, recursive?: boolean) => {
    try {
      await groupService.delete(id, { recursive });
      return { success: true };
    } catch (error) {
      console.error('[IPC] profile-group:delete error:', error);
      return handleIPCError(error, '删除分组失败');
    }
  });

  // =====================================================
  // 浏览器关闭 (v2 重构: 统一使用浏览器池)
  // =====================================================

  /**
   * 关闭浏览器
   *
   * v2 重构：通过浏览器池释放浏览器
   * - browserId 和 viewId 在池化模式下是相同的
   * - 默认销毁浏览器（destroy: true）以确保资源清理
   */
  ipcMain.handle('profile:close', async (_, id: string, browserId: string) => {
    try {
      const poolManager = getBrowserPoolManager();

      // 释放浏览器回池（默认销毁，因为是 UI 主动关闭）
      await poolManager.release(browserId, { destroy: true });

      console.log(`[Profile:Close] Browser released via pool: ${browserId} for profile: ${id}`);

      return { success: true };
    } catch (error) {
      console.error('[IPC] profile:close error:', error);
      return handleIPCError(error, '关闭浏览器失败');
    }
  });

  // =====================================================
  // 浏览器池显式操作 (v2) - 插件/高级用例
  // =====================================================

  /**
   * 通过浏览器池获取浏览器
   *
   * 此方法特点：
   * - 支持指定 pluginId 用于资源追踪和自动清理
   * - 支持自定义 strategy（fresh/reuse/any）
   * - 支持自定义 timeout
   * - 插件停止时可通过 pluginId 批量释放浏览器
   */
  ipcMain.handle(
    'profile:pool-launch',
    async (
      _,
      profileId: string,
      options?: {
        pluginId?: string;
        timeout?: number;
        strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
        browserId?: string;
        engine?: AutomationEngine;
      }
    ) => {
      try {
        const poolManager = getBrowserPoolManager();
        const strategy = options?.strategy || 'any';

        if (strategy === 'specific' && !options?.browserId) {
          return { success: false, error: 'strategy=specific requires browserId' };
        }

        // 获取浏览器（可能复用空闲的，或创建新的，或进入等待队列）
        const profileLease = await acquireProfileLiveSessionLease(profileId, {
          timeoutMs: options?.timeout || 30000,
        });
        let handle: BrowserHandle;
        try {
          handle = attachProfileLiveSessionLease(
            await poolManager.acquire(
              profileId,
              {
                strategy,
                browserId: options?.browserId,
                timeout: options?.timeout || 30000,
                engine: options?.engine,
              },
              'ipc',
              options?.pluginId
            ),
            profileLease
          );
        } catch (error) {
          await profileLease?.release().catch(() => undefined);
          throw error;
        }
        launchedPoolHandles.set(handle.browserId, handle);

        console.log(
          `[Profile:PoolLaunch] Browser acquired: ${handle.browserId} for profile: ${profileId}`
        );

        return {
          success: true,
          data: {
            browserId: handle.browserId,
            sessionId: handle.sessionId,
            profileId,
            engine: handle.engine,
          },
        };
      } catch (error) {
        console.error('[IPC] profile:pool-launch error:', error);
        return handleIPCError(error, '获取浏览器失败');
      }
    }
  );

  /**
   * 释放浏览器回池
   *
   * 浏览器不会被销毁，而是：
   * - 清理状态后放回池中等待复用
   * - 如果有等待的请求，直接分配给等待者
   */
  ipcMain.handle(
    'profile:pool-release',
    async (
      _,
      browserId: string,
      options?: {
        destroy?: boolean;
        navigateTo?: string;
        clearStorage?: boolean;
      }
    ) => {
      try {
        const poolManager = getBrowserPoolManager();
        const trackedHandle = launchedPoolHandles.get(browserId);

        if (trackedHandle) {
          launchedPoolHandles.delete(browserId);
          await trackedHandle.release(options);
        } else {
          // 释放浏览器回池；Profile 状态由浏览器池统一维护
          await poolManager.release(browserId, options);
        }

        console.log(`[Profile:PoolRelease] Browser released: ${browserId}`);

        return { success: true };
      } catch (error) {
        console.error('[IPC] profile:pool-release error:', error);
        return handleIPCError(error, '释放浏览器失败');
      }
    }
  );

  /**
   * 获取浏览器池统计信息
   */
  ipcMain.handle('profile:pool-stats', async () => {
    try {
      const poolManager = getBrowserPoolManager();
      const stats = await poolManager.getStats();
      return { success: true, data: stats };
    } catch (error) {
      console.error('[IPC] profile:pool-stats error:', error);
      return handleIPCError(error, '获取池统计失败');
    }
  });

  /**
   * 列出当前浏览器池中的所有浏览器实例（用于 UI 查看）
   */
  ipcMain.handle('profile:pool-list-browsers', async () => {
    try {
      const poolManager = getBrowserPoolManager();
      const browsers = poolManager.listBrowsers();

      const data: PoolBrowserInfo[] = browsers.map((browser) => ({
        id: browser.id,
        sessionId: browser.sessionId,
        engine: browser.engine,
        status: browser.status,
        viewId: 'viewId' in browser ? browser.viewId : undefined,
        createdAt: browser.createdAt,
        lastAccessedAt: browser.lastAccessedAt,
        useCount: browser.useCount,
        idleTimeoutMs: browser.idleTimeoutMs,
        lockedAt: 'lockedAt' in browser ? browser.lockedAt : undefined,
        lockedBy: 'lockedBy' in browser ? browser.lockedBy : undefined,
      }));

      return { success: true, data };
    } catch (error) {
      console.error('[IPC] profile:pool-list-browsers error:', error);
      return handleIPCError(error, '获取浏览器列表失败');
    }
  });

  /**
   * 获取指定 Profile 的浏览器统计
   */
  /**
   * 在弹窗中打开（显示）运行中的浏览器
   *
   * - Electron 路径会把离屏 view 前置到应用内弹窗
   * - 非 Electron 路径会调用运行时的 show/bringToFront
   * - 如果该 view 已经在弹窗中打开，则只聚焦已有弹窗
   */
  ipcMain.handle(
    'profile:pool-show-browser',
    async (_, browserId: string, options?: { title?: string; width?: number; height?: number }) => {
      try {
        const poolManager = getBrowserPoolManager();
        const pooled = poolManager.listBrowsers().find((b) => b.id === browserId);
        if (!pooled) {
          return { success: false, error: `Browser not found: ${browserId}` };
        }

        if (pooled.engine !== 'electron') {
          if (!hasBrowserInstance(pooled)) {
            return {
              success: false,
              error: `Browser is not ready to show (status=${pooled.status})`,
            };
          }

          if (typeof pooled.browser.show !== 'function') {
              return {
                success: false,
                error: 'Browser does not support show/bringToFront.',
              };
            }

          try {
            await pooled.browser.show();
          } catch (error) {
            if (!isPersistentBrowserClosedError(error)) {
              throw error;
            }

            console.warn(
              `[IPC] profile:pool-show-browser detected closed browser, destroying stale instance: ${browserId}`
            );
            await poolManager.destroyBrowser(browserId).catch(() => undefined);

            const profileLease = await acquireProfileLiveSessionLease(pooled.sessionId, {
              timeoutMs: 30000,
            });
            let relaunched: BrowserHandle;
            try {
              relaunched = attachProfileLiveSessionLease(
                await poolManager.acquire(
                  pooled.sessionId,
                  {
                    strategy: 'reuse',
                    timeout: 30000,
                    engine: pooled.engine,
                  },
                  'ipc'
                ),
                profileLease
              );
            } catch (error) {
              await profileLease?.release().catch(() => undefined);
              throw error;
            }

            try {
              if (typeof relaunched.browser.show === 'function') {
                await relaunched.browser.show();
              }
            } finally {
              // 仅为前置窗口临时 acquire，立即 release 避免锁泄漏（实例保留在池中）
              await relaunched.release().catch((releaseError) => {
                console.warn(
                  '[IPC] profile:pool-show-browser failed to release relaunched persistent handle:',
                  releaseError
                );
              });
            }

              console.log(
                `[IPC] profile:pool-show-browser relaunched ${pooled.engine} browser: ${relaunched.browserId} for profile: ${pooled.sessionId}`
              );
            return {
              success: true,
              data: {
                engine: pooled.engine,
                activated: true,
                browserId: relaunched.browserId,
                relaunched: true,
              },
            };
          }

          return { success: true, data: { engine: pooled.engine, activated: true } };
        }

        const viewId = 'viewId' in pooled ? pooled.viewId : undefined;
        if (!viewId) {
          return { success: false, error: `Browser view is not ready (status=${pooled.status})` };
        }

        // 如果已经在某个 popup 里打开了，直接聚焦该窗口即可
        const existingPopupWindowId = windowManager.findPopupIdByViewId(viewId);
        if (existingPopupWindowId) {
          const existingPopup = windowManager.getWindowById(existingPopupWindowId);
          if (existingPopup && !existingPopup.isDestroyed()) {
            existingPopup.show();
            existingPopup.focus();
            return { success: true, data: { viewId, popupWindowId: existingPopupWindowId } };
          }
        }

        let title = options?.title;
        if (!title) {
          try {
            const profile = await profileService.get(pooled.sessionId);
            title = profile ? `浏览器 - ${profile.name}` : `浏览器 - ${pooled.sessionId}`;
          } catch {
            title = `浏览器 - ${pooled.sessionId}`;
          }
        }

        const popupId = showBrowserViewInPopup(viewId, viewManager, windowManager, {
          title,
          width: options?.width || 1200,
          height: options?.height || 800,
        });

        if (!popupId) {
          return { success: false, error: 'Failed to open browser popup' };
        }

        const popupWindowId = `popup-${popupId}`;
        const popupWindow = windowManager.getWindowById(popupWindowId);
        if (popupWindow && !popupWindow.isDestroyed()) {
          popupWindow.show();
          popupWindow.focus();
        }

        return { success: true, data: { popupId, viewId, popupWindowId } };
      } catch (error) {
        console.error('[IPC] profile:pool-show-browser error:', error);
        return handleIPCError(error, '打开浏览器失败');
      }
    }
  );

  ipcMain.handle('profile:pool-profile-stats', async (_, profileId: string) => {
    try {
      const poolManager = getBrowserPoolManager();
      const stats = await poolManager.getProfileStats(profileId);
      return { success: true, data: stats };
    } catch (error) {
      console.error('[IPC] profile:pool-profile-stats error:', error);
      return handleIPCError(error, '获取 Profile 统计失败');
    }
  });

  /**
   * 销毁指定 Profile 的所有浏览器实例（用于显式“重启”）
   *
   * 注意：这会强制关闭该 Profile 下所有已打开的浏览器。
   */
  ipcMain.handle('profile:pool-destroy-profile-browsers', async (_, profileId: string) => {
    try {
      const poolManager = getBrowserPoolManager();
      const destroyed = await poolManager.destroyProfileBrowsers(profileId);

      return { success: true, data: { destroyed } };
    } catch (error) {
      console.error('[IPC] profile:pool-destroy-profile-browsers error:', error);
      return handleIPCError(error, '重启浏览器失败');
    }
  });

  /**
   * 续期浏览器锁定
   *
   * 延长锁定时间，防止长时间操作被超时释放
   * 建议在执行长时间操作时定期调用此方法
   */
  ipcMain.handle('profile:pool-renew-lock', async (_, browserId: string, extensionMs?: number) => {
    try {
      const poolManager = getBrowserPoolManager();
      const success = await poolManager.renewLock(browserId, extensionMs);

      if (success) {
        console.log(`[Profile:PoolRenewLock] Lock renewed: ${browserId}`);
      } else {
        console.warn(`[Profile:PoolRenewLock] Failed to renew lock: ${browserId}`);
      }

      return { success, data: { renewed: success } };
    } catch (error) {
      console.error('[IPC] profile:pool-renew-lock error:', error);
      return handleIPCError(error, '续期锁定失败');
    }
  });

  /**
   * 释放插件持有的所有浏览器
   *
   * 在插件停止时调用，确保资源被正确释放
   */
  ipcMain.handle('profile:pool-release-by-plugin', async (_, pluginId: string) => {
    try {
      const poolManager = getBrowserPoolManager();
      const result = await poolManager.releaseByPlugin(pluginId);

      console.log(
        `[Profile:PoolReleaseByPlugin] Released ${result.browsers} browsers, cancelled ${result.requests} requests for plugin: ${pluginId}`
      );

      return { success: true, data: result };
    } catch (error) {
      console.error('[IPC] profile:pool-release-by-plugin error:', error);
      return handleIPCError(error, '释放插件资源失败');
    }
  });

  // =====================================================
  // 浏览器池配置 (v2)
  // =====================================================

  // 获取浏览器池配置
  ipcMain.handle('browser-pool:get-config', async () => {
    try {
      const savedConfig = poolConfigStore.get('browserPoolConfig') || {};
      const config: BrowserPoolConfig = {
        ...DEFAULT_BROWSER_POOL_CONFIG,
        ...savedConfig,
      };
      return { success: true, data: config };
    } catch (error) {
      console.error('[IPC] browser-pool:get-config error:', error);
      return handleIPCError(error, '获取配置失败');
    }
  });

  // 更新浏览器池配置
  ipcMain.handle('browser-pool:set-config', async (_, config: Partial<BrowserPoolConfig>) => {
    try {
      // 验证配置值
      if (config.maxTotalBrowsers !== undefined) {
        const { min, max } = BROWSER_POOL_LIMITS.maxTotalBrowsers;
        if (config.maxTotalBrowsers < min || config.maxTotalBrowsers > max) {
          throw new Error(`maxTotalBrowsers must be between ${min} and ${max}`);
        }
      }

      if (config.maxConcurrentCreation !== undefined) {
        const { min, max } = BROWSER_POOL_LIMITS.maxConcurrentCreation;
        if (config.maxConcurrentCreation < min || config.maxConcurrentCreation > max) {
          throw new Error(`maxConcurrentCreation must be between ${min} and ${max}`);
        }
      }

      if (config.defaultIdleTimeoutMs !== undefined) {
        const { min, max } = BROWSER_POOL_LIMITS.defaultIdleTimeoutMs;
        if (config.defaultIdleTimeoutMs < min || config.defaultIdleTimeoutMs > max) {
          throw new Error(`defaultIdleTimeoutMs must be between ${min} and ${max}`);
        }
      }

      if (config.defaultLockTimeoutMs !== undefined) {
        const { min, max } = BROWSER_POOL_LIMITS.defaultLockTimeoutMs;
        if (config.defaultLockTimeoutMs < min || config.defaultLockTimeoutMs > max) {
          throw new Error(`defaultLockTimeoutMs must be between ${min} and ${max}`);
        }
      }

      if (config.healthCheckIntervalMs !== undefined) {
        const { min, max } = BROWSER_POOL_LIMITS.healthCheckIntervalMs;
        if (config.healthCheckIntervalMs < min || config.healthCheckIntervalMs > max) {
          throw new Error(`healthCheckIntervalMs must be between ${min} and ${max}`);
        }
      }

      // 保存到持久化存储
      const currentConfig = poolConfigStore.get('browserPoolConfig') || {};
      const newConfig = { ...currentConfig, ...config };
      poolConfigStore.set('browserPoolConfig', newConfig);

      // 合并完整配置
      const fullConfig: BrowserPoolConfig = {
        ...DEFAULT_BROWSER_POOL_CONFIG,
        ...newConfig,
      };

      // 同步到运行时的池管理器
      try {
        const poolManager = getBrowserPoolManager();
        poolManager.setConfig(fullConfig);
        console.log('[IPC] browser-pool:set-config: Applied to runtime', fullConfig);
      } catch {
        // 池可能未初始化，配置将在下次启动时生效
        console.log(
          '[IPC] browser-pool:set-config: Pool not initialized, config saved for next start'
        );
      }

      return { success: true, data: fullConfig };
    } catch (error) {
      console.error('[IPC] browser-pool:set-config error:', error);
      return handleIPCError(error, '保存配置失败');
    }
  });

  // 应用预设配置
  ipcMain.handle(
    'browser-pool:apply-preset',
    async (_, preset: 'light' | 'standard' | 'performance') => {
      try {
        const presetConfig = BROWSER_POOL_PRESETS[preset];
        if (!presetConfig) {
          throw IpcError.invalidInput('preset', `Unknown preset: ${preset}`);
        }

        const newConfig: BrowserPoolConfig = {
          mode: preset,
          ...presetConfig,
        };

        // 保存到持久化存储
        poolConfigStore.set('browserPoolConfig', newConfig);

        // 同步到运行时的池管理器
        try {
          const poolManager = getBrowserPoolManager();
          poolManager.setConfig(newConfig);
          console.log(`[IPC] browser-pool:apply-preset: ${preset} applied to runtime`, newConfig);
        } catch {
          console.log(
            `[IPC] browser-pool:apply-preset: Pool not initialized, preset saved for next start`
          );
        }

        return { success: true, data: newConfig };
      } catch (error) {
        console.error('[IPC] browser-pool:apply-preset error:', error);
        return handleIPCError(error, '应用预设失败');
      }
    }
  );

  // 获取预设列表
  ipcMain.handle('browser-pool:get-presets', async () => {
    try {
      return {
        success: true,
        data: {
          presets: BROWSER_POOL_PRESETS,
          limits: BROWSER_POOL_LIMITS,
        },
      };
    } catch (error) {
      console.error('[IPC] browser-pool:get-presets error:', error);
      return handleIPCError(error, '获取预设失败');
    }
  });

  // 重置为默认配置
  ipcMain.handle('browser-pool:reset-config', async () => {
    try {
      poolConfigStore.delete('browserPoolConfig');

      // 同步到运行时的池管理器
      try {
        const poolManager = getBrowserPoolManager();
        poolManager.setConfig(DEFAULT_BROWSER_POOL_CONFIG);
        console.log('[IPC] browser-pool:reset-config: Reset to defaults and applied to runtime');
      } catch {
        console.log(
          '[IPC] browser-pool:reset-config: Pool not initialized, reset saved for next start'
        );
      }

      return { success: true, data: DEFAULT_BROWSER_POOL_CONFIG };
    } catch (error) {
      console.error('[IPC] browser-pool:reset-config error:', error);
      return handleIPCError(error, '重置配置失败');
    }
  });

  console.log('[ProfileIPC] Profile, ProfileGroup, and BrowserPool handlers registered');
}
