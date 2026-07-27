import type {
  BridgeSelfCheck,
  DoudianAdapterPayload,
  DoudianBulkDeleteAction,
  DoudianBulkDeleteFilters,
  DoudianBulkDeleteProgress,
  DoudianBulkDeleteResult,
  DoudianBusinessDataResult,
  DoudianFundsDataResult,
  DoudianFreightTemplateResult,
  DoudianOpportunityFilters,
  DoudianOpportunityGoodsMatchType,
  DoudianOpportunityCandidatePage,
  DoudianOpportunityMatchRules,
  DoudianOpportunityFavoritesResult,
  DoudianOpportunityFavoriteCategory,
  DoudianOpportunityFavoriteRecordsResult,
  DoudianOpportunityFavoriteCancelResult,
  DoudianOpportunityAutoFavoriteFilters,
  DoudianOpportunityAutoFavoritesResult,
  DoudianOpportunityPrematchMode,
  DoudianOpportunityReportResult,
  DoudianOpportunityStoreCategoryLedger,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianStaleGoodsCleanupResult,
  DoudianStaleGoodsRules,
  DoudianStoreIdentityRef,
  DoudianStoreResult,
  DoudianViolationsDataResult
} from "../types";
import type { NativeMainZoomResult, NativePageScale, NativeUpdateStartRequest, NativeUpdateVersionData, NativeUpdateVersionRequest } from "../native/types";
import { getChihuNative } from "../native/client";
import {
  createStoreGroup,
  deleteEmptyStoreGroup,
  deleteStoreLedger,
  fetchBusinessDataLatest,
  fetchFundsDataLatest,
  fetchOpportunityPipelineRun,
  fetchOpportunityPipelineSummary,
  fetchOpportunityReportLatest,
  listOpportunityPipelineCandidatesPage,
  listOpportunityStoreCategoryLedger,
  restoreBulkDeleteExecute,
  restoreBulkDeleteScan,
  restoreLatestStaleGoodsScan,
  restoreStaleGoodsExecute,
  restoreStaleGoodsScan,
  fetchViolationsDataLatest,
  cancelOpportunityFavoriteRecords,
  addDoudianProgressListener,
  listStoreLedger,
  openStoreWindow,
  startDoudianTask,
  runDoudianStoreTask,
  cancelDoudianTask,
  renameStoreGroup,
  resubscribeDoudianTasks,
  runProductCatalogSyncTask,
  updateStoreGroup,
  type DoudianOperationRecord
} from "../domain/doudian";
import { selectAndParseCompassFile as selectAndParseCompassFileRemote } from "../domain/doudian/fileImport";
import { withDoudianAdapter } from "./doudianAdapter";

export function missingBridgeSelfCheck(): BridgeSelfCheck {
  return {
    ok: false,
    hasClient: false,
    methodCount: 0,
    expectedMethodCount: 0,
    missingMethods: ["chihuBridge"]
  };
}

export async function runBridgeSelfCheck(): Promise<BridgeSelfCheck> {
  if (!window.chihuBridge) return missingBridgeSelfCheck();
  return window.chihuBridge.selfCheck();
}

export async function minimizeMainWindow() {
  const native = getChihuNative();
  if (native?.windows.minimize) {
    await native.windows.minimize({});
    return true;
  }
  if (!window.client || typeof window.client.minimizeWindow !== "function") return false;
  await window.client.minimizeWindow({});
  return true;
}

export async function toggleMaximizeMainWindow() {
  const native = getChihuNative();
  if (native?.windows.maximize) {
    await native.windows.maximize({});
    return true;
  }
  if (!window.client || typeof window.client.maximizeWindow !== "function") return false;
  await window.client.maximizeWindow({});
  return true;
}

export async function closeMainWindow() {
  const native = getChihuNative();
  if (native?.windows.close) {
    await native.windows.close({});
    return true;
  }
  if (!window.client || typeof window.client.closeWindow !== "function") return false;
  await window.client.closeWindow({});
  return true;
}

export async function reloadMainWindowUrl(url?: string) {
  const args = url ? { url } : {};
  const native = getChihuNative();
  if (native?.windows.reloadHome) {
    await native.windows.reloadHome(args);
    return true;
  }
  const legacyReloadHome = window.client?.reloadHomeUrl;
  if (typeof legacyReloadHome === "function") {
    await legacyReloadHome.call(window.client, args);
    return true;
  }
  return false;
}

