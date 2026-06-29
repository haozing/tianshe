/**
 * TaskQueue 单元测试
 * 测试重点：任务执行、取消、查询、进度更新、事件系统、重试、超时、并发控制
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TaskQueueNamespace } from './task-queue';
import type { TaskContext, TaskEvent, TaskProgress } from './task-queue';
import { TaskCancelledError } from '../../task-manager';
import { PluginRuntimeRegistry } from '../runtime-registry';

describe('TaskQueueNamespace', () => {
  let namespace: TaskQueueNamespace;

  beforeEach(() => {
    namespace = new TaskQueueNamespace('test-plugin');
  });

  afterEach(async () => {
    await namespace.stopAll();
  });

  describe('基础任务执行', () => {
    it('应该能创建队列并执行任务', async () => {
      const queue = await namespace.create({ concurrency: 2 });

      const task = vi.fn(async (_ctx: TaskContext) => {
        return 'success';
      });

      const result = await queue.add(task);

      expect(result).toBe('success');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('应该能执行多个任务', async () => {
      const queue = await namespace.create({ concurrency: 2 });

      const results = await queue.addAll([
        { task: async (_ctx) => 'task1' },
        { task: async (_ctx) => 'task2' },
        { task: async (_ctx) => 'task3' },
      ]);

      expect(results).toEqual(['task1', 'task2', 'task3']);
    });

    it('任务应该接收到正确的上下文', async () => {
      const queue = await namespace.create();

      const task = vi.fn(async (ctx: TaskContext<{ storeName: string }>) => {
        expect(ctx.signal).toBeDefined();
        expect(ctx.taskId).toBeDefined();
        expect(ctx.meta?.storeName).toBe('测试店铺');
        expect(typeof ctx.updateProgress).toBe('function');
        return 'success';
      });

      await queue.add(task, {
        taskId: 'custom-task-id',
        meta: { storeName: '测试店铺' },
      });

      expect(task).toHaveBeenCalled();
    });
  });

  describe('任务取消', () => {
    it('应该能取消单个任务', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      let startedExecuting = false;
      let checkpointsReached = 0;

      const task = async (ctx: TaskContext) => {
        startedExecuting = true;
        for (let i = 0; i < 100; i++) {
          if (ctx.signal.aborted) {
            throw new Error('Task cancelled');
          }
          checkpointsReached++;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return 'completed';
      };

      const _taskPromise = queue.add(task, { taskId: 'cancelable-task' }).catch(() => {});

      // 等待任务开始执行
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(startedExecuting).toBe(true);

      const success = await queue.cancelTask('cancelable-task');
      expect(success).toBe(true);

      // 等待取消生效
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 任务应该没有完成所有检查点
      expect(checkpointsReached).toBeLessThan(100);
    });

    it('应该能取消多个任务', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const task = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Cancelled');
      };

      queue.add(task, { taskId: 'task-1' }).catch(() => {});
      queue.add(task, { taskId: 'task-2' }).catch(() => {});
      queue.add(task, { taskId: 'task-3' }).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      const count = await queue.cancelTasks(['task-1', 'task-2', 'task-3']);

      expect(count).toBeGreaterThan(0);
    });

    it('应该能取消所有任务', async () => {
      const queue = await namespace.create({ concurrency: 2 });

      const task = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Cancelled');
      };

      queue.add(task).catch(() => {});
      queue.add(task).catch(() => {});
      queue.add(task).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      const count = await queue.cancelAll();

      expect(count).toBeGreaterThan(0);
    });

    it('取消不存在的任务应该返回 false', async () => {
      const queue = await namespace.create();

      const success = await queue.cancelTask('non-existent-task');

      expect(success).toBe(false);
    });

    it('应该能使用外部 AbortSignal', async () => {
      const queue = await namespace.create();

      const controller = new AbortController();

      const task = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Cancelled');
      };

      const taskPromise = queue.add(task, { signal: controller.signal });

      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();

      await expect(taskPromise).rejects.toThrow('cancelled');
    });
  });

  describe('任务查询', () => {
    it('应该能查询单个任务信息', async () => {
      const queue = await namespace.create();

      const taskPromise = queue.add(
        async (_ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'done';
        },
        { taskId: 'query-task', name: '测试任务' }
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const taskInfo = queue.getTask('query-task');

      expect(taskInfo).toBeDefined();
      expect(taskInfo?.taskId).toBe('query-task');
      expect(taskInfo?.name).toBe('测试任务');
      expect(['pending', 'running']).toContain(taskInfo?.status);
      await taskPromise;
    });

    it('应该能查询所有任务', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const tasks = [
        queue.add(async (_ctx) => 'task1', { name: 'Task 1' }),
        queue.add(async (_ctx) => 'task2', { name: 'Task 2' }),
        queue.add(async (_ctx) => 'task3', { name: 'Task 3' }),
      ];

      await new Promise((resolve) => setTimeout(resolve, 50));

      const allTasks = queue.getAllTasks();

      expect(allTasks.length).toBe(3);
      await Promise.all(tasks);
    });

    it('应该能按状态筛选任务', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const task1 = queue.add(
        async (_ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return 'done';
        },
        { taskId: 'task-1' }
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runningTasks = queue.getAllTasks({ status: 'running' });
      const _pendingTasks = queue.getAllTasks({ status: 'pending' });

      expect(runningTasks.length).toBeGreaterThan(0);

      await task1;
    });

    it('应该能获取队列统计信息', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const tasks = [queue.add(async (_ctx) => 'task1'), queue.add(async (_ctx) => 'task2')];

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = queue.getStats();

      expect(stats).toBeDefined();
      expect(stats.total).toBe(2);
      expect(typeof stats.running).toBe('number');
      expect(typeof stats.pending).toBe('number');
      expect(typeof stats.isPaused).toBe('boolean');

      await Promise.all(tasks);
    });
  });

  describe('进度更新', () => {
    it('应该能更新任务进度', async () => {
      const queue = await namespace.create();

      const progressUpdates: TaskProgress[] = [];

      queue.on('task:progress', (event: TaskEvent) => {
        if (event.progress) {
          progressUpdates.push(event.progress);
        }
      });

      await queue.add(async (ctx) => {
        ctx.updateProgress?.({ current: 1, total: 10, message: '步骤 1' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        ctx.updateProgress?.({ current: 5, total: 10, message: '步骤 5' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        ctx.updateProgress?.({ current: 10, total: 10, message: '完成' });
        return 'done';
      });

      expect(progressUpdates.length).toBe(3);
      expect(progressUpdates[0].current).toBe(1);
      expect(progressUpdates[1].current).toBe(5);
      expect(progressUpdates[2].current).toBe(10);
    });
  });

  describe('事件系统', () => {
    it('应该触发 task-added 事件', async () => {
      const queue = await namespace.create();

      const addedEvents: TaskEvent[] = [];

      queue.on('task:added', (event: TaskEvent) => {
        addedEvents.push(event);
      });

      await queue.add(async (_ctx) => 'task1', { name: 'Task 1' });

      expect(addedEvents.length).toBe(1);
      expect(addedEvents[0].name).toBe('Task 1');
      expect(addedEvents[0].status).toBe('pending');
    });

    it('应该触发 task-started 事件', async () => {
      const queue = await namespace.create();

      const startedEvents: TaskEvent[] = [];

      queue.on('task:started', (event: TaskEvent) => {
        startedEvents.push(event);
      });

      await queue.add(
        async (_ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'done';
        },
        { name: 'Test Task' }
      );

      expect(startedEvents.length).toBe(1);
      expect(startedEvents[0].status).toBe('running');
    });

    it('应该触发 task-completed 事件', async () => {
      const queue = await namespace.create();

      const completedEvents: TaskEvent[] = [];

      queue.on('task:completed', (event: TaskEvent) => {
        completedEvents.push(event);
      });

      await queue.add(async (_ctx) => 'success', { name: 'Completed Task' });

      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].status).toBe('completed');
      expect(typeof completedEvents[0].duration).toBe('number');
    });

    it('应该触发 task-failed 事件', async () => {
      const queue = await namespace.create({ retry: 0 });

      const failedEvents: TaskEvent[] = [];

      queue.on('task:failed', (event: TaskEvent) => {
        failedEvents.push(event);
      });

      try {
        await queue.add(
          async (_ctx) => {
            throw new Error('Task failed');
          },
          { name: 'Failed Task' }
        );
      } catch (_error) {
        // Expected
      }

      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0].status).toBe('failed');
      expect(failedEvents[0].error).toBeDefined();
    });

    it('应该触发 task-cancelled 事件', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const cancelledEvents: TaskEvent[] = [];

      queue.on('task:cancelled', (event: TaskEvent) => {
        cancelledEvents.push(event);
      });

      const taskPromise = queue.add(
        async (ctx) => {
          while (!ctx.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Cancelled');
        },
        { taskId: 'cancellable-task', name: 'Cancellable Task' }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      await queue.cancelTask('cancellable-task');

      try {
        await taskPromise;
      } catch (_error) {
        // Expected
      }

      expect(cancelledEvents.length).toBe(1);
      expect(cancelledEvents[0].status).toBe('cancelled');
    });

    it('应该触发 queue-idle 事件', async () => {
      const queue = await namespace.create();

      let idleTriggered = false;

      queue.on('queue:idle', () => {
        idleTriggered = true;
      });

      await queue.add(async (_ctx) => 'task1');
      await queue.onIdle();

      expect(idleTriggered).toBe(true);
    });
  });

  describe('重试机制', () => {
    it('应该能自动重试失败的任务', async () => {
      const queue = await namespace.create({ retry: 2, retryDelay: 100 });

      let attemptCount = 0;

      const task = async (_ctx: TaskContext) => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Task failed');
        }
        return 'success';
      };

      const result = await queue.add(task);

      expect(result).toBe('success');
      expect(attemptCount).toBe(3); // 1次初始 + 2次重试
    });

    it('达到最大重试次数后应该失败', async () => {
      const queue = await namespace.create({ retry: 2, retryDelay: 50 });

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      let attemptCount = 0;

      const task = async (_ctx: TaskContext) => {
        attemptCount++;
        throw new Error('Always fails');
      };

      await expect(queue.add(task)).rejects.toThrow('Always fails');

      expect(attemptCount).toBe(3); // 1次初始 + 2次重试

      consoleWarnSpy.mockRestore();
    });

    it('任务级 retry 应该覆盖队列级配置', async () => {
      const queue = await namespace.create({ retry: 1, retryDelay: 50 });

      let attemptCount = 0;

      const task = async (_ctx: TaskContext) => {
        attemptCount++;
        if (attemptCount < 4) {
          throw new Error('Task failed');
        }
        return 'success';
      };

      const result = await queue.add(task, { retry: 3 });

      expect(result).toBe('success');
      expect(attemptCount).toBe(4); // 1次初始 + 3次重试
    });
  });

  describe('超时控制', () => {
    it('任务超时应该失败', async () => {
      const queue = await namespace.create({ timeout: 200 });

      const task = async (_ctx: TaskContext) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'should not complete';
      };

      const error = await queue.add(task).catch((err) => err);
      expect(error).toBeInstanceOf(TaskCancelledError);
      expect(error.reason).toContain('timeout');
    });

    it('任务级 timeout 应该覆盖队列级配置', async () => {
      const queue = await namespace.create({ timeout: 1000 });

      const task = async (_ctx: TaskContext) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'should not complete';
      };

      const error = await queue.add(task, { timeout: 100 }).catch((err) => err);
      expect(error).toBeInstanceOf(TaskCancelledError);
      expect(error.reason).toContain('timeout');
    });
  });

  describe('并发控制', () => {
    it('应该限制并发任务数量', async () => {
      const queue = await namespace.create({ concurrency: 2 });

      let runningCount = 0;
      let maxRunningCount = 0;

      const task = async (_ctx: TaskContext) => {
        runningCount++;
        maxRunningCount = Math.max(maxRunningCount, runningCount);
        await new Promise((resolve) => setTimeout(resolve, 100));
        runningCount--;
        return 'done';
      };

      await Promise.all([
        queue.add(task),
        queue.add(task),
        queue.add(task),
        queue.add(task),
        queue.add(task),
      ]);

      expect(maxRunningCount).toBeLessThanOrEqual(2);
    });
  });

  describe('优先级', () => {
    it('高优先级任务应该先执行', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      const executionOrder: string[] = [];

      // 添加一个慢任务占用队列
      queue.add(async (_ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'blocking';
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // 添加不同优先级的任务
      queue.add(
        async (_ctx) => {
          executionOrder.push('low');
          return 'low';
        },
        { priority: 0 }
      );

      queue.add(
        async (_ctx) => {
          executionOrder.push('high');
          return 'high';
        },
        { priority: 10 }
      );

      queue.add(
        async (_ctx) => {
          executionOrder.push('medium');
          return 'medium';
        },
        { priority: 5 }
      );

      await queue.onIdle();

      expect(executionOrder[0]).toBe('high');
      expect(executionOrder[1]).toBe('medium');
      expect(executionOrder[2]).toBe('low');
    });
  });

  describe('队列控制', () => {
    it('应该能暂停和恢复队列', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      let executionOrder: number[] = [];

      // 添加第一个任务并立即暂停
      queue.add(async (_ctx) => {
        executionOrder.push(1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return '1';
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // 暂停队列
      queue.pause();

      // 添加第二个任务（不应该立即执行因为队列已暂停）
      queue.add(async (_ctx) => {
        executionOrder.push(2);
        return '2';
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // 第二个任务不应该执行
      expect(executionOrder).toEqual([1]);

      // 恢复队列
      queue.resume();

      await queue.onIdle();

      // 现在第二个任务应该执行了
      expect(executionOrder).toEqual([1, 2]);
    });

    it('应该能清空待执行任务', async () => {
      const queue = await namespace.create({ concurrency: 1 });

      let executedTasks: string[] = [];

      // 暂停队列以防止任务立即执行
      queue.pause();

      // 添加多个任务
      const pendingTasks = [
        queue
          .add(async (_ctx) => {
            executedTasks.push('task1');
            return 'task1';
          })
          .catch(() => undefined),
        queue
          .add(async (_ctx) => {
            executedTasks.push('task2');
            return 'task2';
          })
          .catch(() => undefined),
        queue
          .add(async (_ctx) => {
            executedTasks.push('task3');
            return 'task3';
          })
          .catch(() => undefined),
      ];

      await new Promise((resolve) => setTimeout(resolve, 50));

      const statsBefore = queue.getStats();
      expect(statsBefore.pending).toBeGreaterThan(0);

      // 清空队列
      queue.clear();

      // 恢复队列
      queue.resume();

      await new Promise((resolve) => setTimeout(resolve, 200));

      await Promise.allSettled(pendingTasks);

      // 被清空的任务不应该执行
      expect(executedTasks.length).toBe(0);
    });

    it('应该能停止队列', async () => {
      const queue = await namespace.create({ concurrency: 2 });

      const taskPromises = [
        queue
          .add(
            async (ctx) => {
              while (!ctx.signal.aborted) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              throw new Error('Stopped');
            },
            { taskId: 'task-1' }
          )
          .catch(() => undefined),
        queue
          .add(
            async (ctx) => {
              while (!ctx.signal.aborted) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              throw new Error('Stopped');
            },
            { taskId: 'task-2' }
          )
          .catch(() => undefined),
      ];

      await new Promise((resolve) => setTimeout(resolve, 100));

      await queue.stop();
      await Promise.allSettled(taskPromises);

      // 停止后不应该接受新任务
      await expect(queue.add(async (_ctx) => 'new task')).rejects.toThrow('Queue has been stopped');
    });
  });

  describe('命名空间管理', () => {
    it('应该能创建多个队列', async () => {
      const _queue1 = await namespace.create({ name: 'Queue 1' });
      const _queue2 = await namespace.create({ name: 'Queue 2' });

      expect(namespace.getActiveQueues().length).toBe(2);
    });

    it('应该限制最大队列数量', async () => {
      const maxQueues = 10;

      for (let i = 0; i < maxQueues; i++) {
        await namespace.create({ name: `Queue ${i}` });
      }

      await expect(namespace.create({ name: 'Extra Queue' })).rejects.toThrow('最大队列数量限制');
    });

    it('队列空闲时应该保留', async () => {
      const queue = await namespace.create({ name: 'Auto-remove Queue' });

      await queue.add(async (_ctx) => 'task');

      await queue.onIdle();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(namespace.getActiveQueues().length).toBe(1);
    });

    it('应该能停止所有队列', async () => {
      await namespace.create({ name: 'Queue 1' });
      await namespace.create({ name: 'Queue 2' });
      await namespace.create({ name: 'Queue 3' });

      expect(namespace.getActiveQueues().length).toBe(3);

      await namespace.stopAll();

      expect(namespace.getActiveQueues().length).toBe(0);
    });

    it('应该把队列注册到运行态并在 stopAll 后清空队列计数', async () => {
      const runtimeRegistry = new PluginRuntimeRegistry();
      const runtimeNamespace = new TaskQueueNamespace('test-plugin', runtimeRegistry);

      const queue = await runtimeNamespace.create({ name: 'Runtime Queue' });
      expect(runtimeRegistry.getStatus('test-plugin')?.activeQueues).toBe(1);

      await queue.add(async (_ctx) => 'done', { name: '测试任务' });
      await runtimeNamespace.stopAll();

      const status = runtimeRegistry.getStatus('test-plugin');
      expect(status).not.toBeNull();
      expect(status?.activeQueues).toBe(0);
      expect(status?.runningTasks).toBe(0);
      expect(runtimeNamespace.getActiveQueues().length).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('应该处理同步任务', async () => {
      const queue = await namespace.create();

      const result = await queue.add((_ctx) => 'sync result');

      expect(result).toBe('sync result');
    });

    it('应该处理返回 undefined 的任务', async () => {
      const queue = await namespace.create();

      const result = await queue.add(async (_ctx) => {
        // 不返回任何值
      });

      expect(result).toBeUndefined();
    });

    it('应该处理空的 addAll', async () => {
      const queue = await namespace.create();

      const results = await queue.addAll([]);

      expect(results).toEqual([]);
    });

    it('任务抛出非 Error 对象应该正常处理', async () => {
      const queue = await namespace.create({ retry: 0 });

      await expect(
        queue.add(async (_ctx) => {
          throw 'string error';
        })
      ).rejects.toBe('string error');
    });
  });
});
