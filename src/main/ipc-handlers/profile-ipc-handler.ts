/**
 * Profile IPC Handler
 * 处理前端浏览器配置相关的 IPC 请求
 *
 * v2 架构：Profile-First + BrowserPoolManager
 */

import type { IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../ipc-route-registry';
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
  BrowserRuntimeId,
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
  requestProfileLiveSessionHandoff,
  completeProfileLiveSessionHandoff,
  approveProfileLiveSessionHandoff,
  pauseProfileLiveSessionHandoff,
  cancelProfileLiveSessionHandoff,
  getProfileLiveSessionHandoff,
  listProfileLiveSessionHandoffs,
  type ProfileLiveSessionHandoffRequest,
} from '../../core/browser-pool/profile-live-session-lease';
import { resourceCoordinator, type ResourceHandoffEvent } from '../../core/resource-coordinator';
import { fingerprintManager } from '../../core/stealth';
import { createIPCFailureResponse } from '../ipc-utils';
import { createIpcHandler, handleIPCError, IpcError, type IpcSenderGuard } from './utils';
import { createLogger } from '../../core/logger';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import type { WindowManager } from '../window-manager';

const logger = createLogger('ProfileIPCHandler');

interface ProfileManualHandoffView {
  id: string;
  profileId: string | null;
  keys: string[];
  status: ProfileLiveSessionHandoffRequest['status'];
  requester: {
    source: ProfileLiveSessionHandoffRequest['requesterSource'];
    metadata: ProfileLiveSessionHandoffRequest['requesterMetadata'];
  };
  currentOwner: {
    source: ProfileLiveSessionHandoffRequest['ownerSource'];
    metadata: ProfileLiveSessionHandoffRequest['ownerMetadata'];
    acquiredAt: number | null;
  };
  reason: string | null;
  message: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  approvedAt: number | null;
  pausedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
  expiredAt: number | null;
  statusReason: string | null;
}

const PROFILE_RESOURCE_PREFIX = 'profile:';
const handoffEventForwardingWindowManagers = new WeakSet<WindowManager>();

function profileIdFromHandoff(request: ProfileLiveSessionHandoffRequest): string | null {
  const key = request.keys.find((candidate) => candidate.startsWith(PROFILE_RESOURCE_PREFIX));
  return key ? key.slice(PROFILE_RESOURCE_PREFIX.length) || null : null;
}

function toManualHandoffView(
  request: ProfileLiveSessionHandoffRequest
): ProfileManualHandoffView {
  return {
    id: request.id,
    profileId: profileIdFromHandoff(request),
    keys: [...request.keys],
    status: request.status,
    requester: {
      source: request.requesterSource,
      metadata: request.requesterMetadata,
    },
    currentOwner: {
      source: request.ownerSource,
      metadata: request.ownerMetadata,
      acquiredAt: request.ownerAcquiredAt,
    },
    reason: request.reason,
    message: request.message,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
    approvedAt: request.approvedAt,
    pausedAt: request.pausedAt,
    completedAt: request.completedAt,
    canceledAt: request.canceledAt,
    expiredAt: request.expiredAt,
    statusReason: request.statusReason,
  };
}

function isProfileHandoffRequest(
  request: ProfileLiveSessionHandoffRequest
): request is ProfileLiveSessionHandoffRequest {
  return request.keys.some((key) => key.startsWith(PROFILE_RESOURCE_PREFIX));
}

function sendProfileHandoffEvent(
  windowManager: WindowManager,
  event: ResourceHandoffEvent
): void {
  if (!isProfileHandoffRequest(event.request)) {
    return;
  }

  const payload = {
    type: event.type,
    handoff: toManualHandoffView(event.request),
  };
  const mainWindow = windowManager.getMainWindowV3?.();
  mainWindow?.webContents.send('profile:handoff-changed', payload);
  if (event.type === 'handoff:requested') {
    mainWindow?.webContents.send('profile:handoff-requested', payload);
  }
}

function ensureProfileHandoffEventForwarding(windowManager: WindowManager): void {
  if (handoffEventForwardingWindowManagers.has(windowManager)) {
    return;
  }
  handoffEventForwardingWindowManagers.add(windowManager);
  resourceCoordinator.onHandoffEvent((event) => {
    sendProfileHandoffEvent(windowManager, event);
  });
}

