/**
 * Account IPC Handler
 * 处理账号和常用网站相关的 IPC 请求
 *
 * 使用工厂函数简化 CRUD 操作的重复代码
 */

import { ipcMain } from 'electron';
import type { AccountService } from '../duckdb/account-service';
import type { SavedSiteService } from '../duckdb/saved-site-service';
import type { ProfileService } from '../duckdb/profile-service';
import type {
  CreateAccountParams,
  CreateAccountWithAutoProfileParams,
  UpdateAccountParams,
  CreateSavedSiteParams,
  UpdateSavedSiteParams,
} from '../../types/profile';
import { UNBOUND_PROFILE_ID } from '../../types/profile';
import {
  getBrowserPoolManager,
  showBrowserViewInPopup,
  type BrowserHandle,
} from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../core/browser-pool/profile-live-session-lease';
import { createIpcHandler, createIpcVoidHandler } from './utils';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import type { WindowManager } from '../window-manager';

/**
 * 登录选项
 */
export interface LoginOptions {
  /** 是否在弹窗中显示浏览器，默认 true */
  showPopup?: boolean;
  /** 弹窗宽度 */
  popupWidth?: number;
  /** 弹窗高度 */
  popupHeight?: number;
  /** 是否自动打开当前登录浏览器的 DevTools；未设置时跟随全局开关 */
  openDevTools?: boolean;
}

interface RegisterAccountHandlersOptions {
  onOwnedBundleChanged?: () => Promise<void> | void;
}

/**
 * 注册账号相关的 IPC 处理器
 *
 * v2 重构：浏览器操作通过 BrowserPoolManager
 * v2.1 增强：支持弹窗显示浏览器（用于登录场景）
 */
