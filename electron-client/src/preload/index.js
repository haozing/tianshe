const { contextBridge, ipcRenderer } = require("electron");
const { createHash, randomUUID } = require("node:crypto");

function invoke(channel) {
  return (message) => ipcRenderer.invoke(channel, message);
}

const INLINE_NATIVE_RECORD_BYTES = 5 * 1024 * 1024;
const LARGE_NATIVE_RECORD_CHUNK_CHARS = 512 * 1024;

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function nativeRecordIdFor(recordOrId) {
  if (recordOrId && typeof recordOrId === "object") {
    return String(
      recordOrId.id ||
      recordOrId.recordId ||
      recordOrId.runId ||
      recordOrId.operationId ||
      recordOrId.attemptId ||
      recordOrId.candidateId ||
      recordOrId.shopId ||
      recordOrId.groupId ||
      ""
    ).trim();
  }
  return String(recordOrId || "").trim();
}

async function putNativeDataRecord(args = {}) {
  const inlinePut = invoke("native:data:records:put");
  const record = args.record || args.payload || args.value;
  let payloadJson = "";
  try {
    payloadJson = JSON.stringify(record);
  } catch {
    return inlinePut(args);
  }

  if (!payloadJson || utf8ByteLength(payloadJson) <= INLINE_NATIVE_RECORD_BYTES) {
    return inlinePut(args);
  }

  const storeName = String(args.storeName || args.store || "").trim();
  const recordId = nativeRecordIdFor(record);
  if (!storeName || !recordId) return inlinePut(args);

  const chunks = [];
  for (let index = 0; index < payloadJson.length; index += LARGE_NATIVE_RECORD_CHUNK_CHARS) {
    chunks.push(payloadJson.slice(index, index + LARGE_NATIVE_RECORD_CHUNK_CHARS));
  }

  const sessionId = randomUUID();
  const expectedBytes = utf8ByteLength(payloadJson);
  const expectedHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");
  const start = invoke("native:data:records:putLarge:start");
  const writeChunk = invoke("native:data:records:putLarge:chunk");
  const commit = invoke("native:data:records:putLarge:commit");
  const abort = invoke("native:data:records:putLarge:abort");

  let started = false;
  try {
    await start({ sessionId, storeName, recordId, expectedBytes, expectedChunks: chunks.length, expectedHash });
    started = true;
    for (let index = 0; index < chunks.length; index += 1) {
      await writeChunk({ sessionId, index, chunk: chunks[index] });
    }
    return await commit({ sessionId });
  } catch (error) {
    if (started) {
      try {
        await abort({ sessionId });
      } catch {}
    }
    throw error;
  }
}

function configuredBlockedSchemes() {
  return String(process.env.CHIHU_BLOCKED_EXTERNAL_SCHEMES || "")
    .split(",")
    .map((scheme) => scheme.trim().toLowerCase().replace(/:$/, ""))
    .filter(Boolean)
    .map((scheme) => `${scheme}:`);
}

function installSchemeBlocker() {
  const blockedSchemes = configuredBlockedSchemes();
  if (!blockedSchemes.length) return;

  const isBlockedScheme = (url) => {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase().trim();
    return blockedSchemes.some((scheme) => lower.startsWith(scheme));
  };

  try {
    const originalOpen = window.open;
    window.open = function (url, ...args) {
      if (isBlockedScheme(url)) return null;
      return originalOpen.call(window, url, ...args);
    };

    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName) {
      const element = originalCreateElement(tagName);
      if (String(tagName).toLowerCase() !== "a") return element;

      const originalSetAttribute = element.setAttribute.bind(element);
      element.setAttribute = function (name, value) {
        if (String(name).toLowerCase() === "href" && isBlockedScheme(value)) return;
        return originalSetAttribute(name, value);
      };

      return element;
    };
  } catch (error) {
    console.warn("[preload] scheme blocker failed:", error);
  }
}

installSchemeBlocker();

