const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { DEFAULT_PARTITION, HOME_INDEX_URL, HOME_PRELOAD, ICON_PATH, ROOT } = require("../config");
const { getNativeDataService } = require("../database");
const { requirePaidFeature, getLicenseConfig } = require("../license/device-license");
const { getVerifiedReleaseSnapshot } = require("../security/remote-web-integrity");
const {
  getWebContentsPrincipal,
  onPrincipalRevoked,
  registerWebContentsPrincipal,
  requireWebContentsPrincipal
} = require("../security/web-contents-principal");
const {
  TASK_DEFINITIONS,
  allowedPlanKeys,
  materializeDataScopes,
  platformOrigins,
  publicTaskCatalog,
  recoveryPlanKeys,
  taskMutation,
  validateTaskParams
} = require("./task-registry");
const { interruptedTaskStatus, opportunitySubmitProgressStalled, taskResultPersistence, terminalTaskProgress, terminalTaskStatus } = require("./task-result-policy");
const { httpTransportFingerprint, runnerPartitionAllowed, transportMatchesPlan, transportMatchesPlanTemplate } = require("./task-transport-policy");
const { taskWindowCommandScript } = require("./task-window-commands");
const { dueOpportunityHistoryPrewarmStores, nextOpportunityHistoryPrewarmWakeAt } = require("./opportunity-history-prewarm-scheduler");
const { automaticOpportunitySubmitRecoveryPendingTask, dueOpportunitySubmitRecoveryTasks, nextOpportunitySubmitRecoveryWakeAt } = require("./opportunity-submit-recovery-scheduler");
const { opportunitySubmitOperationState } = require("./opportunity-submit-operation-state");

const runnerContexts = new Map();
const operationContexts = new Map();
const MAX_RUNNERS = 8;
const MAX_OWNER_RUNNERS = 4;
const MAX_RUNNER_LIFETIME_MS = 90 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const OPPORTUNITY_SUBMIT_RECOVERY_POLL_MS = 30 * 1000;
const OPPORTUNITY_SUBMIT_AUTH_RETRY_MS = 5 * 60 * 1000;
const OPPORTUNITY_SUBMIT_LOGIN_RETRY_MS = 30 * 1000;
const OPPORTUNITY_HISTORY_PREWARM_POLL_MS = 60 * 1000;
let installed = false;
let opportunitySubmitRecoveryStarted = false;
let opportunitySubmitRecoveryTimer = null;
let opportunitySubmitRecoveryTickPromise = null;
let opportunitySubmitRecoveryReason = "scheduled";
let opportunityHistoryPrewarmStarted = false;
let opportunityHistoryPrewarmTimer = null;
let opportunityHistoryPrewarmTickPromise = null;
let opportunityHistoryPrewarmReason = "scheduled";
const opportunityHistoryPrewarmLastAttemptByShopId = new Map();
let opportunityHistoryPrewarmLastForegroundActivityAt = Date.now();
let opportunityHistoryPrewarmNextAllowedAt = 0;

function service() {
  return getNativeDataService({ app });
}

