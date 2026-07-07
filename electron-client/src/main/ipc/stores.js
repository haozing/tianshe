const { ipcMain } = require("electron");
const { createDoudianStoreService } = require("../doudian/service");

const STORE_CONTRACT_VERSION = "stores.v1";

function registerStoreHandlers() {
  const service = createDoudianStoreService();
  const operations = new Map();

  function contractMeta(args = {}, result = {}, operation = null) {
    const payload = args.doudianAdapter && typeof args.doudianAdapter === "object" ? args.doudianAdapter : null;
    const adapter = operation?.doudianAdapter || payload?.adapter || args.adapter || null;
    const scripts = payload?.scripts || adapter?.scripts || {};
    return {
      contractVersion: STORE_CONTRACT_VERSION,
      adapterVersion: result.adapterVersion || adapter?.version || "",
      scriptsVersion: result.scriptsVersion || scripts?.version || ""
    };
  }

  function withContract(result, args = {}, operation = null) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    return {
      ...contractMeta(args, result, operation),
      ...result
    };
  }

  function createOperation(args = {}) {
    const operationId = String(args.operationId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const operation = {
      id: operationId,
      cancelled: false,
      windows: new Set()
    };
    operations.set(operationId, operation);
    return operation;
  }

  function finishOperation(operation) {
    if (!operation?.id) return;
    operations.delete(operation.id);
  }

  function cancelOperation(operationId) {
    const operation = operations.get(String(operationId || ""));
    if (!operation) return { ok: false, status: "not-found", message: "未找到正在执行的店铺任务" };
    operation.cancelled = true;
    for (const win of operation.windows) {
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {}
    }
    return { ok: true, status: "cancelled", message: "已取消店铺任务" };
  }

  ipcMain.handle("stores:list", async (_event, args = {}) => {
    return withContract(await service.listStores(args), args);
  });

  ipcMain.handle("stores:fetch", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.fetchStores(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:refreshStatus", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.refreshStatus(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:businessData", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.fetchBusinessData(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:businessDataLatest", async (_event, args = {}) => {
    return withContract(await service.latestBusinessData(args), args);
  });

  ipcMain.handle("stores:fundsData", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.fetchFundsData(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:fundsDataLatest", async (_event, args = {}) => {
    return withContract(await service.latestFundsData(args), args);
  });

  ipcMain.handle("stores:violationsData", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.fetchViolationsData(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:violationsDataLatest", async (_event, args = {}) => {
    return withContract(await service.latestViolationsData(args), args);
  });

  ipcMain.handle("stores:staleGoodsCleanup", async (event, args = {}) => {
    const operation = createOperation(args);
    try {
      const result = await service.staleGoodsCleanup(args, (detail) => {
        event.sender.send("chihu-stores-progress", { ...contractMeta(args, detail, operation), ...detail, operationId: operation.id });
      }, operation);
      return withContract(result, args, operation);
    } finally {
      finishOperation(operation);
    }
  });

  ipcMain.handle("stores:cancel", async (_event, args = {}) => {
    return withContract(cancelOperation(args.operationId), args);
  });

  ipcMain.handle("stores:open", async (_event, args = {}) => {
    return withContract(await service.openStore(args), args);
  });

  ipcMain.handle("stores:delete", async (_event, args = {}) => {
    return withContract(await service.deleteStores(args), args);
  });

  ipcMain.handle("stores:updateGroup", async (_event, args = {}) => {
    return withContract(await service.updateGroup(args), args);
  });
}

module.exports = { STORE_CONTRACT_VERSION, registerStoreHandlers };