const client = {
  get_cookies: invoke("get_cookies"),
  set_cookies: invoke("set_cookies"),
  copy_cookies: invoke("copy_cookies"),
  clear_session: invoke("clear_session"),
  http: invoke("http"),
  uploadFile: invoke("uploadFile"),
  openWindow: invoke("openWindow"),
  closeWindow: invoke("closeWindow"),
  editBrowserWindow: invoke("editBrowserWindow"),
  getBrowserWindowInfo: invoke("getBrowserWindowInfo"),
  destroyBrowserWindow: invoke("destroyBrowserWindow"),
  executeJavaScriptBrowserWindow: invoke("executeJavaScriptBrowserWindow"),
  reloadHomeUrl: invoke("reloadHomeUrl"),
  sendNotification: invoke("send_notification"),
  getMainWindowInfo: invoke("getMainWindowInfo"),
  resetMainWindow: invoke("resetMainWindow"),
  getAllBrowserWindowInfos: invoke("getAllBrowserWindowInfos"),
  getAppInfo: invoke("app_info"),
  startAutoUpdate: invoke("startAutoUpdate"),
  cleanInvalidPartitions: invoke("cleanInvalidPartitions"),
  minimizeWindow: invoke("minimizeWindow"),
  maximizeWindow: invoke("maximizeWindow"),
  isWindowMaximized: invoke("isWindowMaximized"),
  isWindowDestroyed: invoke("isWindowDestroyed"),
  getClientVersionData: invoke("getClientVersionData"),
  reportClientLog: invoke("reportClientLog"),
  getCrashLogDir: invoke("getCrashLogDir"),
  cleanCrashLogs: invoke("cleanupOldCrashLogs"),
  selectDirectory: invoke("selectDirectory"),
  downloadFileToPath: invoke("downloadFileToPath"),
  cancelDownloadFileToPath: invoke("cancelDownloadFileToPath"),
  saveBufferToPath: invoke("saveBufferToPath"),
  openPathInExplorer: invoke("openPathInExplorer")
};

const nativeData = {
  maintenance: {
    getHealth: invoke("native:data:maintenance:getHealth"),
    quickCheck: invoke("native:data:maintenance:quickCheck"),
    listTables: invoke("native:data:maintenance:listTables"),
    createBackup: invoke("native:data:maintenance:createBackup"),
    recoverOpenJobs: invoke("native:data:maintenance:recoverOpenJobs")
  },
  stores: {
    upsertIdentity: invoke("native:data:stores:upsertIdentity"),
    tombstoneIdentity: invoke("native:data:stores:tombstoneIdentity")
  },
  records: {
    put: putNativeDataRecord,
    putMany: invoke("native:data:records:putMany"),
    acquireOperation: invoke("native:data:records:acquireOperation"),
    claimOpportunitySubmitTask: invoke("native:data:records:claimOpportunitySubmitTask"),
    get: invoke("native:data:records:get"),
    getMany: invoke("native:data:records:getMany"),
    list: invoke("native:data:records:list"),
    latest: invoke("native:data:records:latest"),
    queryOperations: invoke("native:data:records:queryOperations"),
    cleanupOperations: invoke("native:data:records:cleanupOperations"),
    delete: invoke("native:data:records:delete"),
    deleteMany: invoke("native:data:records:deleteMany")
  },
  opportunityAttempts: {
    putMany: invoke("native:data:opportunityAttempts:putMany"),
    count: invoke("native:data:opportunityAttempts:count"),
    listDedupeKeys: invoke("native:data:opportunityAttempts:listDedupeKeys"),
    findDedupeKeys: invoke("native:data:opportunityAttempts:findDedupeKeys"),
    cleanup: invoke("native:data:opportunityAttempts:cleanup")
  },
  catalogJobs: {
    acquire: invoke("native:data:catalogJobs:acquire"),
    reportPage: invoke("native:data:catalogJobs:reportPage"),
    finish: invoke("native:data:catalogJobs:finish"),
    cancel: invoke("native:data:catalogJobs:cancel"),
    get: invoke("native:data:catalogJobs:get"),
    heartbeat: invoke("native:data:catalogJobs:heartbeat")
  },
  catalog: {
    queryHeadMembersPage: invoke("native:data:catalog:queryHeadMembersPage"),
    queryLastObservedPage: invoke("native:data:catalog:queryLastObservedPage"),
    getProductsByIds: invoke("native:data:catalog:getProductsByIds"),
    recordLiveObservations: invoke("native:data:catalog:recordLiveObservations"),
    recordMutationResults: invoke("native:data:catalog:recordMutationResults"),
    summarizeOpportunityRunMutations: invoke("native:data:catalog:summarizeOpportunityRunMutations"),
    confirmMutations: invoke("native:data:catalog:confirmMutations"),
    invalidateCoverage: invoke("native:data:catalog:invalidateCoverage")
  },
  features: {
    saveStaleRun: invoke("native:data:features:saveStaleRun"),
    loadStaleCandidates: invoke("native:data:features:loadStaleCandidates"),
    saveBulkRun: invoke("native:data:features:saveBulkRun"),
    loadBulkCandidates: invoke("native:data:features:loadBulkCandidates"),
    saveOpportunityRun: invoke("native:data:features:saveOpportunityRun"),
    loadOpportunityCandidates: invoke("native:data:features:loadOpportunityCandidates")
  }
};