export function mainZoomSupported() {
  const native = getChihuNative();
  return typeof native?.windows.setMainZoom === "function" || typeof window.client?.setMainZoom === "function";
}

export async function setMainZoom(factor: NativePageScale): Promise<NativeMainZoomResult> {
  const native = getChihuNative();
  if (native?.windows.setMainZoom) {
    return native.windows.setMainZoom({ factor });
  }
  if (typeof window.client?.setMainZoom === "function") {
    return window.client.setMainZoom({ factor }) as Promise<NativeMainZoomResult>;
  }
  return { ok: false, factor, message: "main_zoom_bridge_unavailable" };
}

export async function getDesktopVersionData(args: NativeUpdateVersionRequest = {}): Promise<NativeUpdateVersionData> {
  const native = getChihuNative();
  if (native?.updates.getVersionData) {
    return native.updates.getVersionData(args);
  }

  const legacyGetVersionData = window.client?.getClientVersionData;
  if (typeof legacyGetVersionData === "function") {
    return legacyGetVersionData.call(window.client, args) as Promise<NativeUpdateVersionData>;
  }

  return {
    ok: false,
    status: "unavailable",
    channel: args.channel || "",
    reason: "local_update_bridge_unavailable",
    hasUpdate: false,
    isNewVersion: true,
    currentVersion: "",
    latestVersion: "",
    newVersion: ""
  };
}

export async function startDesktopUpdate(args: NativeUpdateStartRequest = {}) {
  const native = getChihuNative();
  if (native?.updates.start) {
    return native.updates.start(args);
  }

  const legacyStartUpdate = window.client?.startAutoUpdate;
  if (typeof legacyStartUpdate === "function") {
    return legacyStartUpdate.call(window.client, args);
  }

  return { ok: false, reason: "local_update_bridge_unavailable" };
}

export async function openPlatformWindow(args: {
  url: string;
  title?: string;
  partition?: string;
  width?: number;
  height?: number;
}): Promise<{ ok: boolean; id?: unknown; message?: string }> {
  const native = getChihuNative();
  if (native?.windows.open) {
    const id = await native.windows.open({
      url: args.url,
      title: args.title || "Chihu Manager - Platform Page",
      partition: args.partition || "persist:chihu-doudian-shared",
      width: args.width || 1280,
      height: args.height || 820,
      show: true,
      nodeIntegration: false,
      contextIsolation: true
    });
    return { ok: true, id };
  }
  if (!window.client || typeof window.client.openWindow !== "function") {
    return { ok: false, message: "local window bridge unavailable" };
  }
  const id = await window.client.openWindow({
    url: args.url,
    title: args.title || "Chihu Manager - Platform Page",
    partition: args.partition || "persist:chihu-doudian-shared",
    width: args.width || 1280,
    height: args.height || 820,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true
  });
  return { ok: true, id };
}

export async function listDoudianStores(): Promise<DoudianStoreResult> {
  return listStoreLedger();
}

export interface FetchDoudianStoresOptions {
  mode?: "import" | "discover" | "login_selected" | "discard_discovery";
  repairShopIds?: string[];
  repairShopNames?: string[];
  sourceOperationId?: string;
}

export async function fetchDoudianStores(
  operationId?: string,
  options: FetchDoudianStoresOptions = {},
  onStarted?: (operationId: string) => void
): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({
    ...(operationId ? { operationId } : {}),
    ...options
  });
  const loginTimeoutMs = Math.max(3000, Number(args.doudianAdapter.adapter.timeouts?.loginMs || 300000));
  return runDoudianStoreTask({
    taskType: "fetchDoudianStores",
    operationId,
    adapterVersion: args.doudianAdapter.adapter.version,
    ruleVersion: args.doudianAdapter.scripts?.version || "",
    payload: {
      doudianAdapter: args.doudianAdapter,
      mode: options.mode || "import",
      repairShopIds: options.repairShopIds || [],
      repairShopNames: options.repairShopNames || [],
      sourceOperationId: options.sourceOperationId || "",
      timeoutMs: loginTimeoutMs
    }
  }, loginTimeoutMs + 60000, onStarted);
}