function taskError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function developmentSnapshot() {
  if (app.isPackaged) return null;
  try {
    const publicConfig = path.resolve(ROOT, "..", "remote-web", "client-shell", "public", "config");
    const adapterBuffer = fs.readFileSync(path.join(publicConfig, "doudian-adapter.marketing-pilot.json"));
    const windowCommandsBuffer = fs.readFileSync(path.join(publicConfig, "doudian-window-commands.json"));
    const configBuffer = fs.readFileSync(path.join(publicConfig, "chihu-config.json"));
    const manifestBuffer = fs.readFileSync(path.resolve(publicConfig, "..", "release-manifest.json"));
    const runnerBuffers = ["app.js", "bridge.js"].map((fileName) => {
      const buffer = fs.readFileSync(path.resolve(publicConfig, "..", fileName));
      return `${fileName}:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
    });
    const windowCommands = JSON.parse(windowCommandsBuffer.toString("utf8"));
    const adapterSha256 = crypto.createHash("sha256").update(adapterBuffer).digest("hex");
    if (windowCommands.schemaVersion !== 1 || windowCommands.adapterSha256 !== adapterSha256 || !windowCommands.commands) return null;
    return {
      releaseId: "development",
      entryUrl: HOME_INDEX_URL,
      releaseManifestHash: crypto.createHash("sha256").update(manifestBuffer).digest("hex"),
      runnerArtifactHash: crypto.createHash("sha256").update(runnerBuffers.sort().join("\n")).digest("hex"),
      adapterSnapshotHash: crypto.createHash("sha256").update(Buffer.concat([adapterBuffer, windowCommandsBuffer])).digest("hex"),
      adapter: JSON.parse(adapterBuffer.toString("utf8")),
      windowCommands,
      config: JSON.parse(configBuffer.toString("utf8"))
    };
  } catch {
    return null;
  }
}

function currentSnapshot(releaseId = "") {
  const verified = getVerifiedReleaseSnapshot(releaseId);
  if (verified) return verified;
  if (!releaseId || releaseId === "development") return developmentSnapshot();
  return null;
}

function opportunitySubmitRecoveryEnabled(snapshot) {
  return snapshot?.adapter?.policies?.opportunityReport?.submitThrottleRecoveryEnabled === true;
}

function opportunityHistoryPrewarmEnabled(snapshot) {
  return snapshot?.adapter?.policies?.opportunityReport?.submitHistoryPrewarmEnabled === true;
}

function opportunityHistoryPrewarmPolicy(snapshot) {
  const policy = snapshot?.adapter?.policies?.opportunityReport || {};
  return {
    intervalMs: Math.max(60_000, Number(policy.submitHistoryPrewarmIntervalMs || 6 * 60 * 60 * 1000)),
    retryMs: Math.max(30_000, Number(policy.submitHistoryPrewarmRetryMs || 5 * 60 * 1000)),
    idleGraceMs: Math.max(60_000, Number(policy.submitHistoryPrewarmIdleGraceMs || 3 * 60 * 1000)),
    interSliceDelayMs: Math.max(30_000, Number(policy.submitHistoryPrewarmInterSliceDelayMs || 60_000))
  };
}

function opportunitySubmitRecoveryContractMatches(task, snapshot) {
  if (!task || !snapshot) return false;
  return String(task.releaseId || "") === String(snapshot.releaseId || "") &&
    String(task.releaseManifestHash || "") === String(snapshot.releaseManifestHash || "") &&
    String(task.runnerArtifactHash || "") === String(snapshot.runnerArtifactHash || "") &&
    String(task.adapterSnapshotHash || "") === String(snapshot.adapterSnapshotHash || "");
}

function isoAfter(delayMs) {
  return new Date(Date.now() + Math.max(0, Number(delayMs || 0))).toISOString();
}

function cookieDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^\./, "");
}

function planHttpGrant(snapshot, planKey) {
  const plan = snapshot.adapter?.requestPlans?.[planKey];
  if (!plan || typeof plan !== "object") throw taskError("TASK_PLAN_DENIED", "request plan is missing from the verified snapshot");
  const endpointKey = String(plan.endpointKey || planKey);
  const endpoint = snapshot.adapter?.endpoints?.[endpointKey];
  if (!endpoint) throw taskError("TASK_PLAN_DENIED", "request plan endpoint is missing from the verified snapshot");
  const origin = String(plan.origin || snapshot.adapter.origin || "");
  const url = new URL(String(endpoint).replace(/\{[^}]+\}/g, "x"), origin);
  const templatePath = new URL(String(endpoint).replace(/\{[^}]+\}/g, "x"), origin).pathname;
  const placeholderIndex = String(endpoint).indexOf("{");
  const pathPrefix = placeholderIndex >= 0 ? templatePath.slice(0, Math.max(1, templatePath.lastIndexOf("/x"))) : templatePath;
  const cookieDomains = new Set([
    snapshot.adapter?.cookieDomain,
    plan.signDomain,
    ...((Array.isArray(plan.cookieDomains) ? plan.cookieDomains : []))
  ].map(cookieDomain).filter(Boolean));
  const cookieOrigins = new Set([url.origin]);
  for (const value of Array.isArray(plan.cookieUrls) ? plan.cookieUrls : []) {
    try {
      const cookieUrl = new URL(String(value), origin);
      cookieOrigins.add(cookieUrl.origin);
      cookieDomains.add(cookieUrl.hostname.toLowerCase());
    } catch {}
  }
  if (plan.signStrategy === "mstoken-myargs") cookieDomains.add("bytedance.com");
  return {
    planKey,
    origin: url.origin,
    pathPrefix,
    pathMode: placeholderIndex >= 0 ? "segment-prefix" : "exact",
    method: String(plan.method || "GET").toUpperCase(),
    cookieDomains,
    cookieOrigins,
    expiresAt: Date.now() + 2 * 60 * 1000
  };
}

async function taskPartitionScope(taskType, params, snapshot) {
  const configuredPrefix = String(snapshot.adapter?.shopPartitionPrefix || "persist:chihu_doudian_shop_");
  if (taskType === "fetchDoudianStores") {
    return { allowedPartitions: new Set(), allowedPartitionPrefixes: new Set([configuredPrefix]), allowedStoreRefs: [] };
  }
  const requestedShopIds = new Set([
    ...(Array.isArray(params.shopIds) ? params.shopIds : []),
    ...(Array.isArray(params.stores) ? params.stores.map((item) => item?.shopId) : []),
    ...(Array.isArray(params.storeRefs) ? params.storeRefs.map((item) => item?.shopId) : [])
  ].map((value) => String(value || "")).filter(Boolean));
  if (taskType === "opportunitySubmitContinuation" && params.taskId) {
    const submitTask = await service().request("records.get", {
      storeName: "opportunity_pipeline_submit_tasks_v2",
      id: String(params.taskId)
    }, { priority: "interactive" }).catch(() => null);
    if (!submitTask || !submitTask.shopId) throw taskError("TASK_PARAMS_INVALID", "待恢复的商机提报任务不存在");
    requestedShopIds.add(String(submitTask.shopId));
  }
  const page = await service().request("records.list", { storeName: "stores", limit: 50000 }, { priority: "interactive" }).catch(() => null);
  const stores = Array.isArray(page) ? page : Array.isArray(page?.items) ? page.items : [];
  const selectedStores = stores.filter((store) => !requestedShopIds.size || requestedShopIds.has(String(store?.shopId || store?.id || "")));
  const allowedPartitions = new Set(selectedStores
    .map((store) => String(store?.partition || ""))
    .filter((partition) => partition.startsWith(configuredPrefix)));
  const allowedStoreRefs = selectedStores.map((store) => ({
    shopId: String(store?.shopId || store?.id || ""),
    tenantId: String(store?.tenantId || ""),
    storeGeneration: Number(store?.storeGeneration || 0)
  })).filter((store) => store.shopId);
  return { allowedPartitions, allowedPartitionPrefixes: new Set(), allowedStoreRefs };
}

function featureEnabled(definition, snapshot, params = {}) {
  if (definition === TASK_DEFINITIONS.mockLongTask) return true;
  if (!snapshot?.adapter || !snapshot?.config) return false;
  if (definition === TASK_DEFINITIONS.opportunityHistoryPrewarm && !opportunityHistoryPrewarmEnabled(snapshot)) return false;
  if (definition === TASK_DEFINITIONS.marketingTask || definition === TASK_DEFINITIONS.marketingReconcile) {
    const features = snapshot.config.features || {};
    if (features.marketingMenu?.enabled !== true) return false;
  }
  return allowedPlanKeys(definition, snapshot.adapter, params).length > 0;
}

function operationIdFor(taskType) {
  return `${taskType}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function taskParamsWithServerMetadata(params, context) {
  return {
    ...params,
    operationId: context.operationId,
    taskContract: {
      releaseId: context.releaseId,
      releaseManifestHash: context.releaseManifestHash,
      runnerArtifactHash: context.runnerArtifactHash,
      adapterSnapshotHash: context.adapterSnapshotHash
    }
  };
}

async function writeOperationEvidence(context, status = "running", patch = {}) {
  const now = new Date().toISOString();
  const existing = await service().request("records.get", { storeName: "operations", id: context.operationId }, { priority: "interactive" }).catch(() => null);
  const record = {
    ...(existing || {}),
    id: context.operationId,
    operationId: context.operationId,
    taskType: context.taskType,
    status,
    progress: Number(existing?.progress || 0),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ownerSessionId: `main:${context.ownerWebContentsId}`,
    adapterSnapshotHash: context.adapterSnapshotHash,
    paidGrantedAtStart: context.paidGrantedAtStart,
    mutationStarted: context.mutationStarted === true,
    inFlightMutations: Math.max(0, Number(context.inFlightMutations || 0)),
    taskEvidence: {
      accessTier: context.accessTier,
      mutation: context.mutation,
      paidGrantedAtStart: context.paidGrantedAtStart,
      adapterSnapshotHash: context.adapterSnapshotHash,
      releaseId: context.releaseId,
      releaseManifestHash: context.releaseManifestHash,
      runnerArtifactHash: context.runnerArtifactHash,
      allowedPlanKeys: [...context.allowedPlanKeys],
      recoveryPlanKeys: [...context.recoveryPlanKeys],
      allowedDataScopes: context.allowedDataScopes,
      allowedPartitions: [...context.allowedPartitions],
      allowedPartitionPrefixes: [...context.allowedPartitionPrefixes],
      allowedStoreRefs: context.allowedStoreRefs,
      createdAt: context.createdAt
    },
    metadata: {
      ...(existing?.metadata || {}),
      mutation: context.mutation === true,
      ...(context.submitTaskId ? { submitTaskId: context.submitTaskId } : {}),
      ...(context.recoverySource ? { recoverySource: context.recoverySource } : {})
    },
    ...patch
  };
  await service().request("records.put", { storeName: "operations", record }, { priority: "write" });
  return record;
}

function operationOwnerWebContentsId(record) {
  const match = /^main:(\d+)$/.exec(String(record?.ownerSessionId || ""));
  return match ? Number(match[1]) : 0;
}

async function syncOpportunityPipelineSourceOperation(context) {
  if (context.taskType !== "opportunitySubmitContinuation" || !context.submitTaskId) return null;
  const task = await service().request("records.get", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    id: String(context.submitTaskId)
  }, { priority: "interactive" }).catch(() => null);
  const runId = String(task?.runId || "");
  if (!runId) return null;
  const [run, taskPage] = await Promise.all([
    service().request("records.get", {
      storeName: "opportunity_pipeline_runs_v2",
      id: runId
    }, { priority: "interactive" }).catch(() => null),
    service().request("records.queryByPrefix", {
      storeName: "opportunity_pipeline_submit_tasks_v2",
      recordIdPrefix: runId,
      limit: 1000
    }, { priority: "interactive" }).catch(() => null)
  ]);
  if (!run) return null;
  const sourceOperationId = String(run.operationId || run.runId || run.id || runId);
  const existing = await service().request("records.get", {
    storeName: "operations",
    id: sourceOperationId
  }, { priority: "interactive" }).catch(() => null);
  if (!existing || existing.taskType !== "opportunityPipelineSubmit") return null;
  const tasks = (Array.isArray(taskPage?.items) ? taskPage.items : [])
    .filter((item) => String(item?.runId || "") === runId);
  const state = opportunitySubmitOperationState({ run, tasks, currentProgress: existing.progress });
  const now = new Date().toISOString();
  const record = {
    ...existing,
    status: state.status,
    progress: state.progress,
    resultSummary: state.resultSummary,
    result: state.result,
    updatedAt: now,
    metadata: {
      ...(existing.metadata || {}),
      backgroundRecoveryActive: tasks.some(automaticOpportunitySubmitRecoveryPendingTask),
      lastContinuationOperationId: context.operationId
    }
  };
  if (state.status !== "failed") delete record.error;
  await service().request("records.put", { storeName: "operations", record }, { priority: "write" });
  const ownerWebContentsId = operationOwnerWebContentsId(record);
  if (ownerWebContentsId) {
    sendOwnerEvent({ ownerWebContentsId }, {
      type: "task:result",
      operationId: sourceOperationId,
      resultSummary: state.resultSummary,
      result: state.result
    });
  }
  return record;
}

function ownerRunnerCount(ownerWebContentsId) {
  return [...runnerContexts.values()].filter((context) => context.ownerWebContentsId === ownerWebContentsId).length;
}

function runnerUrlFor(snapshot, operationId) {
  const url = new URL(snapshot.entryUrl || HOME_INDEX_URL);
  url.searchParams.set("runner", "1");
  url.searchParams.set("taskId", operationId);
  return url.toString();
}

function sendOwnerEvent(context, message) {
  const owner = BrowserWindow.getAllWindows().map((win) => win.webContents).find((contents) => contents.id === context.ownerWebContentsId);
  if (owner && !owner.isDestroyed()) owner.send("chihu:tasks:event", message);
}

async function closeRunnerContext(context, reason, options = {}) {
  if (!context || context.closed) return;
  context.closed = true;
  runnerContexts.delete(context.runnerWebContentsId);
  operationContexts.delete(context.operationId);
  clearTimeout(context.lifetimeTimer);
  clearInterval(context.heartbeatTimer);
  if (!options.terminal) {
    const prewarmYielded = context.taskType === "opportunityHistoryPrewarm" && [
      "foreground-task-started",
      "submit-recovery-started"
    ].includes(String(reason || ""));
    if (prewarmYielded) {
      await writeOperationEvidence(context, "partial", {
        progress: Number(context.lastProgress || 0),
        resultSummary: "history prewarm yielded to submit work",
        result: {
          ok: true,
          status: "partial",
          mode: "history-prewarm",
          message: "history prewarm yielded to submit work",
          reason: String(reason || "foreground-task-started")
        }
      }).catch(() => undefined);
    } else {
    const status = interruptedTaskStatus({
      mutation: context.mutation,
      mutationStarted: context.mutationStarted,
      inFlightMutations: context.inFlightMutations,
      cancellationRequested: context.cancellationRequested === true
    });
    const cancelled = status === "cancelled";
    const reconciling = status === "reconciling";
    await writeOperationEvidence(context, status, {
      resultSummary: cancelled ? "cancelled" : reconciling ? "runner lost; reconciliation required" : context.mutation ? "runner stopped before mutation" : "runner interrupted",
      ...(cancelled ? {} : { error: reason })
    }).catch(() => undefined);
    sendOwnerEvent(context, {
      type: cancelled ? "task:result" : "task:error",
      operationId: context.operationId,
      ...(cancelled
        ? { resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } }
        : { error: reconciling ? "runner lost; reconciliation required" : reason })
    });
    }
  }
  const win = BrowserWindow.fromWebContents(context.runnerWebContents);
  if (win && !win.isDestroyed()) win.destroy();
  for (const childId of context.childWindowIds) {
    const child = BrowserWindow.fromId(childId);
    if (child && !child.isDestroyed()) child.destroy();
  }
  if (context.taskType === "opportunitySubmitContinuation") notifyOpportunitySubmitRecovery("continuation-finished");
  if (context.taskType === "opportunityHistoryPrewarm") notifyOpportunityHistoryPrewarm("prewarm-finished");
}

function createRunnerWindow(context, snapshot, task) {
  const runnerUrl = runnerUrlFor(snapshot, context.operationId);
  const runner = new BrowserWindow({
    width: 480,
    height: 360,
    show: false,
    title: "Chihu Task Runner",
    icon: ICON_PATH,
    webPreferences: {
      preload: HOME_PRELOAD,
      partition: DEFAULT_PARTITION,
      session: session.fromPartition(DEFAULT_PARTITION),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: false,
      devTools: !app.isPackaged && process.env.CHIHU_ENABLE_DEVTOOLS === "1"
    }
  });
  runner.setMenu(null);
  context.runnerWebContents = runner.webContents;
  context.runnerWebContentsId = runner.webContents.id;
  runnerContexts.set(context.runnerWebContentsId, context);
  registerWebContentsPrincipal(runner.webContents, {
    role: context.accessTier === "recovery" ? "runner" : "runner",
    expectedUrl: runnerUrl,
    releaseId: snapshot.releaseId,
    ownerOperationId: context.operationId
  });
  runner.webContents.once("did-finish-load", () => {
    if (context.closed || runner.webContents.isDestroyed()) return;
    runner.webContents.send("chihu:tasks:command", {
      type: "task:start",
      operation: { operationId: context.operationId, taskType: context.taskType, status: "running", progress: 0 },
      task
    });
    if (context.cancellationRequested) {
      runner.webContents.send("chihu:tasks:command", { type: "task:cancel", operationId: context.operationId });
    }
  });
  runner.once("closed", () => void closeRunnerContext(context, "runner window closed"));
  void runner.loadURL(runnerUrl).catch((error) => closeRunnerContext(context, error.message || String(error)));
  return runner;
}

function armRunnerLifecycle(context) {
  context.lifetimeTimer = setTimeout(() => void closeRunnerContext(context, "runner lifetime exceeded"), MAX_RUNNER_LIFETIME_MS);
  context.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - context.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) void closeRunnerContext(context, "runner heartbeat expired");
    else if (opportunitySubmitProgressStalled(context, now)) void closeRunnerContext(context, "opportunity submit worker progress stalled");
  }, 5000);
}

