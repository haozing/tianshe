const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const preloadPath = path.join(root, "src", "preload", "index.js");
const ipcRoot = path.join(root, "src", "main", "ipc");
const mainPath = path.join(root, "src", "main", "index.js");
const { expectedClientMethods } = require("./client-contract-baseline");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function collectJs(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) files.push(...collectJs(fullPath));
    else if (fullPath.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const preload = read(preloadPath);
const mainAndIpc = [mainPath, ...collectJs(ipcRoot)].map(read).join("\n");

const failures = [];
for (const [method, channel] of expectedClientMethods) {
  if (!preload.includes(`${method}: invoke("${channel}")`)) {
    failures.push(`preload missing ${method} -> ${channel}`);
  }
  if (!mainAndIpc.includes(`ipcMain.handle("${channel}"`)) {
    failures.push(`ipc missing ${channel}`);
  }
}

if (failures.length) {
  console.error("CONTRACT_FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CONTRACT_OK ${expectedClientMethods.length} methods`);