export async function refreshDoudianStoreStatus(
  shopIds?: string[],
  operationId?: string,
  onStarted?: (operationId: string) => void
): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({ shopIds: shopIds || [], ...(operationId ? { operationId } : {}) });
  return runDoudianStoreTask({
    taskType: "refreshDoudianStoreStatus",
    operationId,
    adapterVersion: args.doudianAdapter.adapter.version,
    ruleVersion: args.doudianAdapter.scripts?.version || "",
    payload: {
      doudianAdapter: args.doudianAdapter,
      shopIds: shopIds || []
    }
  }, 180000, onStarted);
}

export async function syncDoudianProductCatalog(args: {
  shopIds?: string[];
  tenantId?: string;
  storeGeneration?: number;
  operationId?: string;
  forceRefresh?: boolean;
  forceAdapter?: boolean;
} = {}): Promise<DoudianStoreResult & { coverageKeys?: string[] }> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(args.storeGeneration ? { storeGeneration: args.storeGeneration } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {}),
    ...(args.forceRefresh ? { forceRefresh: args.forceRefresh } : {})
  }, { force: args.forceAdapter === true });
  return runDoudianStoreTask({
    taskType: "syncProductCatalog",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    payload: nextArgs
  }, 600000) as Promise<DoudianStoreResult & { coverageKeys?: string[] }>;
}

export async function syncDoudianProductCatalogInline(args: Parameters<typeof runProductCatalogSyncTask>[0]) {
  return runProductCatalogSyncTask(args);
}

export async function fetchDoudianBusinessData(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  operationId?: string;
  forceAdapter?: boolean;
} = {}, onStarted?: (operationId: string) => void): Promise<DoudianBusinessDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const dedupeKey = JSON.stringify({
    shopIds: [...(args.shopIds || [])].sort(),
    datePreset: args.datePreset || "today",
    beginDate: args.beginDate || "",
    endDate: args.endDate || "",
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  return runDoudianStoreTask({
    taskType: "businessData",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: { dedupeKey, replaceActive: true },
    payload: nextArgs
  }, 900000, onStarted) as Promise<DoudianBusinessDataResult>;
}

export async function fetchDoudianBusinessDataLatest(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianBusinessDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {})
  }, { force: args.forceAdapter === true });
  return fetchBusinessDataLatest(nextArgs);
}