async function startRunner(event, request = {}) {
  const ownerPrincipal = requireWebContentsPrincipal(event, ["main"]);
  const taskType = String(request.taskType || "");
  const definition = TASK_DEFINITIONS[taskType];
  if (!definition || definition.accessTier === "recovery" || taskType === "opportunityHistoryPrewarm") return { ok: false, code: "TASK_TYPE_DENIED", message: "该任务不能从页面启动" };
  if (definition.accessTier === "internal" && !getLicenseConfig().explicitTestMode) return { ok: false, code: "TASK_TYPE_DENIED", message: "内部任务仅允许显式测试环境启动" };
  let params;
  try {
    params = validateTaskParams(taskType, request.params || {});
  } catch (error) {
    return { ok: false, code: error.code || "TASK_PARAMS_INVALID", message: error.message || "任务参数无效" };
  }
  if (definition.accessTier === "paid") {
    try {
      await requirePaidFeature({ taskType });
    } catch (error) {
      return { ok: false, code: error.code || "LICENSE_REQUIRED", message: error.message || "请先开通完整版" };
    }
  }
  let snapshot = currentSnapshot();
  if (taskType === "opportunitySubmitContinuation") {
    const submitTask = await service().request("records.get", {
      storeName: "opportunity_pipeline_submit_tasks_v2",
      id: String(params.taskId || "")
    }, { priority: "interactive" }).catch(() => null);
    snapshot = submitTask?.releaseId ? currentSnapshot(String(submitTask.releaseId)) : null;
    if (!submitTask || !snapshot || submitTask.adapterSnapshotHash !== snapshot.adapterSnapshotHash) {
      return { ok: false, code: "TASK_TYPE_DENIED", message: "原提报任务的发布快照不可用，请转人工对账" };
    }
  }
  if (!snapshot || !featureEnabled(definition, snapshot, params)) return { ok: false, code: "TASK_TYPE_DENIED", message: "当前发布版本未启用该任务" };
  if (taskType === "opportunityHistoryPrewarm" && operationContexts.size > 0) {
    return { ok: false, code: "TASK_TYPE_DENIED", message: "报名历史预热仅在软件空闲时运行" };
  }
  if (taskType !== "opportunityHistoryPrewarm") await yieldOpportunityHistoryPrewarm("foreground-task-started");
  if (runnerContexts.size >= MAX_RUNNERS || ownerRunnerCount(event.sender.id) >= MAX_OWNER_RUNNERS) {
    return { ok: false, code: "TASK_TYPE_DENIED", message: "任务并发数已达到上限" };
  }
  const partitionScope = await taskPartitionScope(taskType, params, snapshot);
  const operationId = operationIdFor(taskType);
  const context = {
    runnerWebContentsId: 0,
    runnerWebContents: null,
    ownerWebContentsId: event.sender.id,
    ownerNavigationEpoch: ownerPrincipal.navigationEpoch,
    operationId,
    taskType,
    accessTier: definition.accessTier,
    mutation: taskMutation(definition, params),
    paidGrantedAtStart: definition.accessTier === "paid",
    principalNavigationEpoch: 1,
    releaseId: snapshot.releaseId,
    releaseManifestHash: snapshot.releaseManifestHash,
    runnerArtifactHash: snapshot.runnerArtifactHash,
    adapterSnapshotHash: snapshot.adapterSnapshotHash,
    allowedPlanKeys: new Set(allowedPlanKeys(definition, snapshot.adapter, params)),
    recoveryPlanKeys: new Set(recoveryPlanKeys(definition, snapshot.adapter, params)),
    allowedPlatformOrigins: new Set(platformOrigins(snapshot.adapter)),
    allowedPartitions: partitionScope.allowedPartitions,
    allowedPartitionPrefixes: partitionScope.allowedPartitionPrefixes,
    allowedStoreRefs: partitionScope.allowedStoreRefs,
    allowedDataScopes: materializeDataScopes(definition.allowedDataScopes, operationId),
    childWindowIds: new Set(),
    childWindowPartitions: new Map(),
    programmaticWindowCloseIds: new Set(),
    activePlanGrants: new Map(),
    httpGrants: new Map(),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgress: 0,
    mutationStarted: false,
    inFlightMutations: 0,
    cancellationRequested: false,
    closed: false
  };
  operationContexts.set(operationId, context);
  await writeOperationEvidence(context, "running");
  const task = {
    taskType,
    operationId,
    metadata: {
      mutation: context.mutation,
      adapterSnapshotHash: snapshot.adapterSnapshotHash,
      clientRequestId: String(request.clientRequestId || "").slice(0, 200)
    },
    payload: taskParamsWithServerMetadata(params, context)
  };
  const runner = createRunnerWindow(context, snapshot, task);
  armRunnerLifecycle(context);
  if (taskType === "opportunityPipelineSubmit") notifyOpportunitySubmitRecovery("foreground-submit-started");
  return { ok: true, operationId, status: "started", runnerWinId: runner.id };
}

function activeOpportunitySubmitContinuationTaskIds() {
  return new Set([...operationContexts.values()]
    .filter((context) => context.taskType === "opportunitySubmitContinuation" && context.submitTaskId)
    .map((context) => String(context.submitTaskId)));
}

