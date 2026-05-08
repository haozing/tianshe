import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';

export class UnauthorizedIpcSenderError extends Error {
  constructor(channel: string) {
    super(`Unauthorized IPC sender for channel: ${channel}`);
    this.name = 'UnauthorizedIpcSenderError';
  }
}

function isDestroyed(webContents: WebContents | undefined): boolean {
  return (
    !!webContents && typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()
  );
}

export function assertMainWindowIpcSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  channel: string
): void {
  const sender = event?.sender;
  const mainWebContents = mainWindow?.webContents;

  if (
    !sender ||
    !mainWebContents ||
    isDestroyed(mainWebContents) ||
    sender.id !== mainWebContents.id
  ) {
    throw new UnauthorizedIpcSenderError(channel);
  }
}

export function createMainWindowIpcSenderGuard(
  getMainWindow: () => BrowserWindow | null | undefined
): (event: IpcMainInvokeEvent, channel: string) => void {
  return (event, channel) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      throw new Error('Main window not created');
    }

    assertMainWindowIpcSender(event, mainWindow, channel);
  };
}
