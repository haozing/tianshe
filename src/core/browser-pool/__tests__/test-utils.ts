/**
 * 浏览器池测试工具
 *
 * 提供 Mock 工厂和测试辅助函数
 */

import { vi } from 'vitest';
import type {
  SessionConfig,
  AcquireRequest,
  AcquireOptions,
  FingerprintConfig,
  PooledBrowserController,
} from '../types';
import type { BrowserFactory, BrowserDestroyer } from '../global-pool';
import type { ProfileService } from '../../../main/duckdb/profile-service';
import type { BrowserProfile, DeepPartial, ProfileStats } from '../../../types/profile';
import {
  getDefaultFingerprint,
  mergeFingerprintConfig,
} from '../../../constants/fingerprint-defaults';

// ============================================
// Mock PooledBrowserController
// ============================================

export interface MockBrowserOptions {
  id?: string;
  viewId?: string;
  isClosed?: boolean;
}

/**
 * 创建 Mock PooledBrowserController
 */
export function createMockBrowser(options: MockBrowserOptions = {}): PooledBrowserController & {
  viewId: string;
  reset: (opts?: { navigateTo?: string; clearStorage?: boolean }) => Promise<void>;
  isClosed: () => boolean;
  _setUrl: (url: string) => void;
  _setClosed: (value: boolean) => void;
} {
  let closed = options.isClosed ?? false;
  let currentUrl = 'about:blank';

  return {
    viewId: options.viewId || `view-${Math.random().toString(36).slice(2, 8)}`,

    goto: vi.fn(async (url: string) => {
      if (closed) throw new Error('Browser is closed');
      currentUrl = url;
    }),
    getCurrentUrl: vi.fn(async () => currentUrl),
    title: vi.fn(async () => 'Mock Title'),

    snapshot: vi.fn(async () => ({ url: currentUrl, title: 'Mock Title', elements: [] })),

    click: vi.fn(async () => {
      if (closed) throw new Error('Browser is closed');
    }),
    type: vi.fn(async () => {
      if (closed) throw new Error('Browser is closed');
    }),
    select: vi.fn(async () => {
      if (closed) throw new Error('Browser is closed');
    }),
    waitForSelector: vi.fn(async () => {
      if (closed) throw new Error('Browser is closed');
    }),
    getText: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),

    evaluate: vi.fn(async () => null),
    evaluateWithArgs: vi.fn(async () => null),

    screenshot: vi.fn(async () => Buffer.from('mock').toString('base64')),
    getCookies: vi.fn(async () => []),
    setCookie: vi.fn(async () => {}),
    clearCookies: vi.fn(async () => {}),

    closeInternal: vi.fn(async () => {
      closed = true;
    }),

    isClosed: () => closed,

    reset: vi.fn(async () => {
      if (closed) throw new Error('Browser is closed');
      currentUrl = 'about:blank';
    }),
    // 测试辅助方法
    _setUrl: (url: string) => {
      currentUrl = url;
    },
    _setClosed: (value: boolean) => {
      closed = value;
    },
  };
}

// ============================================
// Mock Factories
// ============================================

/**
 * 创建 Mock BrowserFactory
 */
export function createMockBrowserFactory(
  options: {
    shouldFail?: boolean;
    failAfterCount?: number;
    creationDelay?: number;
  } = {}
): { factory: BrowserFactory; createdBrowsers: Array<ReturnType<typeof createMockBrowser>> } {
  let createCount = 0;
  const createdBrowsers: Array<ReturnType<typeof createMockBrowser>> = [];

  const factory: BrowserFactory = vi.fn(async (session: SessionConfig) => {
    createCount++;

    if (options.shouldFail) {
      throw new Error('Mock browser creation failed');
    }

    if (options.failAfterCount && createCount > options.failAfterCount) {
      throw new Error(`Creation limit exceeded (${options.failAfterCount})`);
    }

    if (options.creationDelay) {
      await new Promise((resolve) => setTimeout(resolve, options.creationDelay));
    }

    const browser = createMockBrowser({
      viewId: `view-${createCount}`,
    });
    createdBrowsers.push(browser);

    return {
      browser,
      viewId: browser.viewId,
      engine: session.engine ?? 'electron',
    };
  });

  return { factory, createdBrowsers };
}

/**
 * 创建 Mock BrowserDestroyer
 */
export function createMockBrowserDestroyer(
  options: { shouldFail?: boolean; destroyDelay?: number } = {}
): { destroyer: BrowserDestroyer; destroyedViewIds: string[] } {
  const destroyedViewIds: string[] = [];

  const destroyer: BrowserDestroyer = vi.fn(async (_browser: any, viewId?: string) => {
    if (options.shouldFail) {
      throw new Error('Mock browser destruction failed');
    }

    if (options.destroyDelay) {
      await new Promise((resolve) => setTimeout(resolve, options.destroyDelay));
    }

    if (viewId) destroyedViewIds.push(viewId);
  });

  return { destroyer, destroyedViewIds };
}

// ============================================
// Session 辅助函数
// ============================================

/**
 * 创建 SessionConfig
 */