async function deferOpportunitySubmitRecoveryTask(task, deferredReason, options = {}) {
  return service().request("opportunitySubmit.deferTask", {
    taskId: String(task.id || ""),
    deferredReason,
    now: new Date().toISOString(),
    ...(options.resumeAt ? { resumeAt: options.resumeAt } : {}),
    ...(options.requiresExplicitResume === true ? { requiresExplicitResume: true } : {}),
    ...(options.message ? { message: String(options.message).slice(0, 4000) } : {}),
    recoverySource: String(options.recoverySource || "background-scheduler")
  }, { priority: "write" }).catch(() => null);
}

async function storeRecordForSubmitTask(task) {
  const page = await service().request("records.list", {
    storeName: "stores",
    limit: 50000
  }, { priority: "interactive" }).catch(() => null);
  const stores = Array.isArray(page?.items) ? page.items : [];
  return stores.find((store) => String(store?.shopId || store?.id || "") === String(task.shopId || "") &&
    Number(store?.storeGeneration || 0) === Number(task.storeGeneration || 0)) || null;
}

async function startOpportunitySubmitContinuation(task, reason = "scheduled") {
  const taskId = String(task?.id || "");
  if (!taskId) return { started: false, reason: "task-missing" };
  const latestTask = await service().request("records.get", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    id: taskId
  }, { priority: "interactive" }).catch(() => null);
  if (!latestTask) return { started: false, reason: "task-missing" };
  if (!automaticOpportunitySubmitRecoveryTask(latestTask)) return { started: false, reason: "not-due" };
  task = latestTask;
  if (task.submitThrottleRecoveryEnabled !== true) return { started: false, reason: "feature-disabled" };
  if (operationContexts.has(String(task.runId || "")) || activeOpportunitySubmitContinuationTaskIds().has(taskId)) {
    return { started: false, reason: "already-active" };
  }
  const definition = TASK_DEFINITIONS.opportunitySubmitContinuation;
  const params = validateTaskParams("opportunitySubmitContinuation", {
    mode: "submit-continuation",
    taskId,
    reason: String(reason || "scheduled").slice(0, 200)
  });
  const snapshot = currentSnapshot(String(task.releaseId || ""));
  if (!opportunitySubmitRecoveryContractMatches(task, snapshot)) {
    await deferOpportunitySubmitRecoveryTask(task, "contract_mismatch", {
      requiresExplicitResume: true,
      message: "trusted release snapshot is unavailable or no longer matches the submit task",
      recoverySource: reason
    });
    return { started: false, reason: "contract-mismatch" };
  }
  if (!opportunitySubmitRecoveryEnabled(snapshot) || !featureEnabled(definition, snapshot, params)) {
    return { started: false, reason: "feature-disabled" };
  }
  try {
    await requirePaidFeature({ taskType: "opportunitySubmitContinuation", taskId, recoverySource: reason });
  } catch (error) {
    await deferOpportunitySubmitRecoveryTask(task, "authorization_wait", {
      resumeAt: isoAfter(OPPORTUNITY_SUBMIT_AUTH_RETRY_MS),
      message: error?.message || "paid authorization is unavailable",
      recoverySource: reason
    });
    return { started: false, reason: "authorization-wait" };
  }
  const store = await storeRecordForSubmitTask(task);
  const configuredPrefix = String(snapshot.adapter?.shopPartitionPrefix || "persist:chihu_doudian_shop_");
  if (!store || store.status !== "online" || !String(store.partition || "").startsWith(configuredPrefix)) {
    await deferOpportunitySubmitRecoveryTask(task, "login_wait", {
      resumeAt: isoAfter(OPPORTUNITY_SUBMIT_LOGIN_RETRY_MS),
      message: !store ? "store generation is unavailable" : "store login is not online",
      recoverySource: reason
    });
    return { started: false, reason: "login-wait" };
  }
  const partitionScope = await taskPartitionScope("opportunitySubmitContinuation", params, snapshot);
  const exactStoreAllowed = partitionScope.allowedStoreRefs.some((item) => String(item.shopId || "") === String(task.shopId || "") &&
    Number(item.storeGeneration || 0) === Number(task.storeGeneration || 0));
  if (!exactStoreAllowed || !partitionScope.allowedPartitions.has(String(store.partition || ""))) {
    await deferOpportunitySubmitRecoveryTask(task, "login_wait", {
      resumeAt: isoAfter(OPPORTUNITY_SUBMIT_LOGIN_RETRY_MS),
      message: "store partition or generation is not available to the recovery runner",
      recoverySource: reason
    });
    return { started: false, reason: "partition-wait" };
  }
  await yieldOpportunityHistoryPrewarm("submit-recovery-started");
  if (runnerContexts.size >= MAX_RUNNERS) return { started: false, reason: "runner-capacity" };
  const operationId = operationIdFor("opportunitySubmitContinuation");
  const context = {
    runnerWebContentsId: 0,
    runnerWebContents: null,
    ownerWebContentsId: 0,
    ownerNavigationEpoch: 0,
    operationId,
    taskType: "opportunitySubmitContinuation",
    accessTier: "recovery",
    mutation: true,
    paidGrantedAtStart: true,
    principalNavigationEpoch: 1,
    releaseId: snapshot.releaseId,
    releaseManifestHash: snapshot.releaseManifestHash,
    runnerArtifactHash: snapshot.runnerArtifactHash,
    adapterSnapshotHash: snapshot.adapterSnapshotHash,
    allowedPlanKeys: new Set(allowedPlanKeys(definition, snapshot.adapter, params)),
    recoveryPlanKeys: new Set(),
    allowedPlatformOrigins: new Set(platformOrigins(snapshot.adapter)),
    allowedPartitions: partitionScope.allowedPartitions,
    allowedPartitionPrefixes: partitionScope.allowedPartitionPrefixes,
    allowedStoreRefs: partitionScope.allowedStoreRefs,
    allowedDataScopes: materializeDataScopes(definition.allowedDataScopes, operationId),
    childWindowIds: new Set(),
    childWindowPartitions: new Map(),
    programmaticWindowCloseIds: new Set(),
    activePlanGrants: new Map(),
    httpGrants: new Map(),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgress: 0,
    mutationStarted: false,
    inFlightMutations: 0,
    cancellationRequested: false,
    closed: false,
    submitTaskId: taskId,
    recoverySource: String(reason || "scheduled")
  };
  operationContexts.set(operationId, context);
  try {
    await writeOperationEvidence(context, "running");
    const runnerTask = {
      taskType: "opportunitySubmitContinuation",
      operationId,
      metadata: {
        mutation: true,
        adapterSnapshotHash: snapshot.adapterSnapshotHash,
        submitTaskId: taskId,
        recoverySource: context.recoverySource
      },
      payload: taskParamsWithServerMetadata(params, context)
    };
    const runner = createRunnerWindow(context, snapshot, runnerTask);
    armRunnerLifecycle(context);
    return { started: true, reason: "started", operationId, runnerWinId: runner.id };
  } catch (error) {
    operationContexts.delete(operationId);
    throw error;
  }
}

function scheduleOpportunitySubmitRecovery(delayMs, reason) {
  if (!opportunitySubmitRecoveryStarted) return;
  opportunitySubmitRecoveryReason = String(reason || opportunitySubmitRecoveryReason || "scheduled");
  if (opportunitySubmitRecoveryTimer) clearTimeout(opportunitySubmitRecoveryTimer);
  opportunitySubmitRecoveryTimer = setTimeout(() => {
    opportunitySubmitRecoveryTimer = null;
    void runOpportunitySubmitRecoveryTick();
  }, Math.max(100, Math.floor(Number(delayMs || 0))));
  opportunitySubmitRecoveryTimer.unref?.();
}

async function runOpportunitySubmitRecoveryTick() {
  if (!opportunitySubmitRecoveryStarted) return;
  if (opportunitySubmitRecoveryTickPromise) return opportunitySubmitRecoveryTickPromise;
  const trigger = opportunitySubmitRecoveryReason;
  opportunitySubmitRecoveryReason = "scheduled";
  opportunitySubmitRecoveryTickPromise = (async () => {
    const page = await service().request("records.list", {
      storeName: "opportunity_pipeline_submit_tasks_v2",
      limit: 50000
    }, { priority: "interactive" });
    const tasks = (Array.isArray(page?.items) ? page.items : [])
      .filter((task) => task?.submitThrottleRecoveryEnabled === true);
    const activeRunIds = new Set(operationContexts.keys());
    const activeTaskIds = activeOpportunitySubmitContinuationTaskIds();
    const dueTasks = dueOpportunitySubmitRecoveryTasks(tasks, { activeRunIds, activeTaskIds });
    const continuationActive = [...operationContexts.values()].some((context) => context.taskType === "opportunitySubmitContinuation");
    if (!continuationActive) {
      for (const task of dueTasks) {
        const result = await startOpportunitySubmitContinuation(task, trigger);
        if (result.started) break;
      }
    }
    const nextWakeAt = nextOpportunitySubmitRecoveryWakeAt(tasks);
    const delay = nextWakeAt ? Math.min(OPPORTUNITY_SUBMIT_RECOVERY_POLL_MS, Math.max(100, nextWakeAt - Date.now())) : OPPORTUNITY_SUBMIT_RECOVERY_POLL_MS;
    scheduleOpportunitySubmitRecovery(delay, "scheduled");
  })().catch((error) => {
    console.warn("[opportunity-submit-recovery] scheduler tick failed:", error?.message || error);
    scheduleOpportunitySubmitRecovery(OPPORTUNITY_SUBMIT_RECOVERY_POLL_MS, "retry-after-error");
  }).finally(() => {
    opportunitySubmitRecoveryTickPromise = null;
  });
  return opportunitySubmitRecoveryTickPromise;
}

