import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginEventBus, PluginEvents, type PluginNotificationPayload } from '../events';
import { UINamespace } from './ui';

describe('UINamespace', () => {
  beforeEach(() => {
    pluginEventBus.clear();
  });

  afterEach(() => {
    pluginEventBus.clear();
  });

  it('emits plugin notifications for renderer toast forwarding', async () => {
    const notifications: PluginNotificationPayload[] = [];
    pluginEventBus.on(PluginEvents.NOTIFICATION, (payload) => {
      notifications.push(payload);
    });

    await new UINamespace('plugin-1').success('  Done  ');

    expect(notifications).toEqual([
      expect.objectContaining({
        pluginId: 'plugin-1',
        type: 'success',
        message: 'Done',
      }),
    ]);
    expect(notifications[0].createdAt).toEqual(expect.any(Number));
  });

  it('ignores blank notification messages', async () => {
    const notifications: PluginNotificationPayload[] = [];
    pluginEventBus.on(PluginEvents.NOTIFICATION, (payload) => {
      notifications.push(payload);
    });

    await new UINamespace('plugin-1').notify('   ');

    expect(notifications).toEqual([]);
  });
});
