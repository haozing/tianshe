const { app, screen, ipcMain } = require("electron");
const {
  APP_TITLE,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH
} = require("../config");

function safeGetPath(name) {
  try {
    return app.getPath(name);
  } catch {
    return "";
  }
}

function registerAppInfoHandlers() {
  ipcMain.handle("app_info", async () => {
    const displays = screen.getAllDisplays();
    const targetDisplay = displays[0] || { size: { width: 0, height: 0 } };
    const { width, height } = targetDisplay.size;

    return {
      systemLocale: app.getLocale(),
      version: app.getVersion(),
      name: app.getName(),
      path: app.getAppPath(),
      userData: safeGetPath("userData"),
      temp: safeGetPath("temp"),
      home: safeGetPath("home"),
      desktop: safeGetPath("desktop"),
      documents: safeGetPath("documents"),
      downloads: safeGetPath("downloads"),
      music: safeGetPath("music"),
      pictures: safeGetPath("pictures"),
      videos: safeGetPath("videos"),
      exe: safeGetPath("exe"),
      appData: safeGetPath("appData"),
      logs: safeGetPath("logs"),
      recent: safeGetPath("recent"),
      width,
      height,
      title: APP_TITLE,
      icon: ICON_PATH,
      preload: HOME_PRELOAD,
      index: HOME_INDEX_URL
    };
  });
}

module.exports = { registerAppInfoHandlers };

