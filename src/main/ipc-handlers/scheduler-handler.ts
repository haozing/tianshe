/**
 * SchedulerIPCHandler - 定时任务调度处理器
 * 负责：定时任务的查询、管理等 IPC 操作
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { handleIPCError } from '../ipc-utils';
import type { SchedulerService } from '../scheduler';

export class SchedulerIPCHandler {
  constructor(private schedulerService: SchedulerService) {}

  /**
   * 注册所有定时任务相关的 IPC 处理器
   */
  register(): void {
    // 任务查询
    this.registerGetAllTasks();
    this.registerGetTasksByPlugin();
    this.registerGetTask();
    this.registerGetTaskHistory();

    // 任务管理
    this.registerPauseTask();
    this.registerResumeTask();
    this.registerTriggerTask();
    this.registerCancelTask();

    // 统计信息
    this.registerGetStats();
    this.registerGetRecentExecutions();

    console.log('  ✓ SchedulerIPCHandler registered');
  }

  // ========== 任务查询 ==========

  /**
   * 获取所有定时任务
   */
  private registerGetAllTasks(): void {
    ipcMain.handle('scheduler:get-all-tasks', async (_event: IpcMainInvokeEvent) => {
      try {
        const result = await this.schedulerService.getAllTasks();
        // 平铺结构，与其他 API 保持一致
        return { success: true, tasks: result.tasks, total: result.total };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取指定插件的所有任务
   */
  private registerGetTasksByPlugin(): void {
    ipcMain.handle(
      'scheduler:get-tasks-by-plugin',
      async (_event: IpcMainInvokeEvent, pluginId: string) => {
        try {
          const tasks = await this.schedulerService.getTasksByPlugin(pluginId);
          return { success: true, tasks };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 获取单个任务详情
   */
  private registerGetTask(): void {
    ipcMain.handle('scheduler:get-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
      try {
        const task = await this.schedulerService.getTask(taskId);
        return { success: true, task };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取任务执行历史
   */
  private registerGetTaskHistory(): void {
    ipcMain.handle(
      'scheduler:get-task-history',
      async (_event: IpcMainInvokeEvent, taskId: string, limit?: number) => {
        try {
          const executions = await this.schedulerService.getTaskHistory(taskId, limit);
          return { success: true, executions };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  // ========== 任务管理 ==========

  /**
   * 暂停任务
   */
  private registerPauseTask(): void {
    ipcMain.handle('scheduler:pause-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
      try {
        await this.schedulerService.pauseTask(taskId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 恢复任务
   */
  private registerResumeTask(): void {
    ipcMain.handle('scheduler:resume-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
      try {
        await this.schedulerService.resumeTask(taskId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 手动触发任务执行
   */
  private registerTriggerTask(): void {
    ipcMain.handle('scheduler:trigger-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
      try {
        const execution = await this.schedulerService.triggerTask(taskId);
        return { success: true, execution };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 取消/删除任务
   */
  private registerCancelTask(): void {
    ipcMain.handle('scheduler:cancel-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
      try {
        await this.schedulerService.cancelTask(taskId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  // ========== 统计信息 ==========

  /**
   * 获取调度器统计信息
   */
  private registerGetStats(): void {
    ipcMain.handle('scheduler:get-stats', async (_event: IpcMainInvokeEvent) => {
      try {
        const stats = await this.schedulerService.getStats();
        return { success: true, stats };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 获取最近的执行记录
   */
  private registerGetRecentExecutions(): void {
    ipcMain.handle(
      'scheduler:get-recent-executions',
      async (_event: IpcMainInvokeEvent, limit?: number) => {
        try {
          const executions = await this.schedulerService.getRecentExecutions(limit);
          return { success: true, executions };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }
}
