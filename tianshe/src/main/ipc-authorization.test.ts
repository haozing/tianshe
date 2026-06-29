import { describe, expect, it, vi } from 'vitest';
import { assertMainWindowIpcSender, createMainWindowIpcSenderGuard } from './ipc-authorization';

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

  it('creates a sender guard from an explicit main window provider', () => {
    const webContents = { id: 1, isDestroyed: vi.fn(() => false) };
    const guard = createMainWindowIpcSenderGuard(() => ({ webContents }) as any);

    expect(() => guard({ sender: webContents } as any, 'test:channel')).not.toThrow();
  });

  it('fails clearly when the main window has not been created', () => {
    const guard = createMainWindowIpcSenderGuard(() => null);

    expect(() => guard({ sender: { id: 1 } } as any, 'test:channel')).toThrow(
      'Main window not created'
    );
  });
});
