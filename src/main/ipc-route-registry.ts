/**
 * IPC 路由注册中心
 *
 * 统一管理中心所有 ipcMain.handle/on 注册点，提供：
 * - 重复 channel 检测
 * - 统一注册/注销
 * - channel 清单导出（供 preload 和类型声明复用）
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';

export type IpcRoutePermission = 'trusted-renderer' | 'privileged' | 'internal';

export interface IpcRouteSchema {
  description?: string;
  args?: unknown;
  result?: unknown;
}

export interface IpcRouteDefinition {
  channel: string;
  kind: 'handle' | 'on';
  permission: IpcRoutePermission;
  schema?: IpcRouteSchema;
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => any;
}

export interface IpcRouteManifestEntry {
  channel: string;
  kind: 'handle' | 'on';
  permission: IpcRoutePermission;
  schema?: IpcRouteSchema;
}

const VALID_PERMISSIONS: ReadonlySet<IpcRoutePermission> = new Set([
  'trusted-renderer',
  'privileged',
  'internal',
]);

export class IpcRouteRegistry {
  private routes = new Map<string, IpcRouteDefinition>();
  private disposers = new Map<string, () => void>();

  /** 注册单个路由（重复 channel 会抛错） */
  register(route: IpcRouteDefinition): void {
    if (!route.permission || !VALID_PERMISSIONS.has(route.permission)) {
      throw new Error(`[IpcRouteRegistry] Missing IPC permission declaration: ${route.channel}`);
    }

    if (this.routes.has(route.channel)) {
      throw new Error(`[IpcRouteRegistry] Duplicate IPC channel: ${route.channel}`);
    }

    this.routes.set(route.channel, route);

    if (route.kind === 'handle') {
      ipcMain.handle(route.channel, route.handler);
      this.disposers.set(route.channel, () => {
        ipcMain.removeHandler(route.channel);
      });
    } else {
      ipcMain.on(route.channel, route.handler);
      this.disposers.set(route.channel, () => {
        ipcMain.removeListener(route.channel, route.handler);
      });
    }
  }

  /** 批量注册路由 */
  registerAll(routes: IpcRouteDefinition[]): void {
    for (const route of routes) {
      this.register(route);
    }
  }

  /** 注销单个路由 */
  unregister(channel: string): void {
    const dispose = this.disposers.get(channel);
    if (dispose) {
      dispose();
      this.disposers.delete(channel);
    }
    this.routes.delete(channel);
  }

  /** 注销所有路由 */
  unregisterAll(): void {
    for (const [channel] of this.routes) {
      this.unregister(channel);
    }
  }

  /** 获取已注册的所有 channel 列表 */
  getChannels(): string[] {
    return Array.from(this.routes.keys());
  }

  /** 获取已注册 route 元数据（不暴露 handler） */
  getManifest(): IpcRouteManifestEntry[] {
    return Array.from(this.routes.values()).map((route) => ({
      channel: route.channel,
      kind: route.kind,
      permission: route.permission,
      ...(route.schema ? { schema: route.schema } : {}),
    }));
  }

  /** 获取已注册路由数量 */
  get size(): number {
    return this.routes.size;
  }

  /** 检查 channel 是否已注册 */
  has(channel: string): boolean {
    return this.routes.has(channel);
  }
}

/** 全局注册表实例（主进程生命周期内单例） */
export const ipcRouteRegistry = new IpcRouteRegistry();