const chihuNative = {
  app: {
    getInfo: invoke("native:app:getInfo")
  },
  windows: {
    open: invoke("native:windows:open"),
    eval: invoke("native:windows:eval"),
    destroy: invoke("native:windows:destroy"),
    getInfo: client.getBrowserWindowInfo,
    getAll: client.getAllBrowserWindowInfos,
    getMainInfo: client.getMainWindowInfo,
    resetMain: client.resetMainWindow,
    reloadHome: client.reloadHomeUrl,
    minimize: client.minimizeWindow,
    maximize: client.maximizeWindow,
    close: client.closeWindow,
    isMaximized: client.isWindowMaximized,
    isDestroyed: client.isWindowDestroyed
  },
  cookies: {
    get: invoke("native:cookies:get"),
    set: invoke("native:cookies:set"),
    copy: invoke("native:cookies:copy"),
    remove: invoke("native:cookies:remove"),
    getHeader: invoke("native:cookies:getHeader"),
    clear: invoke("native:cookies:clear")
  },
  http: {
    request: invoke("native:http:request")
  },
  license: {
    getStatus: invoke("native:license:getStatus"),
    check: invoke("native:license:check"),
    redeem: invoke("native:license:redeem"),
    clearLocal: invoke("native:license:clearLocal")
  },
  files: {
    selectFile: invoke("native:files:selectFile"),
    readFile: invoke("native:files:readFile"),
    download: invoke("native:files:download"),
    selectDirectory: client.selectDirectory,
    saveBufferToPath: client.saveBufferToPath,
    openPathInExplorer: client.openPathInExplorer,
    cancelDownload: client.cancelDownloadFileToPath
  },
  notifications: {
    send: invoke("native:notifications:send")
  },
  updates: {
    start: invoke("native:updates:start"),
    getVersionData: invoke("native:updates:getVersionData")
  },
  logs: {
    report: invoke("native:logs:report"),
    getDir: invoke("native:logs:getDir"),
    clean: invoke("native:logs:clean")
  },
  partitions: {
    cleanInvalid: invoke("native:partitions:cleanInvalid")
  },
  text: {
    segment: invoke("native:text:segment")
  },
  nativeData
};

contextBridge.exposeInMainWorld("client", client);
contextBridge.exposeInMainWorld("chihuNative", chihuNative);
contextBridge.exposeInMainWorld("nativeData", nativeData);

[
  "update-available",
  "download-progress",
  "update-not-available",
  "update-downloaded",
  "update-error"
].forEach((channel) => {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(channel, { detail: payload }));
    window.dispatchEvent(new CustomEvent(`chihu:${channel}`, { detail: payload }));
  });
});

ipcRenderer.on("chihu-notification", (_event, args) => {
  const customEvent = new CustomEvent(args.chihu_event_name, { detail: args });
  window.dispatchEvent(customEvent);
});
