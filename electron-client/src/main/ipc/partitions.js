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
  const valid = currentPartitons.map((item) => String(item).replace(/^persist:/i, "").toLowerCase());
  const normalizedPrefixes = prefixes
    .map((item) => String(item || "").replace(/^persist:/i, "").toLowerCase())
    .filter(Boolean);
  const deleted = [];
  const pending = [];

  for (const partition of allPartitions) {
    const normalizedPartition = partition.toLowerCase();
    const isTarget = normalizedPrefixes.some((prefix) => normalizedPartition.startsWith(prefix));
    if (!isTarget || valid.includes(partition.toLowerCase())) continue;

    const partitionSession = session.fromPartition(partition);
    await partitionSession.clearCache();
    await partitionSession.clearStorageData();

    const partitionPath = path.join(appDataPath, "Partitions", partition);
    if (fs.existsSync(partitionPath)) {
      try {
        fs.rmSync(partitionPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
        deleted.push(partition);
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
        pending.push(partition);
      }
    }
  }

  return { deleted, pending };
}

function registerPartitionHandlers() {
  ipcMain.handle("cleanInvalidPartitions", async (_event, args = {}) => {
    return cleanInvalidPartitions(args.currentPartitons, args.prefixes);
  });

  ipcMain.handle("native:partitions:cleanInvalid", async (_event, args = {}) => {
    return cleanInvalidPartitions(args.currentPartitons || args.currentPartitions, args.prefixes);
  });
}

module.exports = { registerPartitionHandlers };