export function registerAccountHandlers(
  accountService: AccountService,
  savedSiteService: SavedSiteService,
  profileService: ProfileService,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager,
  handlerOptions: RegisterAccountHandlersOptions = {}
) {
  const notifyOwnedBundleChanged = async () => {
    if (!handlerOptions.onOwnedBundleChanged) return;
    try {
      await handlerOptions.onOwnedBundleChanged();
    } catch (error) {
      console.warn('[AccountIPC] Failed to mark owned account bundle dirty:', error);
    }
  };

  // =====================================================
  // Account CRUD (使用工厂函数减少重复代码)
  // =====================================================

  createIpcHandler(
    'account:create',
    async (params: CreateAccountParams) => {
      const created = await accountService.create(params);
      await notifyOwnedBundleChanged();
      return created;
    },
    '创建账号失败'
  );

  createIpcHandler(
    'account:create-with-auto-profile',
    async (params: CreateAccountWithAutoProfileParams) => {
      const created = await accountService.createWithAutoProfile(profileService, params);
      await notifyOwnedBundleChanged();
      return created;
    },
    '自动创建环境并创建账号失败'
  );

  createIpcHandler('account:get', (id: string) => accountService.get(id), '获取账号失败');

  createIpcHandler(
    'account:list-by-profile',
    (profileId: string) => accountService.listByProfile(profileId),
    '获取账号列表失败'
  );

  createIpcHandler(
    'account:list-by-platform',
    (platformId: string) => accountService.listByPlatform(platformId),
    '获取平台账号列表失败'
  );

  createIpcHandler('account:list-all', () => accountService.listAll(), '获取所有账号失败');

  createIpcHandler(
    'account:reveal-secret',
    (id: string) => accountService.revealSecret(id),
    '查看账号密码失败'
  );

  createIpcHandler(
    'account:update',
    async (id: string, params: UpdateAccountParams) => {
      const updated = await accountService.update(id, params);
      await notifyOwnedBundleChanged();
      return updated;
    },
    '更新账号失败'
  );

  createIpcVoidHandler(
    'account:delete',
    async (id: string) => {
      await accountService.delete(id);
      await notifyOwnedBundleChanged();
    },
    '删除账号失败'
  );

  // =====================================================
  // 账号登录（v2 重构：统一使用浏览器池）
  // =====================================================

  /**
   * 账号登录
   *
   * v2 重构：通过浏览器池获取浏览器
   * v2.1 增强：支持弹窗显示浏览器
   *
   * - 使用账号关联的 Profile 配置
   * - 自动导航到登录 URL
   * - 支持弹窗显示（默认开启）
  */
  ipcMain.handle('account:login', async (_, accountId: string, options?: LoginOptions) => {
    let acquiredHandle: BrowserHandle | null = null;
    let popupOwnsHandle = false;

    const safeReleaseHandle = async (): Promise<void> => {
      if (!acquiredHandle || popupOwnsHandle) return;
      try {
        await acquiredHandle.release();
      } catch (releaseError) {
        console.warn('[Account:Login] Failed to release browser after login error:', releaseError);
      }
    };

    try {
      // 解析选项（默认显示弹窗）
      const showPopup = options?.showPopup !== false;

      // 获取账号信息
      const account = await accountService.get(accountId);
      if (!account) {
        return { success: false, error: `Account not found: ${accountId}` };
      }

      if (!account.platformId) {
        return {
          success: false,
          error: '账号未关联平台，请先在账号管理中选择平台',
        };
      }

      // 仅按 platformId 解析所属平台（开发阶段不兼容历史字段回退）
      const platform = await savedSiteService.get(account.platformId);
      if (!platform) {
        return {
          success: false,
          error: '账号所属平台不存在，请先在账号管理中重新选择平台',
        };
      }

      const accountProfileIdRaw = String(account.profileId || '').trim();
      const accountProfileId =
        accountProfileIdRaw.length > 0 && accountProfileIdRaw !== UNBOUND_PROFILE_ID
          ? accountProfileIdRaw
          : '';

      const effectiveProfileId = accountProfileId;
      if (!effectiveProfileId) {
        return {
          success: false,
          error: '当前账号未绑定浏览器环境，请先在账号管理中为该账号绑定浏览器环境',
        };
      }

      // 获取关联的 Profile
      const profile = await profileService.get(effectiveProfileId);
      if (!profile) {
        return {
          success: false,
          error: '绑定的浏览器环境已不存在，请先在账号管理中为该账号重绑浏览器环境',
        };
      }

      // 通过浏览器池获取浏览器（使用关联的 Profile）
      const poolManager = getBrowserPoolManager();
      const profileLease = await acquireProfileLiveSessionLease(effectiveProfileId, {
        timeoutMs: 30000,
      });
      let handle: BrowserHandle;
      try {
        handle = attachProfileLiveSessionLease(
          await poolManager.acquire(
            effectiveProfileId,
            { strategy: 'any', timeout: 30000, priority: 'normal' },
            'ipc' // 标记来源为 IPC（UI 通过 IPC 调用）
          ),
          profileLease
        );
        acquiredHandle = handle;
      } catch (error) {
        await profileLease?.release().catch(() => undefined);
        throw error;
      }

      // 导航到登录 URL（优先账号自定义标签页 URL，回退平台 URL）
      const targetUrl = account.loginUrl || platform.url || '';
      try {
        if (targetUrl) {
          await handle.browser.goto(targetUrl);
        }
      } catch (navError) {
        console.warn('[Account:Login] Navigation warning:', navError);
        // 导航失败不阻止登录流程，用户可以手动输入 URL
      }

      // 更新账号最后登录时间
      await accountService.updateLastLogin(accountId);

      // 获取浏览器关联的 viewId
      const pooledBrowser = poolManager.listBrowsers().find((b) => b.id === handle.browserId);
      const viewId = pooledBrowser?.viewId || handle.browserId;

      // 持久化引擎没有 WebContentsView，尝试前置原生窗口
      if (showPopup && handle.engine !== 'electron' && typeof handle.browser.show === 'function') {
        try {
          await handle.browser.show();
        } catch (showError) {
          console.warn('[Account:Login] Failed to show persistent browser window:', showError);
        }
      }

      // 如果需要弹窗显示（仅 Electron 引擎）
      let popupId: string | null = null;
      const canShowPopup = showPopup && handle.engine === 'electron' && Boolean(viewId);
      const accountLabel = account.displayName || account.name;
      if (canShowPopup && viewId) {
        // 提取域名用于弹窗标题
        let domain = targetUrl;
        try {
          domain = new URL(targetUrl).hostname;
        } catch {
          // 如果 URL 解析失败，使用原始 URL
        }

        popupId = showBrowserViewInPopup(viewId, viewManager, windowManager, {
          title: `登录 - ${accountLabel} (${domain})`,
          width: options?.popupWidth || 1200,
          height: options?.popupHeight || 800,
          openDevTools: options?.openDevTools,
          onClose: () => {
            console.log(`[Account:Login] Popup closed for account: ${accountId}`);
            // 弹窗关闭时释放浏览器；Profile 状态由浏览器池统一维护
            void (async () => {
              try {
                await handle.release();
              } catch (err) {
                console.warn(`[Account:Login] Failed to release browser on popup close:`, err);
              }
            })();
          },
        });

        if (!popupId) {
          await safeReleaseHandle();
          return {
            success: false,
            error: '登录窗口打开失败，请重试',
          };
        }

        popupOwnsHandle = true;
        console.log(`[Account:Login] Browser shown in popup: ${popupId}`);
      }

      // 没有弹窗接管句柄时，立即释放避免浏览器锁泄漏
      if (!popupOwnsHandle) {
        await safeReleaseHandle();
      }

      console.log(
        `[Account:Login] Browser acquired via pool: ${handle.browserId} for account: ${accountId}`
      );

      return {
        success: true,
        data: {
          viewId,
          browserId: handle.browserId,
          sessionId: handle.sessionId,
          accountId,
          accountName: accountLabel,
          profileId: effectiveProfileId,
          profileName: profile.name,
          loginUrl: targetUrl,
          platformId: platform.id,
          platformName: platform.name,
          popupId, // 返回弹窗 ID（用于手动关闭）
        },
      };
    } catch (error) {
      await safeReleaseHandle();
      console.error('[IPC] account:login error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '启动浏览器失败',
      };
    }
  });

  // =====================================================
  // SavedSite CRUD (使用工厂函数减少重复代码)
  // =====================================================

  createIpcHandler(
    'saved-site:create',
    async (params: CreateSavedSiteParams) => {
      const created = await savedSiteService.create(params);
      await notifyOwnedBundleChanged();
      return created;
    },
    '创建常用网站失败'
  );

  createIpcHandler('saved-site:get', (id: string) => savedSiteService.get(id), '获取常用网站失败');

  createIpcHandler(
    'saved-site:get-by-name',
    (name: string) => savedSiteService.getByName(name),
    '获取常用网站失败'
  );

  createIpcHandler('saved-site:list', () => savedSiteService.listAll(), '获取常用网站列表失败');

  createIpcHandler(
    'saved-site:update',
    async (id: string, params: UpdateSavedSiteParams) => {
      const updated = await savedSiteService.update(id, params);
      await notifyOwnedBundleChanged();
      return updated;
    },
    '更新常用网站失败'
  );

  createIpcVoidHandler(
    'saved-site:delete',
    async (id: string) => {
      await savedSiteService.delete(id);
      await notifyOwnedBundleChanged();
    },
    '删除常用网站失败'
  );

  createIpcVoidHandler(
    'saved-site:increment-usage',
    (id: string) => savedSiteService.incrementUsage(id),
    '更新使用次数失败'
  );

  // =====================================================
  // 弹窗关闭
  // =====================================================

  /**
   * 关闭弹窗窗口
   */
  ipcMain.handle('popup:close', async (_, popupId: string) => {
    try {
      // v3 API: 使用统一的 closeWindowById
      windowManager.closeWindowById(`popup-${popupId}`);
      return { success: true };
    } catch (error) {
      console.error('[IPC] popup:close error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '关闭弹窗失败',
      };
    }
  });

  console.log('[AccountIPC] Account and SavedSite handlers registered');
}