export function createSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  const id = overrides.id || `session-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    partition: overrides.partition || `persist:${id}`,
    engine: overrides.engine,
    quota: overrides.quota ?? 1,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 5 * 60 * 1000,
    lockTimeoutMs: overrides.lockTimeoutMs ?? 5 * 60 * 1000,
    createdAt: overrides.createdAt ?? Date.now(),
    lastAccessedAt: overrides.lastAccessedAt ?? Date.now(),
    fingerprint: overrides.fingerprint,
  };
}

// ============================================
// Request 辅助函数
// ============================================

/**
 * 创建 AcquireRequest
 */
export function createAcquireRequest(
  sessionId: string,
  options: Partial<AcquireOptions> = {},
  overrides: Partial<AcquireRequest> = {}
): AcquireRequest {
  return {
    sessionId,
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source || 'internal',
    pluginId: overrides.pluginId,
    options: {
      strategy: options.strategy || 'any',
      timeout: options.timeout ?? 30000,
      priority: options.priority || 'normal',
      lockTimeout: options.lockTimeout,
      browserId: options.browserId,
    },
  };
}

// ============================================
// Fingerprint 辅助函数
// ============================================

/**
 * 创建 FingerprintConfig
 */
export function createFingerprint(overrides: DeepPartial<FingerprintConfig> = {}): FingerprintConfig {
  return mergeFingerprintConfig(getDefaultFingerprint(), overrides);
}

// ============================================
// 测试辅助函数
// ============================================

/**
 * 等待所有微任务完成
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 等待指定条件成立
 */
export async function waitFor(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 10;
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error('waitFor timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 并发执行多个任务并收集结果
 */
export async function concurrentRun<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(tasks.map((task) => task()));
}

/**
 * 模拟延迟
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Mock ProfileService
// ============================================

export interface MockProfileServiceOptions {
  /** 预设的 Profile 列表 */
  profiles?: BrowserProfile[];
  /** 默认 Profile ID */
  defaultProfileId?: string;
}

/**
 * 创建 Mock BrowserProfile
 */
export function createMockProfile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  const id = overrides.id || `profile-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const engine = overrides.engine ?? 'electron';

  return {
    id,
    name: overrides.name || `Profile ${id}`,
    engine,
    description: overrides.description ?? null,
    groupId: overrides.groupId ?? null,
    partition: overrides.partition || `persist:${id}`,
    proxy: overrides.proxy ?? null,
    fingerprint: overrides.fingerprint || getDefaultFingerprint(engine),
    notes: overrides.notes ?? null,
    color: overrides.color ?? null,
    status: overrides.status ?? 'idle',
    lastError: overrides.lastError ?? null,
    quota: overrides.quota ?? 1,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 5 * 60 * 1000,
    lockTimeoutMs: overrides.lockTimeoutMs ?? 5 * 60 * 1000,
    proxyId: overrides.proxyId ?? null,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    lastActiveAt: overrides.lastActiveAt ?? null,
    isSystem: overrides.isSystem ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    tags: overrides.tags ?? [],
    totalUses: overrides.totalUses ?? 0,
    metadata: overrides.metadata ?? {},
  };
}

/**
 * 创建默认浏览器 Profile（模拟）
 */
export function createDefaultProfile(): BrowserProfile {
  return createMockProfile({
    id: 'default',
    name: '默认浏览器',
    description: '系统默认浏览器配置',
    partition: 'persist:default-browser',
    isSystem: true,
    quota: 1,
  });
}

/**
 * 创建 Mock ProfileService
 */
export function createMockProfileService(options: MockProfileServiceOptions = {}): {
  service: ProfileService;
  profiles: Map<string, BrowserProfile>;
} {
  const profiles = new Map<string, BrowserProfile>();

  // 添加默认 Profile
  const defaultProfile = createDefaultProfile();
  profiles.set(defaultProfile.id, defaultProfile);

  // 添加预设 Profile
  if (options.profiles) {
    for (const profile of options.profiles) {
      profiles.set(profile.id, profile);
    }
  }

  const service: ProfileService = {
    get: vi.fn(async (id: string) => profiles.get(id) || null),

    list: vi.fn(async () => Array.from(profiles.values())),

    create: vi.fn(async (data: any) => {
      const profile = createMockProfile({
        ...data,
        id: data.id || `profile-${Date.now()}`,
      });
      profiles.set(profile.id, profile);
      return profile;
    }),

    update: vi.fn(async (id: string, updates: any) => {
      const profile = profiles.get(id);
      if (!profile) return null;
      const updated = { ...profile, ...updates, updatedAt: new Date() };
      profiles.set(id, updated);
      return updated;
    }),

    updateStatus: vi.fn(async (id: string, status: BrowserProfile['status'], error?: string) => {
      const profile = profiles.get(id);
      if (!profile) return;
      profiles.set(id, {
        ...profile,
        status,
        lastError: error || null,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      });
    }),

    delete: vi.fn(async (id: string) => {
      if (!profiles.has(id)) return false;
      profiles.delete(id);
      return true;
    }),

    getStats: vi.fn(
      async (): Promise<ProfileStats> => ({
        total: profiles.size,
        active: profiles.size,
        byGroup: {},
        recentlyUsed: [],
      })
    ),

    updateLastActive: vi.fn(async () => {}),

    getByGroup: vi.fn(async (groupId: string) =>
      Array.from(profiles.values()).filter((p) => p.groupId === groupId)
    ),

    search: vi.fn(async (query: string) =>
      Array.from(profiles.values()).filter((p) => p.name.includes(query) || p.id.includes(query))
    ),

    getDefault: vi.fn(async () => profiles.get('default') || null),

    setDefault: vi.fn(async () => {}),
  } as unknown as ProfileService;

  return { service, profiles };
}

/**
 * 创建 getProfileService 函数（用于 BrowserPoolManager 构造函数）
 */
export function createMockProfileServiceGetter(options: MockProfileServiceOptions = {}): {
  getProfileService: () => ProfileService;
  profiles: Map<string, BrowserProfile>;
} {
  const { service, profiles } = createMockProfileService(options);
  return {
    getProfileService: () => service,
    profiles,
  };
}