function notifyOpportunitySubmitRecovery(reason = "external") {
  scheduleOpportunitySubmitRecovery(250, reason);
}

function startOpportunitySubmitRecoveryScheduler() {
  if (opportunitySubmitRecoveryStarted) return;
  opportunitySubmitRecoveryStarted = true;
  scheduleOpportunitySubmitRecovery(1000, "app-startup");
}

function stopOpportunitySubmitRecoveryScheduler() {
  opportunitySubmitRecoveryStarted = false;
  if (opportunitySubmitRecoveryTimer) clearTimeout(opportunitySubmitRecoveryTimer);
  opportunitySubmitRecoveryTimer = null;
}

async function nudgeOpportunitySubmitRecovery(deferredReasons, options = {}) {
  const result = await service().request("opportunitySubmit.nudgeDeferredTasks", {
    deferredReasons,
    now: new Date().toISOString(),
    ...(Array.isArray(options.shopIds) && options.shopIds.length ? { shopIds: options.shopIds } : {}),
    ...(Array.isArray(options.taskIds) && options.taskIds.length ? { taskIds: options.taskIds } : {}),
    recoverySource: String(options.recoverySource || "external")
  }, { priority: "write" }).catch(() => null);
  notifyOpportunitySubmitRecovery(options.recoverySource || "external");
  return result;
}

function activeOpportunityHistoryPrewarmContexts() {
  return [...operationContexts.values()].filter((context) => context.taskType === "opportunityHistoryPrewarm");
}

async function yieldOpportunityHistoryPrewarm(reason = "foreground-task-started") {
  opportunityHistoryPrewarmLastForegroundActivityAt = Date.now();
  const contexts = activeOpportunityHistoryPrewarmContexts();
  await Promise.all(contexts.map((context) => closeRunnerContext(context, reason)));
}

async function automaticOpportunitySubmitWorkPending() {
  const page = await service().request("records.list", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    limit: 50000
  }, { priority: "interactive" });
  const tasks = (Array.isArray(page?.items) ? page.items : [])
    .filter((task) => task?.submitThrottleRecoveryEnabled === true);
  return {
    pending: tasks.some(automaticOpportunitySubmitRecoveryPendingTask),
    nextWakeAt: nextOpportunitySubmitRecoveryWakeAt(tasks)
  };
}

async function startOpportunityHistoryPrewarm(store, snapshot, reason = "idle-maintenance") {
  if (!store || runnerContexts.size >= MAX_RUNNERS || operationContexts.size > 0) return { started: false, reason: "not-idle" };
  const submitWork = await automaticOpportunitySubmitWorkPending();
  if (submitWork.pending) return { started: false, reason: "submit-pending", nextWakeAt: submitWork.nextWakeAt };
  const shopId = String(store.shopId || store.id || "");
  if (!shopId || store.status !== "online") return { started: false, reason: "login-wait" };
  const definition = TASK_DEFINITIONS.opportunityHistoryPrewarm;
  const params = validateTaskParams("opportunityHistoryPrewarm", {
    mode: "history-prewarm",
    shopIds: [shopId],
    reason: String(reason || "idle-maintenance").slice(0, 200)
  });
  if (!featureEnabled(definition, snapshot, params)) return { started: false, reason: "feature-disabled" };
  try {
    await requirePaidFeature({ taskType: "opportunityHistoryPrewarm", shopId, recoverySource: reason });
  } catch {
    return { started: false, reason: "authorization-wait" };
  }
  const configuredPrefix = String(snapshot.adapter?.shopPartitionPrefix || "persist:chihu_doudian_shop_");
  if (!String(store.partition || "").startsWith(configuredPrefix)) return { started: false, reason: "partition-wait" };
  const partitionScope = await taskPartitionScope("opportunityHistoryPrewarm", params, snapshot);
  const exactStoreAllowed = partitionScope.allowedStoreRefs.some((item) => String(item.shopId || "") === shopId &&
    Number(item.storeGeneration || 0) === Number(store.storeGeneration || 0));
  if (!exactStoreAllowed || !partitionScope.allowedPartitions.has(String(store.partition || ""))) {
    return { started: false, reason: "partition-wait" };
  }
  const operationId = operationIdFor("opportunityHistoryPrewarm");
  const context = {
    runnerWebContentsId: 0,
    runnerWebContents: null,
    ownerWebContentsId: 0,
    ownerNavigationEpoch: 0,
    operationId,
    taskType: "opportunityHistoryPrewarm",
    accessTier: definition.accessTier,
    mutation: false,
    paidGrantedAtStart: true,
    principalNavigationEpoch: 1,
    releaseId: snapshot.releaseId,
    releaseManifestHash: snapshot.releaseManifestHash,
    runnerArtifactHash: snapshot.runnerArtifactHash,
    adapterSnapshotHash: snapshot.adapterSnapshotHash,
    allowedPlanKeys: new Set(allowedPlanKeys(definition, snapshot.adapter, params)),
    recoveryPlanKeys: new Set(),
    allowedPlatformOrigins: new Set(platformOrigins(snapshot.adapter)),
    allowedPartitions: partitionScope.allowedPartitions,
    allowedPartitionPrefixes: partitionScope.allowedPartitionPrefixes,
    allowedStoreRefs: partitionScope.allowedStoreRefs,
    allowedDataScopes: materializeDataScopes(definition.allowedDataScopes, operationId),
    childWindowIds: new Set(),
    childWindowPartitions: new Map(),
    programmaticWindowCloseIds: new Set(),
    activePlanGrants: new Map(),
    httpGrants: new Map(),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgress: 0,
    mutationStarted: false,
    inFlightMutations: 0,
    cancellationRequested: false,
    closed: false,
    historyPrewarmShopId: shopId,
    recoverySource: String(reason || "idle-maintenance")
  };
  operationContexts.set(operationId, context);
  try {
    await writeOperationEvidence(context, "running");
    const runnerTask = {
      taskType: "opportunityHistoryPrewarm",
      operationId,
      metadata: {
        mutation: false,
        adapterSnapshotHash: snapshot.adapterSnapshotHash,
        historyPrewarmShopId: shopId,
        recoverySource: context.recoverySource
      },
      payload: taskParamsWithServerMetadata(params, context)
    };
    const runner = createRunnerWindow(context, snapshot, runnerTask);
    armRunnerLifecycle(context);
    return { started: true, reason: "started", operationId, runnerWinId: runner.id };
  } catch (error) {
    operationContexts.delete(operationId);
    throw error;
  }
}

function scheduleOpportunityHistoryPrewarm(delayMs, reason) {
  if (!opportunityHistoryPrewarmStarted) return;
  opportunityHistoryPrewarmReason = String(reason || opportunityHistoryPrewarmReason || "scheduled");
  if (opportunityHistoryPrewarmTimer) clearTimeout(opportunityHistoryPrewarmTimer);
  opportunityHistoryPrewarmTimer = setTimeout(() => {
    opportunityHistoryPrewarmTimer = null;
    void runOpportunityHistoryPrewarmTick();
  }, Math.max(250, Math.floor(Number(delayMs || 0))));
  opportunityHistoryPrewarmTimer.unref?.();
}

