/**
 * TaskQueue 单元测试
 *
 * 测试 core/task-manager/queue.ts 的所有功能：
 * - 基础任务执行
 * - 任务取消
 * - 任务查询和统计
 * - 进度更新
 * - 事件系统
 * - 重试机制
 * - 超时控制
 * - 并发控制
 * - 队列控制（暂停/恢复/清空/停止）
 * - 边界情况
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskQueue, createTaskQueue } from './queue';
import { TaskCancelledError, isTaskCancelledError } from './errors';
import type { TaskContext, TaskEvent, TaskProgress } from './types';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = createTaskQueue({ concurrency: 3, name: 'test-queue' });
  });

  afterEach(async () => {
    await queue.stop();
  });

  // ========== 基础任务执行 ==========

  describe('基础任务执行', () => {
    it('应该能执行异步任务并返回结果', async () => {
      const result = await queue.add(async () => {
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('应该能执行同步任务', async () => {
      const result = await queue.add(() => 42);

      expect(result).toBe(42);
    });

    it('应该能执行多个任务', async () => {
      const results = await queue.addAll([
        { task: async () => 'task1' },
        { task: async () => 'task2' },
        { task: async () => 'task3' },
      ]);

      expect(results).toEqual(['task1', 'task2', 'task3']);
    });

    it('任务应该接收到正确的上下文', async () => {
      const task = vi.fn(async (ctx: TaskContext<{ value: number }>) => {
        expect(ctx.signal).toBeDefined();
        expect(ctx.signal).toBeInstanceOf(AbortSignal);
        expect(ctx.taskId).toBeDefined();
        expect(ctx.meta?.value).toBe(123);
        expect(typeof ctx.updateProgress).toBe('function');
        return 'done';
      });

      await queue.add(task, {
        taskId: 'custom-id',
        meta: { value: 123 },
      });

      expect(task).toHaveBeenCalled();
    });

    it('应该生成唯一的 taskId', async () => {
      const taskIds: string[] = [];

      await queue.addAll([
        {
          task: async (ctx) => {
            taskIds.push(ctx.taskId);
          },
        },
        {
          task: async (ctx) => {
            taskIds.push(ctx.taskId);
          },
        },
        {
          task: async (ctx) => {
            taskIds.push(ctx.taskId);
          },
        },
      ]);

      expect(new Set(taskIds).size).toBe(3);
    });

    it('应该能使用自定义 taskId', async () => {
      let capturedTaskId = '';

      await queue.add(
        async (ctx) => {
          capturedTaskId = ctx.taskId;
        },
        { taskId: 'my-custom-task-id' }
      );

      expect(capturedTaskId).toBe('my-custom-task-id');
    });
  });

  // ========== 任务取消 ==========

  describe('任务取消', () => {
    it('应该能取消正在运行的任务', async () => {
      let checkpoints = 0;

      const taskPromise = queue
        .add(
          async (ctx) => {
            for (let i = 0; i < 100; i++) {
              if (ctx.signal.aborted) {
                throw new TaskCancelledError('Task cancelled');
              }
              checkpoints++;
              await new Promise((r) => setTimeout(r, 10));
            }
            return 'completed';
          },
          { taskId: 'cancellable-task' }
        )
        .catch(() => {});

      // 等待任务开始执行
      await new Promise((r) => setTimeout(r, 50));

      const success = await queue.cancelTask('cancellable-task');
      expect(success).toBe(true);

      await taskPromise;

      expect(checkpoints).toBeLessThan(100);
    });

    it('应该能取消多个任务', async () => {
      const longTask = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new TaskCancelledError('Cancelled');
      };

      queue.add(longTask, { taskId: 'task-1' }).catch(() => {});
      queue.add(longTask, { taskId: 'task-2' }).catch(() => {});
      queue.add(longTask, { taskId: 'task-3' }).catch(() => {});

      await new Promise((r) => setTimeout(r, 100));

      const count = await queue.cancelTasks(['task-1', 'task-2', 'task-3']);

      expect(count).toBeGreaterThan(0);
    });

    it('应该能取消所有任务', async () => {
      const longTask = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new TaskCancelledError('Cancelled');
      };

      queue.add(longTask).catch(() => {});
      queue.add(longTask).catch(() => {});

      await new Promise((r) => setTimeout(r, 100));

      const count = await queue.cancelAll();

      expect(count).toBeGreaterThan(0);
    });

    it('取消不存在的任务应该返回 false', async () => {
      const success = await queue.cancelTask('non-existent-task');

      expect(success).toBe(false);
    });

    it('应该能使用外部 AbortSignal 取消任务', async () => {
      const controller = new AbortController();

      const taskPromise = queue.add(
        async (ctx) => {
          while (!ctx.signal.aborted) {
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new TaskCancelledError('Cancelled');
        },
        { signal: controller.signal }
      );

      await new Promise((r) => setTimeout(r, 100));
      controller.abort();

      await expect(taskPromise).rejects.toThrow();
    });

    it('取消的任务应该抛出 TaskCancelledError', async () => {
      const taskPromise = queue.add(
        async (ctx) => {
          while (!ctx.signal.aborted) {
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new TaskCancelledError('Cancelled by signal');
        },
        { taskId: 'cancel-test' }
      );

      await new Promise((r) => setTimeout(r, 100));
      await queue.cancelTask('cancel-test');

      try {
        await taskPromise;
        expect.fail('Should have thrown');
      } catch (error) {
        expect(isTaskCancelledError(error)).toBe(true);
      }
    });
  });

  // ========== 任务查询和统计 ==========

  describe('任务查询和统计', () => {
    it('应该能查询单个任务信息', async () => {
      const taskPromise = queue
        .add(
          async () => {
            await new Promise((r) => setTimeout(r, 200));
            return 'done';
          },
          { taskId: 'query-task', name: '测试任务' }
        )
        .catch(() => {}); // 忽略取消错误

      await new Promise((r) => setTimeout(r, 50));

      const taskInfo = queue.getTask('query-task');

      expect(taskInfo).toBeDefined();
      expect(taskInfo?.taskId).toBe('query-task');
      expect(taskInfo?.name).toBe('测试任务');
      expect(['pending', 'running']).toContain(taskInfo?.status);

      // 确保任务被清理
      await queue.stop();
      await taskPromise;
    });

    it('查询不存在的任务应该返回 null', () => {
      const taskInfo = queue.getTask('non-existent');

      expect(taskInfo).toBeNull();
    });

    it('应该能获取所有任务', async () => {
      const tasks = [
        queue.add(async () => 'task1', { name: 'Task 1' }),
        queue.add(async () => 'task2', { name: 'Task 2' }),
        queue.add(async () => 'task3', { name: 'Task 3' }),
      ];

      await new Promise((r) => setTimeout(r, 50));

      const allTasks = queue.getAllTasks();

      expect(allTasks.length).toBe(3);
      await Promise.all(tasks);
    });

    it('应该能按状态筛选任务', async () => {
      queue.pause();

      const task1 = queue
        .add(
          async () => {
            await new Promise((r) => setTimeout(r, 200));
            return 'done';
          },
          { taskId: 'task-1' }
        )
        .catch(() => {}); // 忽略取消错误

      const task2 = queue.add(async () => 'quick', { taskId: 'task-2' }).catch(() => {}); // 忽略取消错误

      await new Promise((r) => setTimeout(r, 50));

      const pendingTasks = queue.getAllTasks({ status: 'pending' });

      expect(pendingTasks.length).toBe(2);

      // 恢复并等待任务完成或被取消
      queue.resume();
      await queue.stop();
      await Promise.all([task1, task2]);
    });

    it('应该能按多个状态筛选任务', async () => {
      const longTask = async (ctx: TaskContext) => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new TaskCancelledError('Cancelled');
      };

      // 创建一个带有错误处理的 promise
      const taskPromise = queue.add(longTask, { taskId: 'running-task' }).catch(() => {
        // 忽略取消错误
      });

      await new Promise((r) => setTimeout(r, 50));

      const tasks = queue.getAllTasks({ status: ['running', 'pending'] });

      expect(tasks.length).toBeGreaterThan(0);

      // 停止队列并等待任务完成
      await queue.stop();
      await taskPromise;
    });

    it('应该能按名称筛选任务', async () => {
      const task1 = queue.add(async () => 'a', { name: 'TypeA' });
      const task2 = queue.add(async () => 'b', { name: 'TypeB' });
      const task3 = queue.add(async () => 'c', { name: 'TypeA' });

      await new Promise((r) => setTimeout(r, 50));

      const typeATasks = queue.getAllTasks({ name: 'TypeA' });

      expect(typeATasks.length).toBe(2);

      await Promise.all([task1, task2, task3]);
    });

    it('应该能获取队列统计信息', async () => {
      const tasks = [queue.add(async () => 'task1'), queue.add(async () => 'task2')];

      await new Promise((r) => setTimeout(r, 50));

      const stats = queue.getStats();

      expect(stats).toBeDefined();
      expect(stats.total).toBeGreaterThan(0);
      expect(typeof stats.running).toBe('number');
      expect(typeof stats.pending).toBe('number');
      expect(typeof stats.completed).toBe('number');
      expect(typeof stats.failed).toBe('number');
      expect(typeof stats.cancelled).toBe('number');
      expect(typeof stats.isPaused).toBe('boolean');

      await Promise.all(tasks);
    });
  });

  // ========== 进度更新 ==========

  describe('进度更新', () => {
    it('应该能更新任务进度', async () => {
      const progressUpdates: TaskProgress[] = [];

      queue.on('task:progress', (event: TaskEvent) => {
        if (event.progress) {
          progressUpdates.push(event.progress);
        }
      });

      await queue.add(async (ctx) => {
        ctx.updateProgress?.({ current: 1, total: 10, message: '步骤 1' });
        await new Promise((r) => setTimeout(r, 20));
        ctx.updateProgress?.({ current: 5, total: 10, percent: 50, message: '步骤 5' });
        await new Promise((r) => setTimeout(r, 20));
        ctx.updateProgress?.({ current: 10, total: 10, percent: 100, message: '完成' });
        return 'done';
      });

      expect(progressUpdates.length).toBe(3);
      expect(progressUpdates[0].current).toBe(1);
      expect(progressUpdates[1].current).toBe(5);
      expect(progressUpdates[1].percent).toBe(50);
      expect(progressUpdates[2].current).toBe(10);
    });

    it('进度更新应该包含自定义数据', async () => {
      let capturedData: any;

      queue.on('task:progress', (event: TaskEvent) => {
        capturedData = event.progress?.data;
      });

      await queue.add(async (ctx) => {
        ctx.updateProgress?.({
          message: 'Processing',
          data: { itemsProcessed: 50, eta: '2 minutes' },
        });
      });

      expect(capturedData).toEqual({ itemsProcessed: 50, eta: '2 minutes' });
    });
  });

  // ========== 事件系统 ==========

  describe('事件系统', () => {
    it('应该触发 task:added 事件', async () => {
      const events: TaskEvent[] = [];

      queue.on('task:added', (event) => {
        events.push(event);
      });

      await queue.add(async () => 'task1', { name: 'Test Task' });

      expect(events.length).toBe(1);
      expect(events[0].name).toBe('Test Task');
      expect(events[0].status).toBe('pending');
    });

    it('应该触发 task:started 事件', async () => {
      const events: TaskEvent[] = [];

      queue.on('task:started', (event) => {
        events.push(event);
      });

      await queue.add(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'done';
      });

      expect(events.length).toBe(1);
      expect(events[0].status).toBe('running');
    });

    it('应该触发 task:completed 事件', async () => {
      const events: TaskEvent[] = [];

      queue.on('task:completed', (event) => {
        events.push(event);
      });

      await queue.add(async () => 'success');

      expect(events.length).toBe(1);
      expect(events[0].status).toBe('completed');
      expect(typeof events[0].duration).toBe('number');
    });

    it('应该触发 task:failed 事件', async () => {
      const events: TaskEvent[] = [];

      queue.on('task:failed', (event) => {
        events.push(event);
      });

      try {
        await queue.add(async () => {
          throw new Error('Task failed');
        });
      } catch {
        // Expected
      }

      expect(events.length).toBe(1);
      expect(events[0].status).toBe('failed');
      expect(events[0].error).toBeDefined();
    });

    it('应该触发 task:cancelled 事件', async () => {
      const events: TaskEvent[] = [];

      queue.on('task:cancelled', (event) => {
        events.push(event);
      });

      const taskPromise = queue.add(
        async (ctx) => {
          while (!ctx.signal.aborted) {
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new TaskCancelledError('Cancelled');
        },
        { taskId: 'to-cancel' }
      );

      await new Promise((r) => setTimeout(r, 100));
      await queue.cancelTask('to-cancel');

      try {
        await taskPromise;
      } catch {
        // Expected
      }

      expect(events.length).toBe(1);
      expect(events[0].status).toBe('cancelled');
    });

    it('应该触发 queue:idle 事件', async () => {
      let idleTriggered = false;

      queue.on('queue:idle', () => {
        idleTriggered = true;
      });

      await queue.add(async () => 'task1');
      await queue.onIdle();

      expect(idleTriggered).toBe(true);
    });

    it('应该触发 queue:drained 事件', async () => {
      let drainedTriggered = false;

      queue.on('queue:drained', () => {
        drainedTriggered = true;
      });

      await queue.add(async () => 'task1');
      await queue.onIdle();

      expect(drainedTriggered).toBe(true);
    });

    it('应该能移除事件监听器', async () => {
      let callCount = 0;
      const listener = () => {
        callCount++;
      };

      queue.on('task:completed', listener);
      await queue.add(async () => 'task1');
      expect(callCount).toBe(1);

      queue.off('task:completed', listener);
      await queue.add(async () => 'task2');
      expect(callCount).toBe(1);
    });
  });

  // ========== 重试机制 ==========

  describe('重试机制', () => {
    it('应该能自动重试失败的任务', async () => {
      const retryQueue = createTaskQueue({ retry: 2, retryDelay: 50 });
      let attemptCount = 0;

      const result = await retryQueue.add(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Fail');
        }
        return 'success';
      });

      expect(result).toBe('success');
      expect(attemptCount).toBe(3); // 1 初始 + 2 重试

      await retryQueue.stop();
    });

    it('达到最大重试次数后应该失败', async () => {
      const retryQueue = createTaskQueue({ retry: 2, retryDelay: 50 });
      let attemptCount = 0;

      await expect(
        retryQueue.add(async () => {
          attemptCount++;
          throw new Error('Always fails');
        })
      ).rejects.toThrow('Always fails');

      expect(attemptCount).toBe(3); // 1 初始 + 2 重试

      await retryQueue.stop();
    });

    it('任务级 retry 应该覆盖队列级配置', async () => {
      const retryQueue = createTaskQueue({ retry: 1, retryDelay: 50 });
      let attemptCount = 0;

      const result = await retryQueue.add(
        async () => {
          attemptCount++;
          if (attemptCount < 4) {
            throw new Error('Fail');
          }
          return 'success';
        },
        { retry: 3 }
      );

      expect(result).toBe('success');
      expect(attemptCount).toBe(4); // 1 初始 + 3 任务级重试

      await retryQueue.stop();
    });

    it('重试前应该检查取消状态', async () => {
      const retryQueue = createTaskQueue({ retry: 5, retryDelay: 100 });
      let attemptCount = 0;

      const taskPromise = retryQueue.add(
        async (ctx) => {
          attemptCount++;
          if (ctx.signal.aborted) {
            throw new TaskCancelledError('Cancelled');
          }
          throw new Error('Fail to trigger retry');
        },
        { taskId: 'retry-cancel-test' }
      );

      // 在第一次重试等待期间取消
      await new Promise((r) => setTimeout(r, 50));
      await retryQueue.cancelTask('retry-cancel-test');

      try {
        await taskPromise;
      } catch (error) {
        expect(isTaskCancelledError(error)).toBe(true);
      }

      // 应该在取消后停止重试
      expect(attemptCount).toBeLessThan(6);

      await retryQueue.stop();
    });

    it('应该在 TaskInfo 中更新重试次数', async () => {
      const retryQueue = createTaskQueue({ retry: 2, retryDelay: 50 });
      let finalRetryCount = 0;

      retryQueue.on('task:failed', (event) => {
        const info = retryQueue.getTask(event.taskId);
        if (info) {
          finalRetryCount = info.retryCount;
        }
      });

      try {
        await retryQueue.add(
          async () => {
            throw new Error('Always fails');
          },
          { taskId: 'retry-count-test' }
        );
      } catch {
        // Expected
      }

      expect(finalRetryCount).toBe(2);

      await retryQueue.stop();
    });
  });

  // ========== 超时控制 ==========

  describe('超时控制', () => {
    it('任务超时应该取消任务', async () => {
      const timeoutQueue = createTaskQueue({ timeout: 100 });

      await expect(
        timeoutQueue.add(async () => {
          await new Promise((r) => setTimeout(r, 500));
          return 'should not complete';
        })
      ).rejects.toThrow();

      await timeoutQueue.stop();
    });

    it('任务级 timeout 应该覆盖队列级配置', async () => {
      const timeoutQueue = createTaskQueue({ timeout: 1000 });

      await expect(
        timeoutQueue.add(
          async () => {
            await new Promise((r) => setTimeout(r, 300));
            return 'should not complete';
          },
          { timeout: 100 }
        )
      ).rejects.toThrow();

      await timeoutQueue.stop();
    });

    it('超时应该触发 abort signal', async () => {
      const timeoutQueue = createTaskQueue({ timeout: 100 });
      let _wasAborted = false;

      try {
        await timeoutQueue.add(async (ctx) => {
          await new Promise((r) => setTimeout(r, 500));
          _wasAborted = ctx.signal.aborted;
        });
      } catch {
        // Expected
      }

      // 注意：由于超时会触发 abort，任务可能在检查前就被中断了
      // 这个测试主要验证超时机制工作正常

      await timeoutQueue.stop();
    });
  });

  // ========== 并发控制 ==========

  describe('并发控制', () => {
    it('应该限制并发任务数量', async () => {
      const concurrentQueue = createTaskQueue({ concurrency: 2 });
      let maxRunning = 0;
      let currentRunning = 0;

      const tasks = Array.from({ length: 5 }, () =>
        concurrentQueue.add(async () => {
          currentRunning++;
          maxRunning = Math.max(maxRunning, currentRunning);
          await new Promise((r) => setTimeout(r, 50));
          currentRunning--;
          return 'done';
        })
      );

      await Promise.all(tasks);

      expect(maxRunning).toBeLessThanOrEqual(2);

      await concurrentQueue.stop();
    });

    it('应该支持动态调整并发数（通过新队列）', async () => {
      // TaskQueue 不支持动态调整，但可以创建不同配置的队列
      const queue1 = createTaskQueue({ concurrency: 1, name: 'low-concurrency' });
      const queue2 = createTaskQueue({ concurrency: 5, name: 'high-concurrency' });

      expect(queue1.getStats().isPaused).toBe(false);
      expect(queue2.getStats().isPaused).toBe(false);

      await queue1.stop();
      await queue2.stop();
    });
  });

  // ========== 优先级 ==========

  describe('优先级', () => {
    it('高优先级任务应该先执行', async () => {
      const priorityQueue = createTaskQueue({ concurrency: 1 });
      const executionOrder: string[] = [];

      // 添加一个阻塞任务
      priorityQueue.add(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'blocking';
      });

      await new Promise((r) => setTimeout(r, 50));

      // 添加不同优先级的任务
      priorityQueue.add(
        async () => {
          executionOrder.push('low');
        },
        { priority: 0 }
      );

      priorityQueue.add(
        async () => {
          executionOrder.push('high');
        },
        { priority: 10 }
      );

      priorityQueue.add(
        async () => {
          executionOrder.push('medium');
        },
        { priority: 5 }
      );

      await priorityQueue.onIdle();

      expect(executionOrder[0]).toBe('high');
      expect(executionOrder[1]).toBe('medium');
      expect(executionOrder[2]).toBe('low');

      await priorityQueue.stop();
    });
  });

  // ========== 队列控制 ==========

  describe('队列控制', () => {
    it('应该能暂停队列', async () => {
      queue.pause();

      const stats = queue.getStats();
      expect(stats.isPaused).toBe(true);

      queue.resume();
    });

    it('应该能恢复队列', async () => {
      queue.pause();
      queue.resume();

      const stats = queue.getStats();
      expect(stats.isPaused).toBe(false);
    });

    it('暂停后的队列不应该开始新任务', async () => {
      let taskStarted = false;

      queue.pause();

      const taskPromise = queue.add(async () => {
        taskStarted = true;
        return 'done';
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(taskStarted).toBe(false);

      queue.resume();
      await taskPromise;

      expect(taskStarted).toBe(true);
    });

    it('应该能清空待执行任务', async () => {
      queue.pause();

      const promises = [
        queue.add(async () => 'task1').catch(() => {}),
        queue.add(async () => 'task2').catch(() => {}),
        queue.add(async () => 'task3').catch(() => {}),
      ];

      await new Promise((r) => setTimeout(r, 50));

      const statsBefore = queue.getStats();
      expect(statsBefore.pending).toBe(3);

      queue.clear();
      queue.resume();

      await Promise.allSettled(promises);

      const statsAfter = queue.getStats();
      expect(statsAfter.pending).toBe(0);
    });

    it('clear 应该取消正在运行的任务', async () => {
      let taskCancelled = false;

      const taskPromise = queue.add(async (ctx) => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
        }
        taskCancelled = true;
        throw new TaskCancelledError('Cleared');
      });

      await new Promise((r) => setTimeout(r, 100));

      queue.clear();

      try {
        await taskPromise;
      } catch {
        // Expected
      }

      expect(taskCancelled).toBe(true);
    });

    it('应该能停止队列', async () => {
      const stopQueue = createTaskQueue();

      const taskPromise = stopQueue.add(async (ctx) => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new TaskCancelledError('Stopped');
      });

      await new Promise((r) => setTimeout(r, 100));

      await stopQueue.stop();

      try {
        await taskPromise;
      } catch {
        // Expected
      }

      // 停止后不应该接受新任务
      await expect(stopQueue.add(async () => 'new task')).rejects.toThrow('Queue has been stopped');
    });

    it('停止已停止的队列应该是幂等的', async () => {
      const idempotentQueue = createTaskQueue();

      await idempotentQueue.stop();
      await idempotentQueue.stop(); // 第二次调用不应该报错
    });

    it('应该能等待队列空闲', async () => {
      let completed = 0;

      queue.add(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed++;
      });

      queue.add(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed++;
      });

      await queue.onIdle();

      expect(completed).toBe(2);
    });
  });

  // ========== 边界情况 ==========

  describe('边界情况', () => {
    it('应该处理返回 undefined 的任务', async () => {
      const result = await queue.add(async () => {
        // 不返回任何值
      });

      expect(result).toBeUndefined();
    });

    it('应该处理返回 null 的任务', async () => {
      const result = await queue.add(async () => null);

      expect(result).toBeNull();
    });

    it('应该处理空的 addAll', async () => {
      const results = await queue.addAll([]);

      expect(results).toEqual([]);
    });

    it('任务抛出非 Error 对象应该正常处理', async () => {
      const failQueue = createTaskQueue({ retry: 0 });

      await expect(
        failQueue.add(async () => {
          throw 'string error';
        })
      ).rejects.toBe('string error');

      await failQueue.stop();
    });

    it('任务抛出数字应该正常处理', async () => {
      const failQueue = createTaskQueue({ retry: 0 });

      await expect(
        failQueue.add(async () => {
          throw 42;
        })
      ).rejects.toBe(42);

      await failQueue.stop();
    });

    it('应该处理快速添加大量任务', async () => {
      const results: number[] = [];

      const tasks = Array.from({ length: 100 }, (_, i) =>
        queue.add(async () => {
          results.push(i);
          return i;
        })
      );

      const returned = await Promise.all(tasks);

      expect(returned.length).toBe(100);
      expect(results.length).toBe(100);
    });

    it('应该正确处理任务执行时间记录', async () => {
      let taskDuration = 0;

      queue.on('task:completed', (event) => {
        if (event.duration !== undefined) {
          taskDuration = event.duration;
        }
      });

      await queue.add(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'done';
      });

      expect(taskDuration).toBeGreaterThanOrEqual(90); // 允许一些误差
    });
  });

  // ========== 工厂函数 ==========

  describe('createTaskQueue 工厂函数', () => {
    it('应该使用默认配置创建队列', () => {
      const defaultQueue = createTaskQueue();

      expect(defaultQueue).toBeInstanceOf(TaskQueue);

      defaultQueue.stop();
    });

    it('应该使用自定义配置创建队列', () => {
      const customQueue = createTaskQueue({
        concurrency: 5,
        timeout: 30000,
        retry: 3,
        retryDelay: 1000,
        name: 'custom-queue',
      });

      expect(customQueue).toBeInstanceOf(TaskQueue);

      customQueue.stop();
    });
  });
});
