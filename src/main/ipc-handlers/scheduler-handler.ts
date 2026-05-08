/**
 * SchedulerIPCHandler - 定时任务调度处理器
 * 负责：定时任务的查询、管理等 IPC 操作
 */

import { IpcMainInvokeEvent } from 'electron';
import { handleIPCError } from '../ipc-utils';
import type { SchedulerService } from '../scheduler';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';

export class SchedulerIPCHandler {
  constructor(private schedulerService: SchedulerService) {}

  private createRoutes(): IpcRouteDefinition[] {
    return [
      {
        channel: 'scheduler:get-all-tasks',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent) => {
          try {
            const result = await this.schedulerService.getAllTasks();
            return { success: true, tasks: result.tasks, total: result.total };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:get-tasks-by-plugin',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
          try {
            const tasks = await this.schedulerService.getTasksByPlugin(pluginId);
            return { success: true, tasks };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:get-task',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string) => {
          try {
            const task = await this.schedulerService.getTask(taskId);
            return { success: true, task };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:get-task-history',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string, limit?: number) => {
          try {
            const executions = await this.schedulerService.getTaskHistory(taskId, limit);
            return { success: true, executions };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:pause-task',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string) => {
          try {
            await this.schedulerService.pauseTask(taskId);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:resume-task',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string) => {
          try {
            await this.schedulerService.resumeTask(taskId);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:trigger-task',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string) => {
          try {
            const execution = await this.schedulerService.triggerTask(taskId);
            return { success: true, execution };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:cancel-task',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, taskId: string) => {
          try {
            await this.schedulerService.cancelTask(taskId);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:get-stats',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent) => {
          try {
            const stats = await this.schedulerService.getStats();
            return { success: true, stats };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'scheduler:get-recent-executions',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, limit?: number) => {
          try {
            const executions = await this.schedulerService.getRecentExecutions(limit);
            return { success: true, executions };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
    ];
  }

  register(): void {
    ipcRouteRegistry.registerAll(this.createRoutes());
    console.log('  ✓ SchedulerIPCHandler registered');
  }
}
