const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const electronBin = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CHIHU_HOME_URL = env.CHIHU_HOME_URL || env.CHIHU_REMOTE_WEB_URL || "http://127.0.0.1:4173/new-remote-web/";

const child = spawn(electronBin, ["."], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