export async function fetchDoudianFundsData(args: {
  shopIds?: string[];
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianFundsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const dedupeKey = JSON.stringify({
    shopIds: [...(args.shopIds || [])].sort(),
    view: "current-snapshot",
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  return runDoudianStoreTask({
    taskType: "fundsData",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: { dedupeKey, replaceActive: true },
    payload: nextArgs
  }, 900000) as Promise<DoudianFundsDataResult>;
}

export async function fetchDoudianFreightTemplates(args: {
  shopIds?: string[];
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianFreightTemplateResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  return runDoudianStoreTask({
    taskType: "productFreightTemplates",
    operationId: args.operationId,
    metadata: { replaceActive: true },
    payload: nextArgs
  }, 600000) as Promise<DoudianFreightTemplateResult>;
}

export async function fetchDoudianFundsDataLatest(args: {
  shopIds?: string[];
  forceAdapter?: boolean;
} = {}): Promise<DoudianFundsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || []
  }, { force: args.forceAdapter === true });
  return fetchFundsDataLatest(nextArgs);
}

export async function fetchDoudianViolationsData(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  processStatus?: string;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianViolationsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
    ...(args.processStatus ? { processStatus: args.processStatus } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const dedupeKey = JSON.stringify({
    shopIds: [...(args.shopIds || [])].sort(),
    datePreset: args.datePreset || "all",
    beginDate: args.beginDate || "",
    endDate: args.endDate || "",
    processStatus: args.processStatus || "",
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  const result = await runDoudianStoreTask({
    taskType: "violationsData",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: { dedupeKey, replaceActive: true },
    payload: nextArgs
  }, 900000) as DoudianViolationsDataResult;
  if (result.recordsDeferred) {
    const cached = await fetchViolationsDataLatest(nextArgs);
    return { ...result, records: cached.records || [], recordsDeferred: false };
  }
  return result;
}

export async function fetchDoudianViolationsDataLatest(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  processStatus?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianViolationsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
    ...(args.processStatus ? { processStatus: args.processStatus } : {})
  }, { force: args.forceAdapter === true });
  return fetchViolationsDataLatest(nextArgs);
}

export async function fetchDoudianStaleGoodsCleanup(args: {
  mode?: "scan" | "execute";
  shopIds?: string[];
  rules?: DoudianStaleGoodsRules;
  action?: "offline" | "recycle" | "delete" | "optimize";
  candidateIds?: string[];
  sourceRunId?: string;
  confirmText?: string;
  compassFileName?: string;
  compassRows?: Array<Record<string, unknown>>;
  compassPeriod?: "7d" | "30d" | "90d";
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianStaleGoodsCleanupResult> {
  const nextArgs = await withDoudianAdapter({
    mode: args.mode || "scan",
    shopIds: args.shopIds || [],
    ...(args.rules ? { rules: args.rules } : {}),
    ...(args.action ? { action: args.action } : {}),
    ...(args.candidateIds?.length ? { candidateIds: args.candidateIds } : {}),
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
    ...(args.confirmText ? { confirmText: args.confirmText } : {}),
    ...(args.compassFileName ? { compassFileName: args.compassFileName } : {}),
    ...(args.compassRows?.length ? { compassRows: args.compassRows } : {}),
    ...(args.compassPeriod ? { compassPeriod: args.compassPeriod } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const mode = args.mode || "scan";
  const operationId = args.operationId;
  const dedupeKey = mode === "scan"
    ? JSON.stringify({ mode, shopIds: [...(args.shopIds || [])].sort(), rules: args.rules || null, compassFileName: args.compassFileName || "", compassPeriod: args.compassPeriod || "", adapterVersion: nextArgs.doudianAdapter.adapter.version || "" })
    : JSON.stringify({ mode, sourceRunId: args.sourceRunId || "", action: args.action || "", candidateIds: [...(args.candidateIds || [])].sort(), adapterVersion: nextArgs.doudianAdapter.adapter.version || "" });
  const result = await runDoudianStoreTask({
    taskType: mode === "scan" ? "staleGoodsScan" : "staleGoodsExecute",
    operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: { dedupeKey, replaceActive: true },
    payload: nextArgs
  }, 900000) as DoudianStaleGoodsCleanupResult;
  if (mode === "scan" && result.candidatesDeferred) {
    const restored = await restoreStaleGoodsScan(result.runId || operationId || "");
    if (restored) return { ...result, ...restored, ok: result.ok, status: result.status, message: result.message, operationId: result.operationId || operationId } as DoudianStaleGoodsCleanupResult;
  }
  if (mode === "execute" && result.executionsDeferred) {
    const restored = await restoreStaleGoodsExecute(result.runId || operationId || "");
    if (restored) return { ...result, ...restored, ok: result.ok, status: result.status, message: result.message, operationId: result.operationId || operationId } as DoudianStaleGoodsCleanupResult;
  }
  return result;
}

export async function restoreDoudianStaleGoodsScan(runId?: string) {
  return runId ? restoreStaleGoodsScan(runId) : restoreLatestStaleGoodsScan();
}

export async function restoreDoudianStaleGoodsOperations() {
  return (await resubscribeDoudianTasks()).filter((record) => record.taskType === "staleGoodsScan" || record.taskType === "staleGoodsExecute");
}

export async function fetchDoudianBulkDeleteProducts(args: {
  mode?: "scan" | "execute";
  shopIds?: string[];
  sourceMode?: "range" | "ids";
  filters?: DoudianBulkDeleteFilters;
  action?: DoudianBulkDeleteAction;
  protectMode?: "includeSelling" | "skipSelling";
  candidateIds?: string[];
  sourceRunId?: string;
  allowPartialScan?: boolean;
  confirmText?: string;
  operationId?: string;
  onProgress?: (progress: DoudianBulkDeleteProgress) => void;
  shouldCancel?: () => boolean;
  forceAdapter?: boolean;
} = {}): Promise<DoudianBulkDeleteResult> {
  const mode = args.mode || "scan";
  const operationId = args.operationId || `${mode === "execute" ? "bulkDeleteExecute" : "bulkDeleteScan"}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nextArgs = await withDoudianAdapter({
    mode,
    shopIds: args.shopIds || [],
    ...(args.sourceMode ? { sourceMode: args.sourceMode } : {}),
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.action ? { action: args.action } : {}),
    ...(args.protectMode ? { protectMode: args.protectMode } : {}),
    ...(args.candidateIds?.length ? { candidateIds: args.candidateIds } : {}),
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
    ...(args.allowPartialScan ? { allowPartialScan: true } : {}),
    ...(args.confirmText ? { confirmText: args.confirmText } : {}),
    operationId
  }, { force: args.forceAdapter === true });
  const removeProgressListener = args.onProgress ? addDoudianProgressListener((event) => {
    if (event.detail.operationId !== operationId || !event.detail.bulkDelete) return;
    args.onProgress?.(event.detail.bulkDelete);
  }) : null;
  let result: DoudianBulkDeleteResult;
  try {
    result = await runDoudianStoreTask({
      taskType: mode === "execute" ? "bulkDeleteExecute" : "bulkDeleteScan",
      operationId,
      metadata: { mutation: mode === "execute", replaceActive: true },
      payload: nextArgs
    }, 900000) as DoudianBulkDeleteResult;
  } finally {
    removeProgressListener?.();
  }
  if (mode === "scan" && result.candidatesDeferred) {
    const restored = await restoreBulkDeleteScan(result.runId || operationId || "");
    if (restored) return { ...result, ...restored, ok: result.ok, status: result.status, message: result.message, operationId: result.operationId || operationId } as DoudianBulkDeleteResult;
  }
  if (mode === "execute" && (result.candidatesDeferred || result.executionsDeferred)) {
    const restored = await restoreBulkDeleteExecute(result.runId || operationId || "");
    if (restored) return { ...result, ...restored, ok: result.ok, status: result.status, message: result.message, operationId: result.operationId || operationId } as DoudianBulkDeleteResult;
  }
  return result;
}

export async function fetchDoudianOpportunityReport(args: {
  mode?: "clue-scan" | "product-scan" | "product-prematch" | "pipeline-submit" | "clue-submit" | "product-submit" | "prematch-submit" | "collect" | "latest";
  shopIds?: string[];
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  submitMode?: DoudianOpportunitySubmitMode;
  goodsMatchType?: DoudianOpportunityGoodsMatchType;
  matchMode?: DoudianOpportunityPrematchMode;
  titleMatchMode?: DoudianOpportunityTitleMatchMode;
  titleUpdatePosition?: DoudianOpportunityTitleUpdatePosition;
  clueIds?: string[];
  productIds?: string[];
  candidateIds?: string[];
  sourceRunId?: string;
  productRunId?: string;
  clueRunId?: string;
  matchRunId?: string;
  skipSubmittedClueCategory?: boolean;
  skipSubmittedClue?: boolean;
  skipSubmittedProductInSameClue?: boolean;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityReportResult> {
  const nextArgs = await withDoudianAdapter({
    mode: args.mode || "clue-scan",
    shopIds: args.shopIds || [],
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.matchRules ? { matchRules: args.matchRules } : {}),
    ...(args.submitMode ? { submitMode: args.submitMode } : {}),
    ...(args.goodsMatchType ? { goodsMatchType: args.goodsMatchType } : {}),
    ...(args.matchMode ? { matchMode: args.matchMode } : {}),
    ...(args.titleMatchMode ? { titleMatchMode: args.titleMatchMode } : {}),
    ...(args.titleUpdatePosition ? { titleUpdatePosition: args.titleUpdatePosition } : {}),
    ...(args.clueIds?.length ? { clueIds: args.clueIds } : {}),
    ...(args.productIds?.length ? { productIds: args.productIds } : {}),
    ...(args.candidateIds?.length ? { candidateIds: args.candidateIds } : {}),
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
    ...(args.productRunId ? { productRunId: args.productRunId } : {}),
    ...(args.clueRunId ? { clueRunId: args.clueRunId } : {}),
    ...(args.matchRunId ? { matchRunId: args.matchRunId } : {}),
    ...(args.skipSubmittedClueCategory !== undefined ? { skipSubmittedClueCategory: args.skipSubmittedClueCategory } : {}),
    ...(args.skipSubmittedClue !== undefined ? { skipSubmittedClue: args.skipSubmittedClue } : {}),
    ...(args.skipSubmittedProductInSameClue !== undefined ? { skipSubmittedProductInSameClue: args.skipSubmittedProductInSameClue } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const mode = args.mode || "clue-scan";
  if (["clue-submit", "product-submit", "prematch-submit"].includes(mode)) {
    throw new Error("Direct opportunity submit is retired; use the pipeline submit task");
  }
  return runDoudianStoreTask({
    taskType: mode === "pipeline-submit"
      ? "opportunityPipelineSubmit"
      : ["clue-scan", "product-scan", "product-prematch"].includes(mode)
        ? "opportunityReportScan"
        : "opportunityReportAction",
    operationId: args.operationId,
    metadata: { mutation: !["clue-scan", "product-scan", "product-prematch", "latest"].includes(mode), replaceActive: true },
    payload: nextArgs
  }, 900000) as Promise<DoudianOpportunityReportResult>;
}

export async function clearDoudianInvalidOpportunityFavorites(args: {
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityFavoritesResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    storeRefs: args.storeRefs || [],
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const identityKey = (ref: DoudianStoreIdentityRef) => `${ref.tenantId}::${ref.shopId}::${ref.storeGeneration}`;
  const dedupeKey = JSON.stringify({
    storeRefs: [...(args.storeRefs || [])].map(identityKey).sort(),
    action: "clear-invalid",
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  return runDoudianStoreTask({
    taskType: "opportunityFavoritesClearInvalid",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: {
      dedupeKey,
      replaceActive: true,
      shopCount: args.storeRefs?.length || args.shopIds?.length || 0,
      action: "clear-invalid"
    },
    payload: nextArgs
  }, 300000) as Promise<DoudianOpportunityFavoritesResult>;
}

export async function fetchDoudianFavoriteCategories(args: {
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  forceAdapter?: boolean;
} = {}): Promise<{ ok: boolean; status?: string; message?: string; categories: DoudianOpportunityFavoriteCategory[] }> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    storeRefs: args.storeRefs || [],
    mode: "opportunity-auto-favorites"
  }, { force: args.forceAdapter === true });
  return runDoudianStoreTask({
    taskType: "opportunityFavoriteCategories",
    metadata: { mutation: false, replaceActive: true },
    payload: nextArgs
  }, 300000) as Promise<{ ok: boolean; status?: string; message?: string; categories: DoudianOpportunityFavoriteCategory[] }>;
}

export async function fetchDoudianOpportunityFavoriteRecords(args: {
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  taskStatus?: number;
  pageSize?: number;
  startPage?: number;
  maxPages?: number;
  onStarted?: (operationId: string) => void;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityFavoriteRecordsResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    storeRefs: args.storeRefs || [],
    taskStatus: args.taskStatus ?? 1,
    pageSize: args.pageSize || 24,
    ...(Number(args.startPage || 1) > 1 ? { startPage: Math.floor(Number(args.startPage)) } : {}),
    maxPages: args.maxPages || 100
  }, { force: args.forceAdapter === true });
  return runDoudianStoreTask({
    taskType: "opportunityFavoriteRecords",
    metadata: { mutation: false, replaceActive: true },
    payload: nextArgs
  }, 900000, args.onStarted) as Promise<DoudianOpportunityFavoriteRecordsResult>;
}

export async function cancelDoudianOpportunityFavorites(args: {
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  taskIds?: Array<string | number>;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityFavoriteCancelResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    storeRefs: args.storeRefs || [],
    taskIds: (args.taskIds || []).map(String).filter(Boolean),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const policy = nextArgs.doudianAdapter.adapter.policies as Record<string, unknown>;
  const favoritesPolicy = (policy.opportunityFavorites || {}) as Record<string, unknown>;
  const planKey = String(favoritesPolicy.cancelRequestPlan || "opportunityFavoriteCancel");
  const dedupeKey = JSON.stringify({
    storeRefs: (args.storeRefs || []).map((ref) => `${ref.tenantId}::${ref.shopId}::${ref.storeGeneration}`).sort(),
    taskIds: [...(args.taskIds || [])].map(String).sort(),
    planKey,
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  const timeoutMs = Math.max(300000, Math.max(1, args.taskIds?.length || 1) * 30000);
  return runDoudianStoreTask({
    taskType: "opportunityFavoriteCancel",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: { mutation: true, replaceActive: true, dedupeKey, action: "cancel-favorite" },
    payload: nextArgs
  }, timeoutMs) as Promise<DoudianOpportunityFavoriteCancelResult>;
}

export async function runDoudianOpportunityAutoFavorites(args: {
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  filters?: DoudianOpportunityAutoFavoriteFilters;
  storeFilters?: Record<string, DoudianOpportunityAutoFavoriteFilters>;
  operationId?: string;
  onStarted?: (operationId: string) => void;
  forceAdapter?: boolean;
  dryRun?: boolean;
} = {}): Promise<DoudianOpportunityAutoFavoritesResult> {
  const nextArgs = await withDoudianAdapter({
    mode: "opportunity-auto-favorites",
    shopIds: args.shopIds || [],
    storeRefs: args.storeRefs || [],
    ...(args.filters ? { favoriteFilters: args.filters } : {}),
    ...(args.storeFilters ? { storeFilters: args.storeFilters } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const dedupeKey = JSON.stringify({
    shopIds: [...(args.shopIds || [])].sort(),
    storeRefs: (args.storeRefs || []).map((ref) => `${ref.tenantId}::${ref.shopId}::${ref.storeGeneration}`).sort(),
    filters: args.filters || {},
    storeFilters: args.storeFilters || {},
    adapterVersion: nextArgs.doudianAdapter.adapter.version || ""
  });
  const policy = nextArgs.doudianAdapter.adapter.policies as Record<string, unknown>;
  const autoCollect = ((policy.opportunityFavorites as Record<string, unknown> | undefined)?.autoCollect || {}) as Record<string, unknown>;
  const configuredStoreLimits = Object.values(args.storeFilters || {}).map((filters) => Number(filters.perStoreLimit || filters.categoryPlans?.reduce((sum, item) => sum + Number(item.limit || 0), 0) || 0));
  const requestedLimit = Math.max(Number(args.filters?.perStoreLimit ?? 0), ...configuredStoreLimits, Number(autoCollect.perStoreLimit ?? 1000));
  const perStoreLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.floor(requestedLimit))) : 1000;
  const configuredDelay = Number(autoCollect.collectDelayMs ?? 1200);
  const collectDelayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 1200;
  const storeCount = Math.max(1, args.storeRefs?.length || args.shopIds?.length || 1);
  const timeoutMs = Math.max(1800000, storeCount * (300000 + perStoreLimit * collectDelayMs));
  return runDoudianStoreTask({
    taskType: "opportunityAutoFavorites",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: {
      dedupeKey,
      replaceActive: true,
      shopCount: args.storeRefs?.length || args.shopIds?.length || 0,
      action: "auto-favorite"
    },
    payload: {
      ...nextArgs,
      filters: args.filters || {},
      storeFilters: args.storeFilters || {}
    }
  }, timeoutMs, args.onStarted) as Promise<DoudianOpportunityAutoFavoritesResult>;
}

export async function runDoudianOpportunityPipelineTask(args: {
  shopIds?: string[];
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  submitMode?: DoudianOpportunitySubmitMode;
  goodsMatchType?: DoudianOpportunityGoodsMatchType;
  matchMode?: DoudianOpportunityPrematchMode;
  titleMatchMode?: DoudianOpportunityTitleMatchMode;
  titleUpdatePosition?: DoudianOpportunityTitleUpdatePosition;
  skipSubmittedClueCategory?: boolean;
  skipSubmittedClue?: boolean;
  skipSubmittedProductInSameClue?: boolean;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOperationRecord> {
  const nextArgs = await withDoudianAdapter({
    mode: "pipeline-submit",
    shopIds: args.shopIds || [],
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.matchRules ? { matchRules: args.matchRules } : {}),
    ...(args.submitMode ? { submitMode: args.submitMode } : {}),
    ...(args.goodsMatchType ? { goodsMatchType: args.goodsMatchType } : {}),
    ...(args.matchMode ? { matchMode: args.matchMode } : {}),
    ...(args.titleMatchMode ? { titleMatchMode: args.titleMatchMode } : {}),
    ...(args.titleUpdatePosition ? { titleUpdatePosition: args.titleUpdatePosition } : {}),
    ...(args.skipSubmittedClueCategory !== undefined ? { skipSubmittedClueCategory: args.skipSubmittedClueCategory } : {}),
    ...(args.skipSubmittedClue !== undefined ? { skipSubmittedClue: args.skipSubmittedClue } : {}),
    ...(args.skipSubmittedProductInSameClue !== undefined ? { skipSubmittedProductInSameClue: args.skipSubmittedProductInSameClue } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  return startDoudianTask({
    taskType: "opportunityPipelineSubmit",
    operationId: args.operationId,
    adapterVersion: nextArgs.doudianAdapter.adapter.version,
    ruleVersion: nextArgs.doudianAdapter.scripts?.version || "",
    metadata: {
      dedupeKey: "opportunity-pipeline-submit",
      shopCount: nextArgs.shopIds?.length || 0,
      mode: "pipeline-submit"
    },
    payload: nextArgs
  });
}

export async function fetchDoudianOpportunityReportLatest(args: {
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityReportResult> {
  const nextArgs = await withDoudianAdapter({
    mode: "latest",
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.matchRules ? { matchRules: args.matchRules } : {})
  }, { force: args.forceAdapter === true });
  return fetchOpportunityReportLatest(nextArgs);
}

export async function fetchDoudianOpportunityPipelineRun(args: {
  runId?: string;
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  forceAdapter?: boolean;
} = {}): Promise<DoudianOpportunityReportResult> {
  const nextArgs = await withDoudianAdapter({
    mode: "latest",
    ...(args.runId ? { runId: args.runId, operationId: args.runId } : {}),
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.matchRules ? { matchRules: args.matchRules } : {})
  }, { force: args.forceAdapter === true });
  return fetchOpportunityPipelineRun(nextArgs);
}

export async function fetchDoudianOpportunityPipelineSummary(args: { runId?: string; forceAdapter?: boolean } = {}): Promise<DoudianOpportunityReportResult> {
  const nextArgs = await withDoudianAdapter({
    mode: "latest",
    ...(args.runId ? { runId: args.runId, operationId: args.runId } : {})
  }, { force: args.forceAdapter === true });
  return fetchOpportunityPipelineSummary(nextArgs);
}

export async function restoreDoudianOpportunityPipelineTask(): Promise<DoudianOperationRecord | null> {
  const records = await resubscribeDoudianTasks();
  return records
    .filter((record) => record.taskType === "opportunityPipelineSubmit")
    .filter((record) => (record as DoudianOperationRecord & { runnerAlive?: boolean }).runnerAlive === true)
    .filter((record) => record.status === "running" || record.status === "cancelling")
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

export async function listDoudianOpportunityCandidatesPage(args: {
  runId?: string;
  cursor?: string | null;
  pageSize?: number;
  onlyRequested?: boolean;
} = {}): Promise<DoudianOpportunityCandidatePage> {
  return listOpportunityPipelineCandidatesPage({
    runId: args.runId || "",
    cursor: args.cursor || null,
    pageSize: args.pageSize,
    onlyRequested: args.onlyRequested === true
  });
}

export async function listDoudianOpportunityStoreCategories(args: { shopIds?: string[]; storeRefs?: DoudianStoreIdentityRef[] } = {}): Promise<DoudianOpportunityStoreCategoryLedger[]> {
  return listOpportunityStoreCategoryLedger({ shopIds: args.shopIds || [], storeRefs: args.storeRefs || [] });
}

export async function selectAndParseCompassFile(): Promise<{
  ok: boolean;
  canceled?: boolean;
  status?: string;
  message?: string;
  fileName?: string;
  rows?: Array<Record<string, unknown>>;
  count?: number;
}> {
  return selectAndParseCompassFileRemote();
}

export async function cancelDoudianStoreOperation(operationId: string): Promise<DoudianStoreResult> {
  await cancelDoudianTask(operationId);
  return { ...(await listStoreLedger()), ok: false, status: "cancelled", operationId, message: "已取消任务" };
}

export async function openDoudianStore(shopId: string, url?: string): Promise<DoudianStoreResult> {
  let doudianAdapter: DoudianAdapterPayload | undefined;
  try {
    doudianAdapter = (await withDoudianAdapter({ shopId })).doudianAdapter;
  } catch {}
  const resolvedUrl = url && doudianAdapter?.adapter.origin ? new URL(url, doudianAdapter.adapter.origin).toString() : undefined;
  return openStoreWindow(shopId, { doudianAdapter, url: resolvedUrl });
}

export async function deleteDoudianStores(shopIds: string[]): Promise<DoudianStoreResult> {
  return deleteStoreLedger(shopIds);
}

export async function renameDoudianStoreGroup(oldGroupName: string, groupName: string): Promise<DoudianStoreResult> {
  return renameStoreGroup(oldGroupName, groupName);
}

export async function deleteEmptyDoudianStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  return deleteEmptyStoreGroup(groupName);
}

export async function createDoudianStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  return createStoreGroup(groupName);
}

export async function updateDoudianStoreGroup(shopIds: string[], groupName: string): Promise<DoudianStoreResult> {
  return updateStoreGroup(shopIds, groupName);
}
