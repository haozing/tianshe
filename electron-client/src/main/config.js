const path = require("node:path");
const { app } = require("electron");

const ROOT = path.resolve(__dirname, "../..");
const SRC_ROOT = path.join(ROOT, "src");

const APP_NAME = "赤狐管家";
const APP_TITLE = `${APP_NAME} V${app.getVersion()}`;
const DEFAULT_PARTITION = "persist:chihu-default";
const APP_WINDOW = {
  defaultWidth: Number(process.env.CHIHU_WINDOW_WIDTH || 1480),
  defaultHeight: Number(process.env.CHIHU_WINDOW_HEIGHT || 920),
  minWidth: Number(process.env.CHIHU_WINDOW_MIN_WIDTH || 1480),
  minHeight: Number(process.env.CHIHU_WINDOW_MIN_HEIGHT || 920),
  resizable: process.env.CHIHU_WINDOW_RESIZABLE === "0" ? false : true
};

const DEFAULT_REMOTE_WEB_URL = "http://chihu.facaishe.cn/remote-web/current/new-remote-web/index.html";

const HOME_INDEX_URL =
  process.env.CHIHU_HOME_URL ||
  process.env.CHIHU_REMOTE_WEB_URL ||
  DEFAULT_REMOTE_WEB_URL;

const HOME_PRELOAD = path.join(SRC_ROOT, "preload", "index.js");
const ICON_PATH = path.join(ROOT, "assets", "icon-chihu.png");

module.exports = {
  ROOT,
  SRC_ROOT,
  APP_NAME,
  APP_TITLE,
  APP_WINDOW,
  DEFAULT_PARTITION,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH,
  DEFAULT_REMOTE_WEB_URL
};