async function runOpportunityHistoryPrewarmTick() {
  if (!opportunityHistoryPrewarmStarted) return;
  if (opportunityHistoryPrewarmTickPromise) return opportunityHistoryPrewarmTickPromise;
  const trigger = opportunityHistoryPrewarmReason;
  opportunityHistoryPrewarmReason = "scheduled";
  opportunityHistoryPrewarmTickPromise = (async () => {
    if (operationContexts.size > 0 || runnerContexts.size > 0) {
      scheduleOpportunityHistoryPrewarm(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, "wait-for-idle");
      return;
    }
    const snapshot = currentSnapshot();
    if (!snapshot || !opportunityHistoryPrewarmEnabled(snapshot)) {
      scheduleOpportunityHistoryPrewarm(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, "feature-disabled");
      return;
    }
    const policy = opportunityHistoryPrewarmPolicy(snapshot);
    const nowMs = Date.now();
    const idleEligibleAt = opportunityHistoryPrewarmLastForegroundActivityAt + policy.idleGraceMs;
    const schedulerEligibleAt = Math.max(idleEligibleAt, opportunityHistoryPrewarmNextAllowedAt);
    if (schedulerEligibleAt > nowMs) {
      scheduleOpportunityHistoryPrewarm(
        Math.min(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, schedulerEligibleAt - nowMs),
        idleEligibleAt > nowMs ? "idle-grace" : "inter-slice-delay"
      );
      return;
    }
    try {
      await requirePaidFeature({ taskType: "opportunityHistoryPrewarm", recoverySource: trigger });
    } catch {
      scheduleOpportunityHistoryPrewarm(policy.retryMs, "authorization-wait");
      return;
    }
    const submitWork = await automaticOpportunitySubmitWorkPending();
    if (submitWork.pending) {
      const submitWakeDelay = submitWork.nextWakeAt ? Math.max(250, submitWork.nextWakeAt - Date.now()) : OPPORTUNITY_HISTORY_PREWARM_POLL_MS;
      scheduleOpportunityHistoryPrewarm(Math.min(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, submitWakeDelay), "submit-pending");
      return;
    }
    const [storePage, syncPage] = await Promise.all([
      service().request("records.list", { storeName: "stores", limit: 50000 }, { priority: "interactive" }),
      service().request("records.list", { storeName: "opportunity_submit_history_sync_v1", limit: 50000 }, { priority: "maintenance" })
    ]);
    const stores = (Array.isArray(storePage?.items) ? storePage.items : [])
      .filter((store) => store?.status === "online");
    const syncRecords = Array.isArray(syncPage?.items) ? syncPage.items : [];
    const dueStores = dueOpportunityHistoryPrewarmStores(stores, syncRecords, {
      nowMs: Date.now(),
      ...policy,
      lastAttemptByShopId: opportunityHistoryPrewarmLastAttemptByShopId
    });
    if (dueStores.length) {
      const store = dueStores[0];
      const shopId = String(store.shopId || store.id || "");
      opportunityHistoryPrewarmLastAttemptByShopId.set(shopId, new Date().toISOString());
      const result = await startOpportunityHistoryPrewarm(store, snapshot, trigger);
      if (result.started) {
        opportunityHistoryPrewarmNextAllowedAt = Date.now() + policy.interSliceDelayMs;
        scheduleOpportunityHistoryPrewarm(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, "prewarm-running");
        return;
      }
      if (result.reason === "authorization-wait") {
        scheduleOpportunityHistoryPrewarm(policy.retryMs, result.reason);
        return;
      }
    }
    const nextWakeAt = nextOpportunityHistoryPrewarmWakeAt(stores, syncRecords, {
      ...policy,
      lastAttemptByShopId: opportunityHistoryPrewarmLastAttemptByShopId
    });
    const delay = nextWakeAt === null
      ? OPPORTUNITY_HISTORY_PREWARM_POLL_MS
      : Math.min(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, Math.max(250, nextWakeAt - Date.now()));
    scheduleOpportunityHistoryPrewarm(delay, "scheduled");
  })().catch((error) => {
    console.warn("[opportunity-history-prewarm] scheduler tick failed:", error?.message || error);
    scheduleOpportunityHistoryPrewarm(OPPORTUNITY_HISTORY_PREWARM_POLL_MS, "retry-after-error");
  }).finally(() => {
    opportunityHistoryPrewarmTickPromise = null;
  });
  return opportunityHistoryPrewarmTickPromise;
}

function notifyOpportunityHistoryPrewarm(reason = "external") {
  scheduleOpportunityHistoryPrewarm(500, reason);
}

function startOpportunityHistoryPrewarmScheduler() {
  if (opportunityHistoryPrewarmStarted) return;
  opportunityHistoryPrewarmStarted = true;
  opportunityHistoryPrewarmLastForegroundActivityAt = Date.now();
  scheduleOpportunityHistoryPrewarm(2000, "app-startup");
}

function stopOpportunityHistoryPrewarmScheduler() {
  opportunityHistoryPrewarmStarted = false;
  if (opportunityHistoryPrewarmTimer) clearTimeout(opportunityHistoryPrewarmTimer);
  opportunityHistoryPrewarmTimer = null;
}

async function runnerEvent(event, message = {}) {
  const principal = requireWebContentsPrincipal(event, ["runner"]);
  const context = runnerContexts.get(event.sender.id);
  if (!context || principal.ownerOperationId !== context.operationId || message.operationId !== context.operationId) {
    throw taskError("TASK_RESULT_DENIED", "runner result does not belong to this operation");
  }
  if (!["task:progress", "task:heartbeat", "task:result", "task:error"].includes(message.type)) throw taskError("TASK_RESULT_DENIED", "runner event type is invalid");
  context.lastHeartbeatAt = Date.now();
  if (message.type === "task:heartbeat" || message.type === "task:error") {
    const previousMutationStarted = context.mutationStarted === true;
    const previousInFlightMutations = Number(context.inFlightMutations || 0);
    context.mutationStarted = previousMutationStarted || message.mutationStarted === true;
    context.inFlightMutations = Math.max(0, Number(message.inFlightMutations || 0));
    if (context.mutationStarted !== previousMutationStarted || context.inFlightMutations !== previousInFlightMutations) {
      await writeOperationEvidence(context, context.cancellationRequested ? "cancelling" : "running", {
        mutationStarted: context.mutationStarted,
        inFlightMutations: context.inFlightMutations
      }).catch(() => undefined);
    }
  }
  if (message.type === "task:progress") {
    const progress = Math.max(0, Math.min(100, Number(message.progress || 0)));
    context.lastProgress = progress;
    context.lastProgressAt = Date.now();
    await writeOperationEvidence(context, "running", { progress }).catch(() => undefined);
  }
  let ownerMessage = message;
  if (message.type === "task:result") {
    const persistence = taskResultPersistence(message.result);
    if (!persistence.messageAllowed) {
      const error = "runner result exceeded the maximum message size";
      const terminalStatus = context.mutation ? "reconciling" : "failed";
      await writeOperationEvidence(context, terminalStatus, { error, resultSummary: error }).catch(() => undefined);
      ownerMessage = { type: "task:error", operationId: context.operationId, error };
    } else {
      const existing = await service().request("records.get", { storeName: "operations", id: context.operationId }, { priority: "interactive" }).catch(() => null);
      const terminalStatus = terminalTaskStatus({
        result: message.result,
        resultSummary: String(message.resultSummary || ""),
        mutation: context.mutation,
        currentStatus: String(existing?.status || "running")
      });
      const patch = {
        progress: terminalTaskProgress({
          taskType: context.taskType,
          terminalStatus,
          currentProgress: existing?.progress
        }),
        resultSummary: String(message.resultSummary || "completed").slice(0, 2000),
        ...(persistence.persistResult ? { result: message.result } : { resultOmitted: true, resultBytes: persistence.bytes })
      };
      await writeOperationEvidence(context, terminalStatus, patch).catch(() => undefined);
      await syncOpportunityPipelineSourceOperation(context).catch((error) => {
        console.warn("[opportunity-submit-recovery] source operation sync failed:", error?.message || error);
      });
    }
  } else if (message.type === "task:error") {
    const terminalStatus = context.mutation && context.mutationStarted ? "reconciling" : "failed";
    const error = String(message.error || "runner task failed").slice(0, 4000);
    await writeOperationEvidence(context, terminalStatus, { error, resultSummary: error }).catch(() => undefined);
    ownerMessage = { ...message, error };
  }
  sendOwnerEvent(context, ownerMessage);
  if (message.type === "task:result" || message.type === "task:error") {
    setTimeout(() => void closeRunnerContext(context, "task completed", { terminal: true }), 50);
  }
  return { ok: true };
}

async function cancelRunner(event, request = {}) {
  requireWebContentsPrincipal(event, ["main"]);
  const context = operationContexts.get(String(request.operationId || ""));
  if (!context || context.ownerWebContentsId !== event.sender.id) return { ok: false, code: "TASK_OPERATION_DENIED", message: "找不到属于当前页面的任务" };
  context.cancellationRequested = true;
  if (context.runnerWebContents && !context.runnerWebContents.isDestroyed()) {
    await writeOperationEvidence(context, "cancelling", { resultSummary: "cancellation requested" }).catch(() => undefined);
    context.runnerWebContents.send("chihu:tasks:command", { type: "task:cancel", operationId: context.operationId });
    return { ok: true, operationId: context.operationId, status: "cancelling", runnerAlive: true };
  }
  const interruptedStatus = interruptedTaskStatus({
    mutation: context.mutation,
    mutationStarted: context.mutationStarted,
    inFlightMutations: context.inFlightMutations,
    cancellationRequested: true
  });
  await closeRunnerContext(context, "runner unavailable during cancellation");
  return { ok: true, operationId: context.operationId, status: interruptedStatus, runnerAlive: false };
}