// 用于持久化浏览器池配置的 electron-store 实例
const poolConfigStore = new Store<{ browserPoolConfig?: Partial<BrowserPoolConfig> }>({
  name: 'browser-pool-config',
});

function logProfileIpcError(channel: string, error: unknown): void {
  logger.error('Profile IPC handler failed', {
    channel,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { raw: String(error) },
  });
}

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

function findAgentHeldLockedBrowser(
  poolManager: ReturnType<typeof getBrowserPoolManager>,
  profileId: string,
  runtimeId?: BrowserRuntimeId
): { id: string } | null {
  const browsers = poolManager.listBrowsers();
  const candidate = browsers.find((browser) => {
    if (browser.sessionId !== profileId) return false;
    if (browser.status !== 'locked') return false;
    if (runtimeId && browser.runtimeId !== runtimeId) return false;
    const source = browser.lockedBy?.source;
    return source === 'mcp' || source === 'http';
  });
  return candidate ? { id: candidate.id } : null;
}

/**
 * 注册 Profile 相关的 IPC 处理器
 *
 * v2 重构：浏览器操作通过 BrowserPoolManager，不再需要 viewManager/windowManager
 */
interface RegisterProfileHandlersOptions {
  senderGuard?: IpcSenderGuard;
}

export function registerProfileHandlers(
  profileService: ProfileService,
  groupService: ProfileGroupService,
  _accountService: AccountService,
  viewManager: WebContentsViewManager,
  windowManager: WindowManager,
  options: RegisterProfileHandlersOptions = {}
) {
  const launchedPoolHandles = new Map<
    string,
    { handle: BrowserHandle; releasing: boolean; releaseLease: () => Promise<void> }
  >();
  const cleanupTrackedPoolHandle = async (browserId: string): Promise<void> => {
    const tracked = launchedPoolHandles.get(browserId);
    if (!tracked) return;
    launchedPoolHandles.delete(browserId);
    if (tracked.releasing) return;
    tracked.releasing = true;
    await tracked.releaseLease();
  };
  const assertSender = (event: IpcMainInvokeEvent, channel: string): void => {
    options.senderGuard?.(event, channel);
  };
  ensureProfileHandoffEventForwarding(windowManager);

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
        params.runtimeId !== undefined ||
        params.runtimeSourceOverride !== undefined ||
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
            logger.info('Destroyed profile browsers after runtime profile update', {
              profileId: id,
              destroyedCount,
            });
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
  ipcRouteRegistry.register({
    channel: 'profile:delete',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Delete a profile, cascade owned profile data, and destroy active browsers.',
      args: [{ name: 'id', type: 'string', required: true }],
      result: { success: 'boolean', error: 'string?' },
    },
    handler: async (event, id: string) => {
      try {
        assertSender(event, 'profile:delete');
        // 1. 先销毁该 Profile 的所有浏览器实例（内存操作，不参与事务）
        try {
          const poolManager = getBrowserPoolManager();
          const destroyedCount = await poolManager.destroyProfileBrowsers(id);
          if (destroyedCount > 0) {
            logger.info('Destroyed profile browsers before profile delete', {
              profileId: id,
              destroyedCount,
            });
          }
        } catch {
          // 池可能未初始化，忽略
        }

        // 2. 事务性删除 Profile（并将关联账号置为未绑定）
        // deleteWithCascade 使用数据库事务，确保解绑和删除原子性
        await profileService.deleteWithCascade(id);
        return { success: true };
      } catch (error) {
        logProfileIpcError('profile:delete', error);
        return handleIPCError(error, '删除浏览器配置失败');
      }
    },
  });

  // =====================================================
  // Profile 状态管理
  // =====================================================

  // 更新状态
  ipcRouteRegistry.register({
    channel: 'profile:update-status',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, id: string, status: ProfileStatus, error?: string) => {
      try {
        await profileService.updateStatus(id, status, error);
        return { success: true };
      } catch (err) {
        logProfileIpcError('profile:update-status', err);
        return handleIPCError(err, '更新状态失败');
      }
    },
  });

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
  ipcRouteRegistry.register({
    channel: 'profile-group:delete',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, id: string, recursive?: boolean) => {
      try {
        await groupService.delete(id, { recursive });
        return { success: true };
      } catch (error) {
        logProfileIpcError('profile-group:delete', error);
        return handleIPCError(error, '删除分组失败');
      }
    },
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
  ipcRouteRegistry.register({
    channel: 'profile:close',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, id: string, browserId: string) => {
      try {
        const poolManager = getBrowserPoolManager();

        // 释放浏览器回池（默认销毁，因为是 UI 主动关闭）
        await poolManager.release(browserId, { destroy: true });

        logger.info('Browser released via pool on profile close', { browserId, profileId: id });

        return { success: true };
      } catch (error) {
        logProfileIpcError('profile:close', error);
        return handleIPCError(error, '关闭浏览器失败');
      }
    },
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
  ipcRouteRegistry.register({
    channel: 'profile:pool-launch',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Acquire a browser from the profile browser pool.',
      args: [
        { name: 'profileId', type: 'string', required: true },
        { name: 'options', type: 'object', required: false },
      ],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (
      event,
      profileId: string,
      launchOptions?: {
        pluginId?: string;
        timeout?: number;
        strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
        browserId?: string;
        runtimeId?: BrowserRuntimeId;
      }
    ) => {
      try {
        assertSender(event, 'profile:pool-launch');
        const poolManager = getBrowserPoolManager();
        const strategy = launchOptions?.strategy || 'any';

        if (strategy === 'specific' && !launchOptions?.browserId) {
          return createIPCFailureResponse('strategy=specific requires browserId', 'INVALID_INPUT', {
            context: { profileId, strategy },
          });
        }

        // 获取浏览器（可能复用空闲的，或创建新的，或进入等待队列）
        const acquireOptions = {
          strategy,
          browserId: launchOptions?.browserId,
          timeout: launchOptions?.timeout || 30000,
          runtimeId: launchOptions?.runtimeId,
        };
        const agentHeldBrowser = findAgentHeldLockedBrowser(
          poolManager,
          profileId,
          launchOptions?.runtimeId
        );
        let profileLease;
        if (agentHeldBrowser) {
          const handoffRequest = await requestProfileLiveSessionHandoff(profileId, {
            source: 'ipc',
            requesterMetadata: {
              controllerKind: 'human',
              interruptibility: 'non_interruptible',
              description: 'human profile pool launch',
            },
            reason: 'human_requested_agent_profile_handoff',
            autoApproveIfCurrentOwnerInterruptible: true,
          });
          if (
            !handoffRequest ||
            (handoffRequest.status !== 'approved' && handoffRequest.status !== 'paused')
          ) {
            throw new Error('Profile handoff request requires approval before human takeover');
          }
          profileLease = await completeProfileLiveSessionHandoff(handoffRequest.id, {
            actorToken: handoffRequest.requesterToken,
            source: 'ipc',
            ownerMetadata: {
              controllerKind: 'human',
              interruptibility: 'non_interruptible',
              description: 'human profile pool launch',
            },
          });
        } else {
          profileLease = await acquireProfileLiveSessionLease(profileId, {
            source: 'ipc',
            ownerMetadata: {
              controllerKind: 'human',
              interruptibility: 'non_interruptible',
              description: 'human profile pool launch',
            },
            timeoutMs: launchOptions?.timeout || 30000,
          });
        }
        const releaseLease = async (): Promise<void> => {
          await profileLease?.release().catch(() => undefined);
        };
        let handle: BrowserHandle;
        try {
          const acquiredHandle = agentHeldBrowser
            ? await poolManager.takeoverLockedBrowser(
                profileId,
                {
                  ...acquireOptions,
                  browserId: launchOptions?.browserId || agentHeldBrowser.id,
                },
                'ipc',
                launchOptions?.pluginId
              )
            : await poolManager.acquire(profileId, acquireOptions, 'ipc', launchOptions?.pluginId);
          if (!acquiredHandle) {
            throw new Error('No locked browser was available for human handoff takeover');
          }
          handle = attachProfileLiveSessionLease(acquiredHandle, profileLease);
        } catch (error) {
          await profileLease?.release().catch(() => undefined);
          throw error;
        }
        launchedPoolHandles.set(handle.browserId, { handle, releasing: false, releaseLease });
        const handleReleased = ({ browserId: releasedBrowserId }: { browserId: string }) => {
          if (releasedBrowserId !== handle.browserId) return;
          poolManager.getEventEmitter().off('browser:released', handleReleased);
          void cleanupTrackedPoolHandle(handle.browserId);
        };
        poolManager.getEventEmitter().on('browser:released', handleReleased);

        logger.info('Browser acquired from profile pool', {
          browserId: handle.browserId,
          profileId,
          runtimeId: handle.runtimeId,
        });

        return {
          success: true,
          data: {
            browserId: handle.browserId,
            sessionId: handle.sessionId,
            profileId,
            runtimeId: handle.runtimeId,
          },
        };
      } catch (error) {
        logProfileIpcError('profile:pool-launch', error);
        return handleIPCError(error, '获取浏览器失败');
      }
    },
  });

  /**
   * 释放浏览器回池
   *
   * 浏览器不会被销毁，而是：
   * - 清理状态后放回池中等待复用
   * - 如果有等待的请求，直接分配给等待者
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-release',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _,
      browserId: string,
      releaseOptions?: {
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
          trackedHandle.releasing = true;
          await trackedHandle.handle.release(releaseOptions);
        } else {
          // 释放浏览器回池；Profile 状态由浏览器池统一维护
          await poolManager.release(browserId, releaseOptions);
        }

        logger.info('Browser released from profile pool', { browserId });

        return { success: true };
      } catch (error) {
        logProfileIpcError('profile:pool-release', error);
        return handleIPCError(error, '释放浏览器失败');
      }
    },
  });

  /**
   * 获取浏览器池统计信息
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-stats',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const poolManager = getBrowserPoolManager();
        const stats = await poolManager.getStats();
        return { success: true, data: stats };
      } catch (error) {
        logProfileIpcError('profile:pool-stats', error);
        return handleIPCError(error, '获取池统计失败');
      }
    },
  });

  /**
   * 列出当前浏览器池中的所有浏览器实例（用于 UI 查看）
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-list-browsers',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const poolManager = getBrowserPoolManager();
        const browsers = poolManager.listBrowsers();

        const data: PoolBrowserInfo[] = browsers.map((browser) => ({
          id: browser.id,
          sessionId: browser.sessionId,
          runtimeId: browser.runtimeId,
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
        logProfileIpcError('profile:pool-list-browsers', error);
        return handleIPCError(error, '获取浏览器列表失败');
      }
    },
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
  ipcRouteRegistry.register({
    channel: 'profile:handoff-list',
    kind: 'handle',
    permission: 'trusted-renderer',
    schema: {
      description: 'List profile live-session handoff requests for trusted UI.',
      args: [{ name: 'profileId', type: 'string', required: false }],
      result: { success: 'boolean', data: 'object[]?', error: 'string?' },
    },
    handler: async (event, profileId?: string) => {
      try {
        assertSender(event, 'profile:handoff-list');
        const requests = await listProfileLiveSessionHandoffs(profileId);
        return { success: true, data: requests.map(toManualHandoffView) };
      } catch (error) {
        logProfileIpcError('profile:handoff-list', error);
        return handleIPCError(error, 'Failed to list profile handoff requests');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:handoff-get',
    kind: 'handle',
    permission: 'trusted-renderer',
    schema: {
      description: 'Get one profile live-session handoff request for trusted UI.',
      args: [{ name: 'handoffRequestId', type: 'string', required: true }],
      result: { success: 'boolean', data: 'object|null?', error: 'string?' },
    },
    handler: async (event, handoffRequestId: string) => {
      try {
        assertSender(event, 'profile:handoff-get');
        const request = await getProfileLiveSessionHandoff(handoffRequestId);
        return { success: true, data: request ? toManualHandoffView(request) : null };
      } catch (error) {
        logProfileIpcError('profile:handoff-get', error);
        return handleIPCError(error, 'Failed to get profile handoff request');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:handoff-approve',
    kind: 'handle',
    permission: 'trusted-renderer',
    schema: {
      description: 'Approve a pending profile live-session handoff request.',
      args: [
        { name: 'handoffRequestId', type: 'string', required: true },
        { name: 'options', type: 'object', required: false },
      ],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (event, handoffRequestId: string, approveOptions?: { reason?: string }) => {
      try {
        assertSender(event, 'profile:handoff-approve');
        const request = await getProfileLiveSessionHandoff(handoffRequestId);
        if (!request) {
          return createIPCFailureResponse(
            `Profile handoff request not found: ${handoffRequestId}`,
            'NOT_FOUND',
            { context: { handoffRequestId } }
          );
        }
        const approved = await approveProfileLiveSessionHandoff(handoffRequestId, {
          hostAuthorized: true,
          reason: approveOptions?.reason || 'approved_by_trusted_renderer',
        });
        return { success: true, data: toManualHandoffView(approved) };
      } catch (error) {
        logProfileIpcError('profile:handoff-approve', error);
        return handleIPCError(error, 'Failed to approve profile handoff request');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:handoff-pause',
    kind: 'handle',
    permission: 'trusted-renderer',
    schema: {
      description: 'Approve and pause the current owner for a profile live-session handoff.',
      args: [
        { name: 'handoffRequestId', type: 'string', required: true },
        { name: 'options', type: 'object', required: false },
      ],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (event, handoffRequestId: string, pauseOptions?: { reason?: string }) => {
      try {
        assertSender(event, 'profile:handoff-pause');
        const request = await getProfileLiveSessionHandoff(handoffRequestId);
        if (!request) {
          return createIPCFailureResponse(
            `Profile handoff request not found: ${handoffRequestId}`,
            'NOT_FOUND',
            { context: { handoffRequestId } }
          );
        }
        const paused = await pauseProfileLiveSessionHandoff(handoffRequestId, {
          hostAuthorized: true,
          reason: pauseOptions?.reason || 'paused_by_trusted_renderer',
        });
        return { success: true, data: toManualHandoffView(paused) };
      } catch (error) {
        logProfileIpcError('profile:handoff-pause', error);
        return handleIPCError(error, 'Failed to pause profile handoff request');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:handoff-cancel',
    kind: 'handle',
    permission: 'trusted-renderer',
    schema: {
      description: 'Cancel a profile live-session handoff request.',
      args: [
        { name: 'handoffRequestId', type: 'string', required: true },
        { name: 'options', type: 'object', required: false },
      ],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (event, handoffRequestId: string, cancelOptions?: { reason?: string }) => {
      try {
        assertSender(event, 'profile:handoff-cancel');
        const request = await getProfileLiveSessionHandoff(handoffRequestId);
        if (!request) {
          return createIPCFailureResponse(
            `Profile handoff request not found: ${handoffRequestId}`,
            'NOT_FOUND',
            { context: { handoffRequestId } }
          );
        }
        const canceled = await cancelProfileLiveSessionHandoff(handoffRequestId, {
          hostAuthorized: true,
          reason: cancelOptions?.reason || 'canceled_by_trusted_renderer',
        });
        return { success: true, data: toManualHandoffView(canceled) };
      } catch (error) {
        logProfileIpcError('profile:handoff-cancel', error);
        return handleIPCError(error, 'Failed to cancel profile handoff request');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:pool-show-browser',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Show or focus an active browser from the profile browser pool.',
      args: [
        { name: 'browserId', type: 'string', required: true },
        { name: 'options', type: 'object', required: false },
      ],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (
      event,
      browserId: string,
      showOptions?: { title?: string; width?: number; height?: number }
    ) => {
      try {
        assertSender(event, 'profile:pool-show-browser');
        const poolManager = getBrowserPoolManager();
        const pooled = poolManager.listBrowsers().find((b) => b.id === browserId);
        if (!pooled) {
          return createIPCFailureResponse(`Browser not found: ${browserId}`, 'BROWSER_POOL_BROWSER_NOT_FOUND', {
            context: { browserId },
          });
        }

        if (pooled.runtimeId !== 'electron-webcontents') {
          if (!hasBrowserInstance(pooled)) {
            return createIPCFailureResponse(
              `Browser is not ready to show (status=${pooled.status})`,
              'BROWSER_NOT_READY',
              { context: { browserId, status: pooled.status, runtimeId: pooled.runtimeId } }
            );
          }

          if (typeof pooled.browser.show !== 'function') {
            return createIPCFailureResponse(
              'Browser does not support show/bringToFront.',
              'OPERATION_FAILED',
              { context: { browserId, runtimeId: pooled.runtimeId } }
            );
          }

          try {
            await pooled.browser.show();
          } catch (error) {
            if (!isPersistentBrowserClosedError(error)) {
              throw error;
            }

            logger.warn('Detected closed persistent browser; destroying stale instance', {
              browserId,
              profileId: pooled.sessionId,
              runtimeId: pooled.runtimeId,
            });
            await poolManager.destroyBrowser(browserId).catch(() => undefined);

            const profileLease = await acquireProfileLiveSessionLease(pooled.sessionId, {
              source: 'ipc',
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
                    runtimeId: pooled.runtimeId,
                  },
                  'ipc'
                ),
                profileLease
              );
            } catch (acquireError) {
              await profileLease?.release().catch(() => undefined);
              throw acquireError;
            }

            try {
              if (typeof relaunched.browser.show === 'function') {
                await relaunched.browser.show();
              }
            } finally {
              // 仅为前置窗口临时 acquire，立即 release 避免锁泄漏（实例保留在池中）
              await relaunched.release().catch((releaseError) => {
                logger.warn('Failed to release relaunched persistent handle', {
                  browserId: relaunched.browserId,
                  error:
                    releaseError instanceof Error
                      ? { name: releaseError.name, message: releaseError.message }
                      : { raw: String(releaseError) },
                });
              });
            }

            logger.info('Relaunched persistent browser for profile pool show', {
              browserId: relaunched.browserId,
              profileId: pooled.sessionId,
              runtimeId: pooled.runtimeId,
            });
            return {
              success: true,
              data: {
                runtimeId: pooled.runtimeId,
                activated: true,
                browserId: relaunched.browserId,
                relaunched: true,
              },
            };
          }

          return { success: true, data: { runtimeId: pooled.runtimeId, activated: true } };
        }

        const viewId = 'viewId' in pooled ? pooled.viewId : undefined;
        if (!viewId) {
          return createIPCFailureResponse(
            `Browser view is not ready (status=${pooled.status})`,
            'BROWSER_NOT_READY',
            { context: { browserId, status: pooled.status, runtimeId: pooled.runtimeId } }
          );
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

        let title = showOptions?.title;
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
          width: showOptions?.width || 1200,
          height: showOptions?.height || 800,
        });

        if (!popupId) {
          return createIPCFailureResponse('Failed to open browser popup', 'BROWSER_NOT_READY', {
            context: { browserId, viewId },
          });
        }

        const popupWindowId = `popup-${popupId}`;
        const popupWindow = windowManager.getWindowById(popupWindowId);
        if (popupWindow && !popupWindow.isDestroyed()) {
          popupWindow.show();
          popupWindow.focus();
        }

        return { success: true, data: { popupId, viewId, popupWindowId } };
      } catch (error) {
        logProfileIpcError('profile:pool-show-browser', error);
        return handleIPCError(error, '打开浏览器失败');
      }
    },
  });

  ipcRouteRegistry.register({
    channel: 'profile:pool-profile-stats',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, profileId: string) => {
      try {
        const poolManager = getBrowserPoolManager();
        const stats = await poolManager.getProfileStats(profileId);
        return { success: true, data: stats };
      } catch (error) {
        logProfileIpcError('profile:pool-profile-stats', error);
        return handleIPCError(error, '获取 Profile 统计失败');
      }
    },
  });

  /**
   * 销毁指定 Profile 的所有浏览器实例（用于显式”重启”）
   *
   * 注意：这会强制关闭该 Profile 下所有已打开的浏览器。
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-destroy-profile-browsers',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Destroy all pooled browsers for a profile.',
      args: [{ name: 'profileId', type: 'string', required: true }],
      result: { success: 'boolean', data: 'object?', error: 'string?' },
    },
    handler: async (event, profileId: string) => {
      try {
        assertSender(event, 'profile:pool-destroy-profile-browsers');
        const poolManager = getBrowserPoolManager();
        const destroyed = await poolManager.destroyProfileBrowsers(profileId);

        return { success: true, data: { destroyed } };
      } catch (error) {
        logProfileIpcError('profile:pool-destroy-profile-browsers', error);
        return handleIPCError(error, '重启浏览器失败');
      }
    },
  });

  /**
   * 续期浏览器锁定
   *
   * 延长锁定时间，防止长时间操作被超时释放
   * 建议在执行长时间操作时定期调用此方法
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-renew-lock',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, browserId: string, extensionMs?: number) => {
      try {
        const poolManager = getBrowserPoolManager();
        const success = await poolManager.renewLock(browserId, extensionMs);

        if (success) {
          logger.info('Profile pool lock renewed', { browserId, extensionMs });
        } else {
          logger.warn('Profile pool lock renewal returned false', { browserId, extensionMs });
        }

        return { success, data: { renewed: success } };
      } catch (error) {
        logProfileIpcError('profile:pool-renew-lock', error);
        return handleIPCError(error, '续期锁定失败');
      }
    },
  });

  /**
   * 释放插件持有的所有浏览器
   *
   * 在插件停止时调用，确保资源被正确释放
   */
  ipcRouteRegistry.register({
    channel: 'profile:pool-release-by-plugin',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_, pluginId: string) => {
      try {
        const poolManager = getBrowserPoolManager();
        const result = await poolManager.releaseByPlugin(pluginId);

        logger.info('Released profile pool resources by plugin', {
          pluginId,
          releasedBrowsers: result.browsers,
          cancelledRequests: result.requests,
        });

        return { success: true, data: result };
      } catch (error) {
        logProfileIpcError('profile:pool-release-by-plugin', error);
        return handleIPCError(error, '释放插件资源失败');
      }
    },
  });

  // =====================================================
  // 浏览器池配置 (v2)
  // =====================================================

  // 获取浏览器池配置
  ipcRouteRegistry.register({
    channel: 'browser-pool:get-config',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const savedConfig = poolConfigStore.get('browserPoolConfig') || {};
        const config: BrowserPoolConfig = {
          ...DEFAULT_BROWSER_POOL_CONFIG,
          ...savedConfig,
        };
        return { success: true, data: config };
      } catch (error) {
        logProfileIpcError('browser-pool:get-config', error);
        return handleIPCError(error, '获取配置失败');
      }
    },
  });

  // 更新浏览器池配置
  ipcRouteRegistry.register({
    channel: 'browser-pool:set-config',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Persist and apply browser pool runtime configuration.',
      args: [{ name: 'config', type: 'object', required: true }],
      result: { success: 'boolean', data: 'BrowserPoolConfig?', error: 'string?' },
    },
    handler: async (event, config: Partial<BrowserPoolConfig>) => {
      try {
        assertSender(event, 'browser-pool:set-config');
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
          logger.info('Applied browser pool config to runtime', { config: fullConfig });
        } catch {
          // 池可能未初始化，配置将在下次启动时生效
          logger.info('Browser pool not initialized; config saved for next start');
        }

        return { success: true, data: fullConfig };
      } catch (error) {
        logProfileIpcError('browser-pool:set-config', error);
        return handleIPCError(error, '保存配置失败');
      }
    },
  });

  // 应用预设配置
  ipcRouteRegistry.register({
    channel: 'browser-pool:apply-preset',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Apply a named browser pool configuration preset.',
      args: [{ name: 'preset', type: 'string', required: true }],
      result: { success: 'boolean', data: 'BrowserPoolConfig?', error: 'string?' },
    },
    handler: async (event, preset: 'light' | 'standard' | 'performance') => {
      try {
        assertSender(event, 'browser-pool:apply-preset');
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
          logger.info('Applied browser pool preset to runtime', { preset, config: newConfig });
        } catch {
          logger.info('Browser pool not initialized; preset saved for next start', { preset });
        }

        return { success: true, data: newConfig };
      } catch (error) {
        logProfileIpcError('browser-pool:apply-preset', error);
        return handleIPCError(error, '应用预设失败');
      }
    },
  });

  // 获取预设列表
  ipcRouteRegistry.register({
    channel: 'browser-pool:get-presets',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        return {
          success: true,
          data: {
            presets: BROWSER_POOL_PRESETS,
            limits: BROWSER_POOL_LIMITS,
          },
        };
      } catch (error) {
        logProfileIpcError('browser-pool:get-presets', error);
        return handleIPCError(error, '获取预设失败');
      }
    },
  });

  // 重置为默认配置
  ipcRouteRegistry.register({
    channel: 'browser-pool:reset-config',
    kind: 'handle',
    permission: 'privileged',
    schema: {
      description: 'Reset browser pool configuration to defaults.',
      args: [],
      result: { success: 'boolean', data: 'BrowserPoolConfig?', error: 'string?' },
    },
    handler: async (event) => {
      try {
        assertSender(event, 'browser-pool:reset-config');
        poolConfigStore.delete('browserPoolConfig');

        // 同步到运行时的池管理器
        try {
          const poolManager = getBrowserPoolManager();
          poolManager.setConfig(DEFAULT_BROWSER_POOL_CONFIG);
          logger.info('Reset browser pool config to defaults at runtime');
        } catch {
          logger.info('Browser pool not initialized; reset saved for next start');
        }

        return { success: true, data: DEFAULT_BROWSER_POOL_CONFIG };
      } catch (error) {
        logProfileIpcError('browser-pool:reset-config', error);
        return handleIPCError(error, '重置配置失败');
      }
    },
  });

  logger.info('Profile, profile group, and browser pool IPC handlers registered');
}
