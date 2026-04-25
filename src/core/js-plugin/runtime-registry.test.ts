import { describe, expect, it, vi } from 'vitest';
import { createTaskQueue } from '../task-manager';
import { PluginRuntimeRegistry } from './runtime-registry';

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 20;
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('PluginRuntimeRegistry', () => {
  it('tracks lifecycle transitions for a plugin', () => {
    const registry = new PluginRuntimeRegistry();
    const listener = vi.fn();
    registry.on('status-changed', listener);

    registry.setLifecyclePhase('plugin-a', 'starting', 'Plugin A');
    registry.setLifecyclePhase('plugin-a', 'active', 'Plugin A');

    expect(registry.getStatus('plugin-a')).toMatchObject({
      pluginId: 'plugin-a',
      pluginName: 'Plugin A',
      lifecyclePhase: 'active',
      workState: 'idle',
      activeQueues: 0,
      runningTasks: 0,
      pendingTasks: 0,
    });
    expect(listener).toHaveBeenCalled();
  });

  it('aggregates queue execution state and progress', async () => {
    const registry = new PluginRuntimeRegistry();
    const queue = createTaskQueue({ concurrency: 1, retry: 0 });

    let releaseTask = () => {};
    const blocker = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    registry.registerQueue('plugin-a', 'queue-1', queue, 'Plugin A');
    const taskPromise = queue.add(
      async (ctx) => {
        ctx.updateProgress?.({ current: 1, total: 2, message: '步骤 1' });
        await blocker;
        return 'done';
      },
      { taskId: 'task-1', name: '批量同步' }
    );

    await waitForCondition(() => (registry.getStatus('plugin-a')?.runningTasks ?? 0) === 1);

    expect(registry.getStatus('plugin-a')).toMatchObject({
      pluginId: 'plugin-a',
      pluginName: 'Plugin A',
      activeQueues: 1,
      runningTasks: 1,
      pendingTasks: 0,
      workState: 'busy',
      currentOperation: '批量同步',
      progressPercent: 50,
    });
    expect(registry.getStatus('plugin-a')?.currentSummary).toContain('步骤 1');

    releaseTask();
    await taskPromise;
    await queue.onIdle();
    await waitForCondition(() => (registry.getStatus('plugin-a')?.runningTasks ?? -1) === 0);

    expect(registry.getStatus('plugin-a')).toMatchObject({
      activeQueues: 1,
      runningTasks: 0,
      pendingTasks: 0,
      workState: 'idle',
    });

    await queue.stop();
  });

  it('records task failures and emits removed event when plugin is deleted', async () => {
    const registry = new PluginRuntimeRegistry();
    const queue = createTaskQueue({ concurrency: 1, retry: 0 });
    const listener = vi.fn();
    registry.on('status-changed', listener);

    registry.registerQueue('plugin-a', 'queue-1', queue, 'Plugin A');

    await expect(
      queue.add(
        async () => {
          throw new Error('boom');
        },
        { taskId: 'task-1', name: '失败任务' }
      )
    ).rejects.toThrow('boom');

    await waitForCondition(() => (registry.getStatus('plugin-a')?.failedTasks ?? 0) === 1);

    expect(registry.getStatus('plugin-a')).toMatchObject({
      workState: 'error',
      failedTasks: 1,
    });
    expect(registry.getStatus('plugin-a')?.lastError?.message).toBe('boom');

    await queue.stop();
    registry.removePlugin('plugin-a');

    expect(registry.getStatus('plugin-a')).toBeNull();
    expect(listener).toHaveBeenLastCalledWith({
      pluginId: 'plugin-a',
      removed: true,
      status: null,
    });
  });
});