async function recoverRunner(event, request = {}) {
  requireWebContentsPrincipal(event, ["main"]);
  const operationId = String(request.operationId || "");
  if (!operationId) return { ok: false, code: "TASK_PARAMS_INVALID", message: "operationId is required" };
  const activeContext = operationContexts.get(operationId);
  if (activeContext) return { ok: true, operationId, status: "started", recoveryActive: activeContext.accessTier === "recovery" };
  const record = await service().request("records.get", { storeName: "operations", id: operationId }, { priority: "interactive" }).catch(() => null);
  const evidence = record?.taskEvidence;
  if (!record || !evidence?.paidGrantedAtStart || !["running", "cancelling", "interrupted", "reconciling"].includes(String(record.status))) {
    return { ok: false, code: "TASK_TYPE_DENIED", message: "该 operation 不具备受限恢复条件" };
  }
  if (record.taskType !== "marketingTask") {
    return { ok: false, code: "TASK_TYPE_DENIED", message: "当前版本仅支持营销 operation 的受限恢复" };
  }
  const snapshot = currentSnapshot(String(evidence.releaseId || ""));
  const definition = TASK_DEFINITIONS.marketingReconcile;
  if (!snapshot || !featureEnabled(definition, snapshot)) return { ok: false, code: "TASK_TYPE_DENIED", message: "恢复所需发布快照不可用" };
  if (evidence.adapterSnapshotHash !== snapshot.adapterSnapshotHash) return { ok: false, code: "TASK_TYPE_DENIED", message: "原任务发布快照不可用，请转人工对账" };
  const evidenceRecoveryPlanKeys = Array.isArray(evidence.recoveryPlanKeys) ? evidence.recoveryPlanKeys : [];
  if (!evidenceRecoveryPlanKeys.length) return { ok: false, code: "TASK_TYPE_DENIED", message: "原任务缺少受限对账能力证据，请转人工对账" };
  const context = {
    runnerWebContentsId: 0,
    runnerWebContents: null,
    ownerWebContentsId: event.sender.id,
    ownerNavigationEpoch: requireWebContentsPrincipal(event, ["main"]).navigationEpoch,
    operationId,
    taskType: record.taskType,
    accessTier: "recovery",
    mutation: true,
    paidGrantedAtStart: true,
    principalNavigationEpoch: 1,
    releaseId: snapshot.releaseId,
    releaseManifestHash: snapshot.releaseManifestHash,
    runnerArtifactHash: snapshot.runnerArtifactHash,
    adapterSnapshotHash: evidence.adapterSnapshotHash || snapshot.adapterSnapshotHash,
    allowedPlanKeys: new Set(evidenceRecoveryPlanKeys.filter((planKey) => snapshot.adapter?.requestPlans?.[planKey] && snapshot.adapter.requestPlans[planKey].mutation !== true)),
    recoveryPlanKeys: new Set(evidenceRecoveryPlanKeys),
    allowedPlatformOrigins: new Set(platformOrigins(snapshot.adapter)),
    allowedPartitions: new Set(Array.isArray(evidence.allowedPartitions) ? evidence.allowedPartitions : []),
    allowedPartitionPrefixes: new Set(Array.isArray(evidence.allowedPartitionPrefixes) ? evidence.allowedPartitionPrefixes : []),
    allowedStoreRefs: Array.isArray(evidence.allowedStoreRefs) ? evidence.allowedStoreRefs : [],
    allowedDataScopes: materializeDataScopes(definition.allowedDataScopes, operationId),
    childWindowIds: new Set(),
    childWindowPartitions: new Map(),
    programmaticWindowCloseIds: new Set(),
    activePlanGrants: new Map(),
    httpGrants: new Map(),
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgress: Number(record.progress || 0),
    mutationStarted: record.mutationStarted !== false,
    inFlightMutations: Math.max(0, Number(record.inFlightMutations || 0)),
    closed: false
  };
  operationContexts.set(operationId, context);
  await writeOperationEvidence(context, "reconciling");
  createRunnerWindow(context, snapshot, {
    taskType: "marketingReconcile",
    operationId,
    payload: { operationId, sourceOperationId: operationId }
  });
  context.lifetimeTimer = setTimeout(() => void closeRunnerContext(context, "recovery runner lifetime exceeded"), MAX_RUNNER_LIFETIME_MS);
  context.heartbeatTimer = setInterval(() => {
    if (Date.now() - context.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) void closeRunnerContext(context, "recovery runner heartbeat expired");
  }, 5000);
  return { ok: true, operationId, status: "started", recoveryActive: true };
}

async function taskStatus(event, request = {}) {
  requireWebContentsPrincipal(event, ["main"]);
  const operationId = String(request.operationId || "");
  if (!operationId) throw taskError("TASK_PARAMS_INVALID", "operationId is required");
  const record = await service().request("records.get", { storeName: "operations", id: operationId }, { priority: "interactive" });
  return record ? { ...record, runnerAlive: operationContexts.has(operationId) } : null;
}

async function listTaskStatus(event) {
  requireWebContentsPrincipal(event, ["main"]);
  const result = await service().request("records.queryOperations", { statuses: ["created", "running", "cancelling", "interrupted", "reconciling"] }, { priority: "interactive" });
  const records = Array.isArray(result) ? result : result?.items || [];
  return records.map((record) => ({ ...record, runnerAlive: operationContexts.has(String(record?.operationId || record?.id || "")) }));
}

async function interruptPersistedTask(event, request = {}) {
  requireWebContentsPrincipal(event, ["main"]);
  const operationId = String(request.operationId || "");
  if (!operationId) throw taskError("TASK_PARAMS_INVALID", "operationId is required");
  const active = operationContexts.get(operationId);
  if (active) return taskStatus(event, { operationId });
  const record = await service().request("records.get", { storeName: "operations", id: operationId }, { priority: "interactive" }).catch(() => null);
  if (!record) return null;
  if (["succeeded", "partial", "failed", "cancelled"].includes(String(record.status))) return { ...record, runnerAlive: false };
  const mutation = record?.taskEvidence?.mutation === true || record?.metadata?.mutation === true;
  const now = new Date().toISOString();
  const nextStatus = interruptedTaskStatus({
    mutation,
    mutationStarted: record.mutationStarted,
    inFlightMutations: record.inFlightMutations,
    currentStatus: String(record.status || "running")
  });
  const next = {
    ...record,
    status: nextStatus,
    resultSummary: nextStatus === "cancelled" ? "cancelled" : mutation ? "runner missing; reconciliation required" : "read task interrupted; start a new query",
    ...(nextStatus === "cancelled" ? {} : { error: String(request.reason || "runner missing after application restart").slice(0, 4000) }),
    updatedAt: now
  };
  await service().request("records.put", { storeName: "operations", record: next }, { priority: "write" });
  return { ...next, runnerAlive: false };
}

async function authorizeRunnerPlan(event, request = {}) {
  const principal = requireWebContentsPrincipal(event, ["runner"]);
  const context = getRunnerContextForSender(event.sender);
  const planKey = String(request.planKey || "");
  if (!context || principal.ownerOperationId !== context.operationId || !context.allowedPlanKeys.has(planKey)) {
    throw taskError("TASK_PLAN_DENIED", "request plan is outside the runner capability scope");
  }
  const serializedContext = JSON.stringify(request.context || {});
  if (serializedContext.length > 2 * 1024 * 1024) throw taskError("TASK_PARAMS_INVALID", "request plan context is too large");
  const snapshot = currentSnapshot(context.releaseId);
  if (!snapshot || snapshot.adapterSnapshotHash !== context.adapterSnapshotHash) throw taskError("TASK_PLAN_DENIED", "runner snapshot is no longer available");
  const grant = planHttpGrant(snapshot, planKey);
  context.activePlanGrants.set(planKey, grant);
  const transport = request.transport;
  if (!transport) return { ok: true, planKey, expiresAt: grant.expiresAt };
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) throw taskError("TASK_PARAMS_INVALID", "request transport must be an object");
  if (!runnerPartitionAllowed(context, transport.partition)) throw taskError("TASK_PLAN_DENIED", "request partition is outside the runner scope");
  if (!transportMatchesPlan(grant, transport) || !transportMatchesPlanTemplate(snapshot.adapter, planKey, request.context || {}, transport)) {
    throw taskError("TASK_PLAN_DENIED", "request transport does not match the verified plan");
  }
  const now = Date.now();
  for (const [grantId, value] of context.httpGrants) {
    if (value.expiresAt <= now) context.httpGrants.delete(grantId);
  }
  if (context.httpGrants.size >= 32) throw taskError("TASK_PLAN_DENIED", "too many pending request grants");
  const grantId = crypto.randomBytes(18).toString("base64url");
  const expiresAt = now + 15_000;
  context.httpGrants.set(grantId, {
    planKey,
    fingerprint: httpTransportFingerprint(transport),
    expiresAt
  });
  return { ok: true, planKey, grantId, expiresAt };
}

function consumeRunnerHttpGrant(context, args = {}) {
  if (!context) return false;
  const grantId = String(args.taskGrantId || "");
  const grant = context.httpGrants.get(grantId);
  if (!grant) return null;
  context.httpGrants.delete(grantId);
  if (grant.expiresAt <= Date.now()) return null;
  if (!runnerPartitionAllowed(context, args.partition) || grant.fingerprint !== httpTransportFingerprint(args)) return null;
  return grant;
}

function runnerHttpAllowed(context, args = {}) {
  return Boolean(consumeRunnerHttpGrant(context, args));
}

