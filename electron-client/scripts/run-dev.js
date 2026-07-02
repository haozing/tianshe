const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const electronBin = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
