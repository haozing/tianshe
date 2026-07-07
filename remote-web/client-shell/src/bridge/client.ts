import type {
  BridgeSelfCheck,
  DoudianBusinessDataResult,
  DoudianFundsDataResult,
  DoudianStaleGoodsCandidate,
  DoudianStaleGoodsCleanupResult,
  DoudianStaleGoodsRules,
  DoudianStoreResult,
  DoudianViolationsDataResult
} from "../types";
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
  if (!window.client || typeof window.client.minimizeWindow !== "function") return false;
  await window.client.minimizeWindow({});
  return true;
}

export async function toggleMaximizeMainWindow() {
  if (!window.client || typeof window.client.maximizeWindow !== "function") return false;
  await window.client.maximizeWindow({});
  return true;
}

export async function closeMainWindow() {
  if (!window.client || typeof window.client.closeWindow !== "function") return false;
  await window.client.closeWindow({});
  return true;
}

export async function openPlatformWindow(args: {
  url: string;
  title?: string;
  partition?: string;
  width?: number;
  height?: number;
}): Promise<{ ok: boolean; id?: unknown; message?: string }> {
  if (!window.client || typeof window.client.openWindow !== "function") {
    return { ok: false, message: "local window bridge unavailable" };
  }
  const id = await window.client.openWindow({
    url: args.url,
    title: args.title || "赤狐管家 - 平台页面",
    partition: args.partition || "persist:chihu-doudian-shared",
    width: args.width || 1280,
    height: args.height || 820,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true
  });
  return { ok: true, id };
}

function storesApi() {
  return window.chihu?.stores || null;
}

async function withOptionalDoudianAdapter<T extends Record<string, unknown>>(args: T): Promise<T> {
  try {
    return await withDoudianAdapter(args);
  } catch {
    return args;
  }
}

