import { describe, expect, it, vi } from 'vitest';
import { assertMainWindowIpcSender } from './ipc-authorization';

describe('IPC authorization', () => {
  it('accepts the main window webContents sender', () => {
    const webContents = { id: 1, isDestroyed: vi.fn(() => false) };
    expect(() =>
      assertMainWindowIpcSender(
        { sender: webContents } as any,
        { webContents } as any,
        'test:channel'
      )
    ).not.toThrow();
  });

  it('rejects a different sender', () => {
    const webContents = { id: 1, isDestroyed: vi.fn(() => false) };
    expect(() =>
      assertMainWindowIpcSender(
        { sender: { id: 2 } } as any,
        { webContents } as any,
        'test:channel'
      )
    ).toThrow(/Unauthorized IPC sender/);
  });
});
