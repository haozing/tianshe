const path = require("node:path");
const { app } = require("electron");

const ROOT = path.resolve(__dirname, "../..");
const SRC_ROOT = path.join(ROOT, "src");

function readPackageMetadata() {
  try {
    return require(path.join(ROOT, "package.json"));
  } catch {
    return {};
  }
}

const packageMetadata = readPackageMetadata();
const DEFAULT_RELEASE_CHANNEL =
  process.env.CHIHU_RELEASE_CHANNEL ||
  packageMetadata.chihuReleaseChannel ||
  "stable";
const APP_NAME =
  process.env.CHIHU_APP_NAME ||
  packageMetadata.productName ||
  (DEFAULT_RELEASE_CHANNEL === "beta" ? "赤狐管家内测" : "赤狐管家");
const APP_TITLE = `${APP_NAME} V${app.getVersion()}`;
const DATA_EPOCH = "freemium-v2";
const DEFAULT_PARTITION = "persist:chihu-default";
const APP_WINDOW = {
  defaultWidth: Number(process.env.CHIHU_WINDOW_WIDTH || 1480),
  defaultHeight: Number(process.env.CHIHU_WINDOW_HEIGHT || 920),
  minWidth: Number(process.env.CHIHU_WINDOW_MIN_WIDTH || 1480),
  minHeight: Number(process.env.CHIHU_WINDOW_MIN_HEIGHT || 920),
  resizable: process.env.CHIHU_WINDOW_RESIZABLE === "0" ? false : true
};

const DEFAULT_REMOTE_WEB_URL = "http://chihu.facaishe.cn/remote-web/releases/2026.07.20.freemium-v2/new-remote-web/index.html";
const BETA_REMOTE_WEB_URL = "http://chihu.facaishe.cn/remote-web/beta/releases/2026.07.20.freemium-v2/new-remote-web/index.html";
const DEFAULT_UPDATE_CHANNEL = process.env.CHIHU_UPDATE_CHANNEL || (DEFAULT_RELEASE_CHANNEL === "beta" ? "beta" : "latest");

const HOME_INDEX_URL =
  process.env.CHIHU_HOME_URL ||
  process.env.CHIHU_REMOTE_WEB_URL ||
  (DEFAULT_RELEASE_CHANNEL === "beta" ? BETA_REMOTE_WEB_URL : DEFAULT_REMOTE_WEB_URL);

const HOME_PRELOAD = path.join(SRC_ROOT, "preload", "index.js");
const ICON_PATH = path.join(ROOT, "assets", "icon-chihu.png");

module.exports = {
  ROOT,
  SRC_ROOT,
  APP_NAME,
  APP_TITLE,
  DATA_EPOCH,
  APP_WINDOW,
  DEFAULT_PARTITION,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH,
  DEFAULT_REMOTE_WEB_URL,
  BETA_REMOTE_WEB_URL,
  DEFAULT_RELEASE_CHANNEL,
  DEFAULT_UPDATE_CHANNEL
};
