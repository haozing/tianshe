const { app, ipcMain, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function getCachePartitions(appDataPath) {
  const cachePath = path.join(appDataPath, "Partitions");
  if (!fs.existsSync(cachePath)) return [];
  return fs.readdirSync(cachePath);
}

async function cleanInvalidPartitions(currentPartitons = [], prefixes = []) {
  const appDataPath = app.getPath("userData");
  const allPartitions = getCachePartitions(appDataPath);
  const valid = currentPartitons.map((item) => String(item).replace("persist:", "").toLowerCase());
  const deleted = [];

  for (const partition of allPartitions) {
    const isTarget = prefixes.some((prefix) => partition.startsWith(prefix));
    if (!isTarget || valid.includes(partition.toLowerCase())) continue;

    const partitionSession = session.fromPartition(partition);
    await partitionSession.clearCache();
    await partitionSession.clearStorageData();

    const partitionPath = path.join(appDataPath, "Partitions", partition);
    if (fs.existsSync(partitionPath)) {
      fs.rmSync(partitionPath, { recursive: true, force: true });
      deleted.push(partition);
    }
  }

  return { deleted };
}

function registerPartitionHandlers() {
  ipcMain.handle("cleanInvalidPartitions", async (_event, args = {}) => {
    return cleanInvalidPartitions(args.currentPartitons, args.prefixes);
  });
}

module.exports = { registerPartitionHandlers };

