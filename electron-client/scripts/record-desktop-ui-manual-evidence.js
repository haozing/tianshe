const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const electronBin = require("electron");
const evidencePage = path.join(root, "manual-desktop-ui-evidence", "index.html");

const env = {
  ...process.env,
  CHIHU_HOME_URL: pathToFileURL(evidencePage).toString()
};

delete env.CHIHU_E2E_SMOKE;
delete env.CHIHU_E2E_SMOKE_SCENARIO;
delete env.ELECTRON_RUN_AS_NODE;

console.log("DESKTOP_UI_MANUAL_EVIDENCE_RECORDER");
console.log(`Opening ${env.CHIHU_HOME_URL}`);
console.log("Complete the visible checks, then close the Electron window.");

const child = spawn(electronBin, ["."], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