export async function listDoudianStores(): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({});
  const api = storesApi();
  if (api?.list) return api.list(args);
  if (window.client?.storesList) return window.client.storesList(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function fetchDoudianStores(operationId?: string, repairShopIds?: string[]): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({ ...(operationId ? { operationId } : {}), ...(repairShopIds?.length ? { repairShopIds } : {}) });
  const api = storesApi();
  if (api?.fetch) return api.fetch(args);
  if (window.client?.storesFetch) return window.client.storesFetch(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function refreshDoudianStoreStatus(shopIds?: string[], operationId?: string): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({ shopIds: shopIds || [], ...(operationId ? { operationId } : {}) });
  const api = storesApi();
  if (api?.refreshStatus) return api.refreshStatus(args);
  if (window.client?.storesRefreshStatus) return window.client.storesRefreshStatus(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
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
  const api = storesApi();
  if (api?.businessData) return api.businessData(nextArgs);
  if (window.client?.storesBusinessData) return window.client.storesBusinessData(nextArgs);
  return { ok: false, message: "local business data bridge unavailable", rows: [], stores: [] };
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
  const api = storesApi();
  if (api?.businessDataLatest) return api.businessDataLatest(nextArgs);
  if (window.client?.storesBusinessDataLatest) return window.client.storesBusinessDataLatest(nextArgs);
  return { ok: true, status: "empty", message: "暂无最近经营数据", rows: [], stores: [] };
}

export async function fetchDoudianFundsData(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianFundsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const api = storesApi();
  if (api?.fundsData) return api.fundsData(nextArgs);
  if (window.client?.storesFundsData) return window.client.storesFundsData(nextArgs);
  return { ok: false, status: "missing", message: "本地资金数据桥接待接入", rows: [], stores: [] };
}

export async function fetchDoudianFundsDataLatest(args: {
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianFundsDataResult> {
  const nextArgs = await withDoudianAdapter({
    shopIds: args.shopIds || [],
    ...(args.datePreset ? { datePreset: args.datePreset } : {}),
    ...(args.beginDate ? { beginDate: args.beginDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {})
  }, { force: args.forceAdapter === true });
  const api = storesApi();
  if (api?.fundsDataLatest) return api.fundsDataLatest(nextArgs);
  if (window.client?.storesFundsDataLatest) return window.client.storesFundsDataLatest(nextArgs);
  return { ok: false, status: "missing", message: "本地资金数据桥接待接入", rows: [], stores: [] };
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
  const api = storesApi();
  if (api?.violationsData) return api.violationsData(nextArgs);
  if (window.client?.storesViolationsData) return window.client.storesViolationsData(nextArgs);
  return { ok: false, status: "missing", message: "本地违规管理桥接待接入", rows: [], records: [], stores: [] };
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
  const api = storesApi();
  if (api?.violationsDataLatest) return api.violationsDataLatest(nextArgs);
  if (window.client?.storesViolationsDataLatest) return window.client.storesViolationsDataLatest(nextArgs);
  return { ok: true, status: "empty", message: "暂无最近违规数据", rows: [], records: [], stores: [] };
}

export async function fetchDoudianStaleGoodsCleanup(args: {
  mode?: "scan" | "execute";
  shopIds?: string[];
  rules?: DoudianStaleGoodsRules;
  action?: "offline" | "recycle" | "delete" | "optimize";
  candidateIds?: string[];
  candidates?: DoudianStaleGoodsCandidate[];
  sourceRunId?: string;
  confirmText?: string;
  compassFileName?: string;
  compassRows?: Array<Record<string, unknown>>;
  operationId?: string;
  forceAdapter?: boolean;
} = {}): Promise<DoudianStaleGoodsCleanupResult> {
  const nextArgs = await withDoudianAdapter({
    mode: args.mode || "scan",
    shopIds: args.shopIds || [],
    ...(args.rules ? { rules: args.rules } : {}),
    ...(args.action ? { action: args.action } : {}),
    ...(args.candidateIds?.length ? { candidateIds: args.candidateIds } : {}),
    ...(args.candidates?.length ? { candidates: args.candidates } : {}),
    ...(args.sourceRunId ? { sourceRunId: args.sourceRunId } : {}),
    ...(args.confirmText ? { confirmText: args.confirmText } : {}),
    ...(args.compassFileName ? { compassFileName: args.compassFileName } : {}),
    ...(args.compassRows?.length ? { compassRows: args.compassRows } : {}),
    ...(args.operationId ? { operationId: args.operationId } : {})
  }, { force: args.forceAdapter === true });
  const api = storesApi();
  if (api?.staleGoodsCleanup) return api.staleGoodsCleanup(nextArgs);
  if (window.client?.storesStaleGoodsCleanup) return window.client.storesStaleGoodsCleanup(nextArgs);
  return { ok: false, status: "missing", message: "local stale goods cleanup bridge unavailable", rows: [], candidates: [], executions: [], stores: [] };
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
  const parser = window.client?.selectAndParseDelimitedFile;
  if (typeof parser !== "function") {
    return { ok: false, status: "missing", message: "本地文件解析桥接待接入", rows: [] };
  }
  return parser({
    title: "选择经营版_商品_商品列表",
    filters: [
      { name: "经营版商品列表", extensions: ["csv", "tsv", "txt", "xlsx", "xls"] },
      { name: "CSV/TSV/TXT", extensions: ["csv", "tsv", "txt"] },
      { name: "Excel", extensions: ["xlsx", "xls"] }
    ]
  }) as Promise<{
    ok: boolean;
    canceled?: boolean;
    status?: string;
    message?: string;
    fileName?: string;
    rows?: Array<Record<string, unknown>>;
    count?: number;
  }>;
}

export async function cancelDoudianStoreOperation(operationId: string): Promise<DoudianStoreResult> {
  const args = { operationId };
  const api = storesApi();
  if (api?.cancel) return api.cancel(args);
  if (window.client?.storesCancel) return window.client.storesCancel(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function openDoudianStore(shopId: string): Promise<DoudianStoreResult> {
  const args = await withDoudianAdapter({ shopId });
  const api = storesApi();
  if (api?.open) return api.open(args);
  if (window.client?.storesOpen) return window.client.storesOpen(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function deleteDoudianStores(shopIds: string[]): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({ shopIds });
  const api = storesApi();
  if (api?.delete) return api.delete(args);
  if (window.client?.storesDelete) return window.client.storesDelete(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function renameDoudianStoreGroup(oldGroupName: string, groupName: string): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({ action: "rename", oldGroupName, groupName, groupId: groupName });
  const api = storesApi();
  if (api?.updateGroup) return api.updateGroup(args);
  if (window.client?.storesUpdateGroup) return window.client.storesUpdateGroup(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function deleteEmptyDoudianStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({ action: "deleteEmpty", groupName });
  const api = storesApi();
  if (api?.updateGroup) return api.updateGroup(args);
  if (window.client?.storesUpdateGroup) return window.client.storesUpdateGroup(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function createDoudianStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({ action: "create", groupName, groupId: groupName });
  const api = storesApi();
  if (api?.updateGroup) return api.updateGroup(args);
  if (window.client?.storesUpdateGroup) return window.client.storesUpdateGroup(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}

export async function updateDoudianStoreGroup(shopIds: string[], groupName: string): Promise<DoudianStoreResult> {
  const args = await withOptionalDoudianAdapter({ shopIds, groupName, groupId: groupName });
  const api = storesApi();
  if (api?.updateGroup) return api.updateGroup(args);
  if (window.client?.storesUpdateGroup) return window.client.storesUpdateGroup(args);
  return { ok: false, message: "本地店铺桥接不可用", stores: [] };
}
