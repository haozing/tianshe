const { BrowserWindow, ipcMain, Notification } = require("electron");
const { APP_TITLE, ICON_PATH } = require("../config");

function emitNotificationEvent(sourceWindow, args) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  sourceWindow.webContents.send("chihu-notification", {
    ...args,
    chihu_event_name: args.chihu_event_name || "notification_click"
  });
}

function registerNotificationHandlers() {
  const sendNotification = async (event, args = {}) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: args.title || APP_TITLE,
      body: args.body || "",
      icon: args.icon || ICON_PATH,
      silent: args.silent || false,
      sound: args.sound || null,
      hasReply: args.hasReply || false,
      subtitle: args.subtitle || "",
      replyPlaceholder: args.replyPlaceholder || "请输入回复内容",
      urgency: args.urgency || "normal",
      timeoutType: args.timeoutType || "default",
      closeButtonText: args.closeButtonText || "关闭"
    };

    if (process.env.CHIHU_E2E_SMOKE === "1" && args.chihu_e2e_auto_emit) {
      setTimeout(() => emitNotificationEvent(sourceWindow, args), Number(args.chihu_e2e_emitAfterMs || 0));
      if (args.chihu_e2e_skip_show) return { ok: true, e2e: true };
    }

    const notification = new Notification(options);
    notification.on("click", () => emitNotificationEvent(sourceWindow, args));
    notification.show();
    return { ok: true };
  };

  ipcMain.handle("send_notification", sendNotification);
  ipcMain.handle("native:notifications:send", sendNotification);
}

module.exports = { registerNotificationHandlers };
