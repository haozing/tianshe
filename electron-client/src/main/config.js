const path = require("node:path");
const { app } = require("electron");

const ROOT = path.resolve(__dirname, "../..");
const SRC_ROOT = path.join(ROOT, "src");

const APP_TITLE = `小尊宝工具箱 V${app.getVersion()}`;
const DEFAULT_PARTITION = "persist:myappzzbtool";

const LOCAL_OLD_ENTRY_URL = "http://127.0.0.1:4173/old-entry/";
const LEGACY_REMOTE_ENTRY_URL = "https://apptool.zzbtool.com";

const HOME_INDEX_URL =
  process.env.XZB_HOME_URL ||
  process.env.OLD_REMOTE_ENTRY ||
  (process.env.XZB_USE_LOCAL_REMOTE === "0" ? LEGACY_REMOTE_ENTRY_URL : LOCAL_OLD_ENTRY_URL);

const HOME_PRELOAD = path.join(SRC_ROOT, "preload", "index.js");
const ICON_PATH = path.join(ROOT, "assets", "icon.png");

module.exports = {
  ROOT,
  SRC_ROOT,
  APP_TITLE,
  DEFAULT_PARTITION,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH,
  LEGACY_REMOTE_ENTRY_URL,
  LOCAL_OLD_ENTRY_URL
};

