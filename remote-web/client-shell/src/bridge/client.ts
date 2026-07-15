import type {
  BridgeSelfCheck,
  DoudianAdapterPayload,
  DoudianBulkDeleteFilters,
  DoudianBulkDeleteProgress,
  DoudianBulkDeleteResult,
  DoudianBusinessDataResult,
  DoudianFundsDataResult,
  DoudianOpportunityFilters,
  DoudianOpportunityGoodsMatchType,
  DoudianOpportunityCandidatePage,
  DoudianOpportunityMatchRules,
  DoudianOpportunityPrematchMode,
  DoudianOpportunityReportResult,
  DoudianOpportunityStoreCategoryLedger,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianStaleGoodsCleanupResult,
  DoudianStaleGoodsRules,
  DoudianStoreResult,
  DoudianViolationsDataResult
} from "../types";
import type { NativeUpdateStartRequest, NativeUpdateVersionData, NativeUpdateVersionRequest } from "../native/types";
import { getChihuNative } from "../native/client";
import {
  createStoreGroup,
  deleteEmptyStoreGroup,
  deleteStoreLedger,
  fetchBulkDeleteProducts,
  fetchBusinessDataLatest,
  fetchFundsDataLatest,
  fetchOpportunityPipelineRun,
  fetchOpportunityReport,
  fetchOpportunityReportLatest,
  listOpportunityPipelineCandidatesPage,
  listOpportunityStoreCategoryLedger,
  fetchStaleGoodsCleanup,
  fetchViolationsDataLatest,
  listStoreLedger,
  openStoreWindow,
  startDoudianTask,
  runDoudianStoreTask,
  cancelDoudianTask,
  renameStoreGroup,
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

export async function fetchDoudianStores(operationId?: string, repairShopIds?: string[]): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({
    ...(operationId ? { operationId } : {}),
    ...(repairShopIds?.length ? { repairShopIds } : {})
  });
  const loginTimeoutMs = Math.max(3000, Number(args.doudianAdapter.adapter.timeouts?.loginMs || 300000));
  return runDoudianStoreTask({
    taskType: "fetchDoudianStores",
    operationId,
    adapterVersion: args.doudianAdapter.adapter.version,
    ruleVersion: args.doudianAdapter.scripts?.version || "",
    payload: {
      doudianAdapter: args.doudianAdapter,
      repairShopIds,
      timeoutMs: loginTimeoutMs
    }
  }, loginTimeoutMs + 60000);
}

export async function refreshDoudianStoreStatus(shopIds?: string[], operationId?: string): Promise<DoudianStoreResult> {
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
  }, 180000);
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
} = {}): Promise<DoudianBusinessDataResult> {
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
  }, 900000) as Promise<DoudianBusinessDataResult>;
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
  return fetchStaleGoodsCleanup(nextArgs);
}

export async function fetchDoudianBulkDeleteProducts(args: {
  mode?: "scan" | "execute";
  shopIds?: string[];
  sourceMode?: "range" | "ids";
  filters?: DoudianBulkDeleteFilters;
  action?: "recycle" | "delete";
  protectMode?: "includeSelling" | "skipSelling";
  candidateIds?: string[];
  sourceRunId?: string;
  confirmText?: string;
  operationId?: string;
  onProgress?: (progress: DoudianBulkDeleteProgress) => void;
  shouldCancel?: () => boolean;
  forceAdapter?: boolean;
} = {}): Promise<DoudianBulkDeleteResult> {
  const nextArgs = await withDoudianAdapter({
    mode: args.mode || "scan",
    shopIds: args.shopIds || [],
    ...(args.sourceMode ? { sourceMode: args.sourceMode } : {}),
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.action ? { action: args.action } : {}),
    ...(args.protectMode ? { protectMode: args.protectMode } : {}),
    ...(args.candidateIds?.length ? { candidateIds: args.candidateIds } : {}),
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
    ...(args.confirmText ? { confirmText: args.confirmText } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  return fetchBulkDeleteProducts({
    ...nextArgs,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    ...(args.shouldCancel ? { shouldCancel: args.shouldCancel } : {})
  });
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
  return fetchOpportunityReport(nextArgs);
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

export async function listDoudianOpportunityCandidatesPage(args: {
  runId?: string;
  cursor?: string | null;
  pageSize?: number;
} = {}): Promise<DoudianOpportunityCandidatePage> {
  return listOpportunityPipelineCandidatesPage({
    runId: args.runId || "",
    cursor: args.cursor || null,
    pageSize: args.pageSize
  });
}

export async function listDoudianOpportunityStoreCategories(args: { shopIds?: string[] } = {}): Promise<DoudianOpportunityStoreCategoryLedger[]> {
  return listOpportunityStoreCategoryLedger({ shopIds: args.shopIds || [] });
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
