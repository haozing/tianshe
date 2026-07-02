const { BrowserWindow, ipcMain, Notification } = require("electron");
const { APP_TITLE, ICON_PATH } = require("../config");

function registerNotificationHandlers() {
  ipcMain.handle("send_notification", async (event, args = {}) => {
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

    const notification = new Notification(options);
    notification.on("click", () => {
      if (!sourceWindow || sourceWindow.isDestroyed()) return;
      sourceWindow.webContents.send("zzb-notification", {
        ...args,
        zzb_event_name: args.zzb_event_name || "notification_click"
      });
    });
    notification.show();
    return { ok: true };
  });
}

module.exports = { registerNotificationHandlers };