function runnerCookieAllowed(context, channel, args = {}) {
  if (!context) return false;
  const partition = String(args.partition || args.oldPartition || args.fromPartition || "");
  const targetPartition = String(args.newPartition || args.toPartition || "");
  if (["copy_cookies", "native:cookies:copy"].includes(channel)) {
    return context.taskType === "fetchDoudianStores" && runnerPartitionAllowed(context, partition) && runnerPartitionAllowed(context, targetPartition);
  }
  if (["clear_session", "native:cookies:clear"].includes(channel)) {
    return runnerPartitionAllowed(context, partition);
  }
  if (!["native:cookies:getHeader", "native:cookies:remove"].includes(channel) || !runnerPartitionAllowed(context, partition)) return false;
  const grants = [...context.activePlanGrants.values()].filter((grant) => grant.expiresAt > Date.now());
  if (!grants.length) return false;
  if (typeof args.url === "string" && args.url.trim()) {
    try {
      const target = new URL(args.url);
      return grants.some((grant) => grant.cookieOrigins.has(target.origin) || [...grant.cookieDomains].some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`)));
    } catch {
      return false;
    }
  }
  const domain = cookieDomain(args.domain);
  return Boolean(domain && grants.some((grant) => [...grant.cookieDomains].some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`) || allowed.endsWith(`.${domain}`))));
}

function getRunnerContextForSender(senderOrId) {
  const id = typeof senderOrId === "number" ? senderOrId : senderOrId?.id;
  return runnerContexts.get(id) || null;
}

function runnerWindowCommand(event, request = {}) {
  const principal = requireWebContentsPrincipal(event, ["runner"]);
  const context = getRunnerContextForSender(event.sender);
  if (!context || principal.ownerOperationId !== context.operationId || !runnerOwnsWindow(event, request.winId)) {
    throw taskError("TASK_WINDOW_DENIED", "runner does not own the target platform window");
  }
  if (request.code !== undefined || request.jsContent !== undefined) {
    throw taskError("TASK_WINDOW_DENIED", "arbitrary platform window scripts are not accepted");
  }
  const snapshot = currentSnapshot(context.releaseId);
  if (!snapshot || snapshot.adapterSnapshotHash !== context.adapterSnapshotHash || !snapshot.windowCommands) {
    throw taskError("TASK_WINDOW_DENIED", "verified window command snapshot is no longer available");
  }
  const command = String(request.command || "");
  const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {};
  const partition = context.childWindowPartitions.get(Number(request.winId));
  if (!partition || !runnerPartitionAllowed(context, partition)) throw taskError("TASK_WINDOW_DENIED", "platform window partition is outside the runner scope");

  let payload = {};
  if (command === "collect-role-shop-names" || command === "is-home-page") {
    if (context.taskType !== "fetchDoudianStores") throw taskError("TASK_WINDOW_DENIED", "login probe command is outside the task scope");
  } else if (command === "switch-shop") {
    if (!["fetchDoudianStores", "businessData"].includes(context.taskType)) throw taskError("TASK_WINDOW_DENIED", "shop switch command is outside the task scope");
    const shop = args.shop && typeof args.shop === "object" && !Array.isArray(args.shop) ? args.shop : {};
    payload = {
      adapter: snapshot.adapter,
      shop: { shopId: String(shop.shopId || shop.id || ""), shopName: String(shop.shopName || "").slice(0, 500) }
    };
  } else if (command === "sign") {
    const planKey = String(args.planKey || "");
    const grant = context.activePlanGrants.get(planKey);
    const targetUrl = String(args.targetUrl || "");
    if (!grant || grant.expiresAt <= Date.now() || !context.allowedPlanKeys.has(planKey) || !transportMatchesPlan(grant, { url: targetUrl, method: grant.method })) {
      throw taskError("TASK_WINDOW_DENIED", "sign command is outside the active request plan");
    }
    payload = {
      targetUrl,
      adapter: snapshot.adapter,
      plan: snapshot.adapter.requestPlans[planKey],
      context: { ...(args.context || {}), partition }
    };
  } else if (command === "page-fetch") {
    const planKey = String(args.planKey || "");
    const transport = args.transport && typeof args.transport === "object" && !Array.isArray(args.transport) ? args.transport : {};
    const consumed = consumeRunnerHttpGrant(context, { ...transport, taskGrantId: request.taskGrantId });
    if (!consumed || consumed.planKey !== planKey || String(transport.partition || "") !== partition) {
      throw taskError("TASK_WINDOW_DENIED", "page fetch command lacks a matching one-time request grant");
    }
    payload = { transport };
  } else {
    throw taskError("TASK_WINDOW_DENIED", "window command is not registered for task runners");
  }
  return {
    script: taskWindowCommandScript(snapshot, command, payload),
    timeoutMs: Math.max(1000, Math.min(122000, Number(request.timeoutMs || 15000)))
  };
}

function taskChildTarget(event, targetUrl, partition = "") {
  const context = getRunnerContextForSender(event?.sender);
  if (!context) return null;
  const target = new URL(targetUrl);
  if (!["http:", "https:"].includes(target.protocol) || !context.allowedPlatformOrigins.has(target.origin)) {
    throw taskError("TASK_WINDOW_DENIED", "platform window URL is outside the verified task origin scope");
  }
  if (partition && !runnerPartitionAllowed(context, partition)) throw taskError("TASK_WINDOW_DENIED", "platform window partition is outside the runner scope");
  return { context, target };
}

function registerTaskChildWindow(event, child, targetUrl, partition = "") {
  const resolved = taskChildTarget(event, targetUrl, partition);
  if (!resolved) return null;
  const { context, target } = resolved;
  context.childWindowIds.add(child.id);
  context.childWindowPartitions.set(child.id, String(partition));
  registerWebContentsPrincipal(child.webContents, {
    role: "platform-child",
    expectedUrl: target.toString(),
    ownerOperationId: context.operationId,
    allowedPlatformOrigins: [target.origin]
  });
  child.on("close", () => {
    if (context.closed || context.programmaticWindowCloseIds.has(child.id)) return;
    if (context.taskType !== "fetchDoudianStores" || !child.isVisible() || context.cancellationRequested) return;
    context.cancellationRequested = true;
    if (context.runnerWebContents && !context.runnerWebContents.isDestroyed()) {
      context.runnerWebContents.send("chihu:tasks:command", { type: "task:cancel", operationId: context.operationId });
    }
  });
  child.once("closed", () => {
    context.childWindowIds.delete(child.id);
    context.childWindowPartitions.delete(child.id);
    context.programmaticWindowCloseIds.delete(child.id);
  });
  return context;
}

function markRunnerWindowProgrammaticClose(event, winId) {
  const context = getRunnerContextForSender(event?.sender);
  if (context && context.childWindowIds.has(Number(winId))) context.programmaticWindowCloseIds.add(Number(winId));
}

function runnerOwnsWindow(event, winId) {
  const context = getRunnerContextForSender(event?.sender);
  return Boolean(context && context.childWindowIds.has(Number(winId)));
}

function installTaskHandlers() {
  if (installed) return;
  installed = true;
  ipcMain.handle("native:tasks:getCatalog", async (event) => {
    requireWebContentsPrincipal(event, ["main"]);
    return publicTaskCatalog();
  });
  ipcMain.handle("native:tasks:startRunner", startRunner);
  ipcMain.handle("native:tasks:cancelRunner", cancelRunner);
  ipcMain.handle("native:tasks:recover", recoverRunner);
  ipcMain.handle("native:tasks:getStatus", taskStatus);
  ipcMain.handle("native:tasks:listStatus", listTaskStatus);
  ipcMain.handle("native:tasks:interrupt", interruptPersistedTask);
  ipcMain.handle("native:tasks:runnerEvent", runnerEvent);
  ipcMain.handle("native:tasks:authorizePlan", authorizeRunnerPlan);
  onPrincipalRevoked((principal) => {
    const context = runnerContexts.get(principal.webContentsId);
    if (context) void closeRunnerContext(context, principal.revokeReason || "principal revoked");
    if (principal.role === "main") {
      for (const owned of [...runnerContexts.values()].filter((item) => item.ownerWebContentsId === principal.webContentsId)) {
        void closeRunnerContext(owned, "owner principal revoked");
      }
    }
  });
}

module.exports = {
  getRunnerContextForSender,
  markRunnerWindowProgrammaticClose,
  installTaskHandlers,
  notifyOpportunityHistoryPrewarm,
  notifyOpportunitySubmitRecovery,
  nudgeOpportunitySubmitRecovery,
  registerTaskChildWindow,
  runnerCookieAllowed,
  runnerHttpAllowed,
  runnerOwnsWindow,
  runnerWindowCommand,
  startOpportunityHistoryPrewarmScheduler,
  startOpportunitySubmitRecoveryScheduler,
  stopOpportunityHistoryPrewarmScheduler,
  stopOpportunitySubmitRecoveryScheduler,
  taskChildTarget
};
