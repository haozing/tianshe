import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStoreResult,
  DoudianStoreSummary
} from "../../types";
import { requireChihuNative } from "../../native/client";
import { listStoreLedger, upsertStoreLedgers } from "./storeGroups";
import { firstPathValue, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { dispatchDoudianProgress } from "./progress";
import { loadDoudianAdapterPayload } from "../../bridge/doudianAdapter";
import { runRefreshDoudianStoreStatusTask } from "./storeStatus";
import { currentShopFromResponse, currentShopState, normalizeShopItem, objectRecord, policyNumber, text } from "./storeResponse";

interface FetchStoresPayload {
  operationId: string;
  doudianAdapter: DoudianAdapterPayload;
  repairShopIds?: string[];
  mockStores?: Array<Partial<DoudianStoreSummary>>;
  mockDelayMs?: number;
  mockOpenWindowUrl?: string;
  mockWindowTitle?: string;
  timeoutMs?: number;
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

interface LoginDetectionResult {
  ok: boolean;
  source: "role-list" | "api" | "home-page" | "timeout" | "closed";
  message: string;
  shopListResult?: RequestPlanResult;
  currentResult?: RequestPlanResult;
  stores?: Array<Partial<DoudianStoreSummary>>;
  roleNames?: string[];
  isHomePage?: boolean;
}

interface ImportActivationResult {
  ok: boolean;
  skipped?: boolean;
  activateUrl?: string;
  currentShopId?: string;
  currentShopName?: string;
  confirmedStore?: Partial<DoudianStoreSummary>;
  message?: string;
  switchResult?: unknown;
  switchAttempts?: number;
}

const LUOPAN_VIEW_COOKIE_NAMES = ["LUOPAN_DT"];

function nowIso() {
  return new Date().toISOString();
}

function partitionToken(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function progress(args: FetchStoresPayload, value: number, message: string) {
  dispatchDoudianProgress({
    operationId: args.operationId,
    taskType: "fetchDoudianStores",
    status: "running",
    progress: value,
    message
  });
}

async function loginWindowClosed(native: ReturnType<typeof requireChihuNative>, winId: number) {
  if (native.windows.getInfo) {
    const info = await native.windows.getInfo({ winId }).catch(() => undefined);
    if (info === null) return true;
  }
  if (native.windows.isDestroyed) {
    return await native.windows.isDestroyed({ winId }).then((value) => value === true).catch(() => false);
  }
  return false;
}

function closedLoginDetection(roleNames: string[], isHomePage: boolean): LoginDetectionResult {
  return {
    ok: false,
    source: "closed",
    message: "登录窗口已关闭，获取店铺任务已取消。",
    roleNames,
    isHomePage
  };
}

function storeProgress(args: FetchStoresPayload, value: number, store: DoudianStoreSummary, index: number, total: number) {
  const loginStatus = store.status === "online" ? "登录有效" : store.status === "offline" ? "登录失效" : "待复核";
  dispatchDoudianProgress({
    operationId: args.operationId,
    taskType: "fetchDoudianStores",
    status: "running",
    progress: value,
    message: `已获取 ${index}/${total}：${store.shopName}（${store.shopId}）· ${loginStatus}`,
    store: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: store.status,
      index,
      total
    }
  });
}

function sourcePartition(adapter: DoudianAdapterPayload, operationId: string) {
  return `${adapter.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_"}source_${partitionToken(operationId)}_${Date.now()}`;
}

function shopPartition(adapter: DoudianAdapterPayload, shop: Partial<DoudianStoreSummary>, index = 0) {
  const id = text(shop.shopId || shop.shopName || `shop_${index}`);
  return `${adapter.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_"}${partitionToken(id)}_${Date.now()}`;
}

function shopPartitionPrefix(adapter: DoudianAdapterPayload) {
  return adapter.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_";
}

async function cleanDoudianPartitions(
  native: ReturnType<typeof requireChihuNative>,
  adapter: DoudianAdapterPayload,
  stores?: DoudianStoreSummary[]
) {
  const keepStores = stores || (await listStoreLedger()).stores || [];
  const currentPartitions = keepStores.map((store) => text(store.partition)).filter(Boolean);
  await native.partitions.cleanInvalid({
    currentPartitions,
    prefixes: [shopPartitionPrefix(adapter)]
  }).catch(() => null);
}

function normalizeStore(input: Partial<DoudianStoreSummary>, adapter: DoudianAdapterPayload, partition: string, index = 0): DoudianStoreSummary | null {
  const shopId = text(input.shopId || input.shopInfoSummary?.id || `mock-${Date.now()}-${index}`);
  if (!shopId) return null;
  const timestamp = nowIso();
  return {
    shopId,
    shopName: text(input.shopName || input.shopInfoSummary?.shop_name) || `抖店 ${shopId}`,
    platform: "doudian",
    partition,
    status: input.status || "online",
    operateStatus: text(input.operateStatus) || "正常经营",
    groupId: text(input.groupId),
    groupName: text(input.groupName),
    shopInfoSummary: input.shopInfoSummary || { id: shopId, shop_name: input.shopName || `抖店 ${shopId}` },
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    lastFetchAt: timestamp,
    lastLoginCheckAt: timestamp,
    lastOnlineAt: input.status === "offline" ? "" : timestamp,
    lastCheckStatus: input.status === "offline" ? "offline" : "ok",
    lastCheckMessage: input.status === "offline" ? "登录失效" : "登录有效",
    lastResult: input.status === "offline" ? "登录失效" : "登录有效",
    lastResultAt: timestamp,
    lastFailureReason: input.status === "offline" ? "login-offline" : "",
    lastFailureMessage: input.status === "offline" ? "登录失效" : "",
    adapterVersion: adapter.adapter.version
  };
}

function storesFromResponses(shopListData: unknown, currentData: unknown, adapter: DoudianAdapterPayload) {
  const mappings = adapter.adapter.responseMappings;
  const listValue = firstPathValue(shopListData, mappings?.shopListPaths || []);
  const list = Array.isArray(listValue) ? listValue : Array.isArray(shopListData) ? shopListData : [];
  const stores = list.map((item) => normalizeShopItem(item, adapter.adapter)).filter((item): item is Partial<DoudianStoreSummary> => !!item);
  const currentObject = firstPathValue(currentData, mappings?.currentShopObjectPaths || []);
  const current = normalizeShopItem(currentObject, adapter.adapter);
  if (current && !stores.some((store) => store.shopId && store.shopId === current.shopId)) stores.unshift(current);
  return stores;
}

function uniqueStores(stores: Array<Partial<DoudianStoreSummary>>) {
  const seen = new Set<string>();
  const output: Array<Partial<DoudianStoreSummary>> = [];
  for (const store of stores) {
    const key = text(store.shopId) || text(store.shopName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(store);
  }
  return output;
}

function storesFromRoleNames(roleNames: string[], apiStores: Array<Partial<DoudianStoreSummary>> = []) {
  const byName = new Map<string, Partial<DoudianStoreSummary>>();
  for (const store of apiStores) {
    const name = text(store.shopName);
    if (name) byName.set(name, store);
  }
  return uniqueStores(roleNames
    .map((name) => {
      const shopName = text(name);
      if (!shopName) return null;
      const exact = byName.get(shopName);
      const loose = exact || apiStores.find((store) => {
        const apiName = text(store.shopName);
        return apiName && (apiName.includes(shopName) || shopName.includes(apiName));
      });
      return loose || {
        shopId: "",
        shopName,
        shopInfoSummary: { shop_name: shopName }
      };
    })
    .filter((store): store is Partial<DoudianStoreSummary> => !!store));
}

function filterRepairStores(stores: Array<Partial<DoudianStoreSummary>>, repairShopIds?: string[]) {
  const ids = new Set((repairShopIds || []).map((id) => text(id)).filter(Boolean));
  if (!ids.size) return stores;
  return stores.filter((store) => ids.has(text(store.shopId)));
}

function detailForStore(store: DoudianStoreSummary, index: number, total: number): DoudianRunDetail {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    status: store.status,
    ok: store.status === "online",
    message: store.status === "online" ? "已导入并确认当前登录态" : "已导入，待复核",
    index,
    total
  };
}

function failureDetail(store: DoudianStoreSummary, message: string, diagnostic: unknown): DoudianRunDetail {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    status: "offline",
    ok: false,
    message,
    reason: "activate-store-failed",
    category: "import",
    diagnostic
  };
}

function adapterTimeout(adapter: DoudianAdapterConfig, key: string, fallback: number) {
  const value = Number(adapter.timeouts?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

async function readCurrentShop(adapter: DoudianAdapterPayload, store: DoudianStoreSummary, context: Record<string, unknown>) {
  return runDoudianRequestPlan(adapter, {
    partition: store.partition,
    planKey: "currentShop",
    context
  }).catch((error) => ({
    ok: false,
    status: 0,
    data: null,
    error: error instanceof Error ? error.message : String(error),
    source: "currentShop"
  }) as RequestPlanResult);
}

function withActivationIdFallback(state: ReturnType<typeof currentShopState>, target: DoudianStoreSummary, switchResult: unknown) {
  if (state.ok) return state;
  const switchRecord = objectRecord(switchResult);
  const targetShopId = text(target.shopId);
  const targetShopName = text(target.shopName);
  const matchedName = text((objectRecord(switchRecord.matched)).nameText);
  const clickedTargetByName = switchRecord.ok === true && targetShopName && matchedName === targetShopName;
  if (!targetShopId && clickedTargetByName && state.currentShopId) {
    return {
      ...state,
      ok: true,
      confirmedStore: {
        ...(state.confirmedStore || {}),
        shopId: state.currentShopId,
        shopName: state.currentShopName || targetShopName,
        shopInfoSummary: {
          ...(state.confirmedStore?.shopInfoSummary || {}),
          id: state.currentShopId,
          shop_name: state.currentShopName || targetShopName
        }
      }
    };
  }
  return state;
}

function mergeConfirmedStore(record: DoudianStoreSummary, activation: ImportActivationResult, adapter: DoudianAdapterPayload, index: number) {
  const confirmed = activation.confirmedStore || {};
  const merged: Partial<DoudianStoreSummary> = {
    ...record,
    ...confirmed,
    shopId: text(confirmed.shopId || activation.currentShopId) || record.shopId,
    shopName: text(confirmed.shopName || activation.currentShopName) || record.shopName,
    operateStatus: text(confirmed.operateStatus) || record.operateStatus,
    shopInfoSummary: confirmed.shopInfoSummary || {
      ...(record.shopInfoSummary || {}),
      id: text(activation.currentShopId) || record.shopInfoSummary?.id,
      shop_name: text(activation.currentShopName) || record.shopInfoSummary?.shop_name || record.shopName
    },
    status: "online",
    partition: record.partition
  };
  return normalizeStore(merged, adapter, record.partition, index) || record;
}

function importActivationLogPayload(store: DoudianStoreSummary, activation: ImportActivationResult) {
  const switchResult = objectRecord(activation.switchResult);
  return {
    category: "doudian-store-import",
    event: "activate-store",
    shopId: store.shopId,
    shopName: store.shopName,
    partition: store.partition,
    ok: activation.ok,
    skipped: activation.skipped === true,
    activateUrl: activation.activateUrl || "",
    currentShopId: activation.currentShopId || "",
    currentShopName: activation.currentShopName || "",
    message: activation.message || "",
    switchAttempts: activation.switchAttempts || 0,
    switchOk: switchResult.ok === true,
    switchReason: text(switchResult.reason),
    switchHref: text(switchResult.href).slice(0, 200),
    switchTitle: text(switchResult.title).slice(0, 120)
  };
}

async function activateImportedStore(adapter: DoudianAdapterPayload, store: DoudianStoreSummary, args?: FetchStoresPayload): Promise<ImportActivationResult> {
  const native = requireChihuNative();
  const context = { shopId: store.shopId, shopName: store.shopName };
  const report = async (activation: ImportActivationResult) => {
    await native.logs.report(importActivationLogPayload(store, activation)).catch(() => undefined);
    return activation;
  };
  const before = await readCurrentShop(adapter, store, context);
  const beforeState = currentShopState(before, adapter.adapter, store);
  if (beforeState.ok) {
    return report({
      ok: true,
      skipped: true,
      currentShopId: beforeState.currentShopId,
      currentShopName: beforeState.currentShopName,
      confirmedStore: beforeState.confirmedStore,
      message: "current shop already active"
    });
  }

  let winId: number | null = null;
  const activateUrl = adapter.adapter.chooseEntriesUrl || adapter.adapter.homeUrl || adapter.adapter.loginUrl;
  let lastSwitchResult: unknown = { ok: false, reason: "not-run" };
  let switchAttempts = 0;
  try {
    winId = await native.windows.open({
      url: activateUrl,
      partition: store.partition,
      show: false,
      waitForLoad: false,
      width: 480,
      height: 360,
      title: "Chihu Doudian Import Activate",
      nodeIntegration: false,
      contextIsolation: true
    });
    args?.trackWindow?.(winId);
    const bootWaitMs = Math.max(0, policyNumber(adapter.adapter, "businessData.activateBootWaitMs", 1200));
    if (bootWaitMs) await delay(bootWaitMs);
    const selectTimeoutMs = adapterTimeout(adapter.adapter, "shopSelectMs", 15000);
    const pollMs = adapterTimeout(adapter.adapter, "shopSwitchPollMs", 1000);
    const probeTimeoutMs = adapterTimeout(adapter.adapter, "probeMs", 18000);
    const switchTimeoutMs = Math.max(2000, Math.min(probeTimeoutMs, policyNumber(adapter.adapter, "businessData.activateScriptTimeoutMs", probeTimeoutMs)));
    const readyAttemptLimit = Number(adapter.adapter.strategies?.shopSwitchHomePageReadyAttempts || 8);
    const readyHints = Array.isArray(adapter.adapter.strategies?.homePageReadyPathHints) ? adapter.adapter.strategies.homePageReadyPathHints : [];
    const selectDeadline = Date.now() + selectTimeoutMs;
    while (Date.now() < selectDeadline) {
      if (args?.isCancelled?.()) throw new Error("cancelled");
      switchAttempts += 1;
      lastSwitchResult = await native.windows.command({
        winId,
        command: "switch-shop",
        args: { shop: store },
        timeoutMs: switchTimeoutMs + 2000
      }).catch((error) => ({
        ok: false,
        reason: "switch-eval-failed",
        message: error instanceof Error ? error.message : String(error)
      }));
      const switchRecord = objectRecord(lastSwitchResult);
      if (switchRecord.ok === true) break;
      if (switchAttempts > readyAttemptLimit) {
        const href = text(switchRecord.href);
        if (readyHints.some((hint) => href.includes(String(hint)))) break;
      }
      await delay(Math.min(pollMs, Math.max(0, selectDeadline - Date.now())));
    }
    const settleWaitMs = Math.max(0, policyNumber(adapter.adapter, "businessData.activateSettleWaitMs", 2200));
    if (settleWaitMs) await delay(settleWaitMs);
    const verifyTimeoutMs = adapterTimeout(adapter.adapter, "shopSwitchMs", 15000);
    const verifyDeadline = Date.now() + verifyTimeoutMs;
    let lastState = beforeState;
    while (Date.now() < verifyDeadline) {
      if (args?.isCancelled?.()) throw new Error("cancelled");
      const after = await readCurrentShop(adapter, store, context);
      lastState = withActivationIdFallback(currentShopState(after, adapter.adapter, store), store, lastSwitchResult);
      if (lastState.ok) {
        return await report({
          ok: true,
          activateUrl,
          currentShopId: lastState.currentShopId,
          currentShopName: lastState.currentShopName,
          confirmedStore: lastState.confirmedStore,
          message: "target shop active",
          switchResult: lastSwitchResult,
          switchAttempts
        });
      }
      await delay(Math.min(1000, Math.max(0, verifyDeadline - Date.now())));
    }
    const switchOk = objectRecord(lastSwitchResult).ok === true;
    return await report({
      ok: false,
      activateUrl,
      currentShopId: lastState.currentShopId || beforeState.currentShopId,
      currentShopName: lastState.currentShopName || beforeState.currentShopName,
      confirmedStore: lastState.confirmedStore || beforeState.confirmedStore,
      message: switchOk ? "target shop clicked but not confirmed" : "target shop not confirmed",
      switchResult: lastSwitchResult,
      switchAttempts
    });
  } catch (error) {
    if (args?.isCancelled?.() || (error instanceof Error && error.message === "cancelled")) throw error;
    return await report({
      ok: false,
      activateUrl,
      currentShopId: beforeState.currentShopId,
      currentShopName: beforeState.currentShopName,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}

async function importMockStores(args: FetchStoresPayload): Promise<DoudianStoreResult> {
  let mockWinId: number | null = null;
  if (args.mockOpenWindowUrl) {
    mockWinId = await requireChihuNative().windows.open({
      url: args.mockOpenWindowUrl,
      title: args.mockWindowTitle || "CHIHU Stage5 Mock Platform",
      partition: `persist:chihu-stage5-mock-${partitionToken(args.operationId)}`,
      show: false,
      width: 320,
      height: 200,
      nodeIntegration: false,
      contextIsolation: true
    });
    args.trackWindow?.(mockWinId);
  }

  const delayMs = Math.max(0, Number(args.mockDelayMs || 0));
  if (delayMs) await delayWithCancel(delayMs, args);

  const mockStores = args.mockStores || [];
  const records = mockStores
    .map((store, index) => normalizeStore(store, args.doudianAdapter, text(store.partition) || shopPartition(args.doudianAdapter, store, index), index))
    .filter((store): store is DoudianStoreSummary => !!store);
  const changed: DoudianStoreSummary[] = [];
  for (const [index, record] of records.entries()) {
    const [saved] = await upsertStoreLedgers([record]);
    if (!saved) continue;
    changed.push(saved);
    storeProgress(args, Math.round(((index + 1) / Math.max(records.length, 1)) * 100), saved, index + 1, records.length);
  }
  const details = changed.map((store, index) => detailForStore(store, index + 1, changed.length));
  return {
    ...(await listStoreLedger()),
    ok: true,
    status: "ok",
    operationId: args.operationId,
    imported: changed.length,
    failed: 0,
    message: `已导入 ${changed.length} 家店铺`,
    details: { imported: details, failed: [] }
  };
}

async function delayWithCancel(ms: number, args: FetchStoresPayload) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (args.isCancelled?.()) throw new Error("cancelled");
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

export async function runFetchDoudianStoresTask(args: FetchStoresPayload): Promise<DoudianStoreResult> {
  if (args.mockStores?.length) return importMockStores(args);

  const adapter = args.doudianAdapter;
  const native = requireChihuNative();
  const partition = sourcePartition(adapter, args.operationId);
  let loginWinId: number | null = null;
  progress(args, 5, "正在打开抖店登录窗口");

  try {
    loginWinId = await native.windows.open({
      url: adapter.adapter.loginUrl,
      title: "赤狐管家 - 登录抖店",
      partition,
      show: true,
      waitForLoad: false,
      width: 1280,
      height: 820,
      nodeIntegration: false,
      contextIsolation: true
    });
    args.trackWindow?.(loginWinId);

    progress(args, 10, "等待用户完成抖店登录");
    const detection = await waitForLoginDetection(loginWinId, partition, args);
    progress(args, 30, detection.message);
    if (!detection.ok) {
      const cancelled = detection.source === "closed";
      return {
        ...(await listStoreLedger()),
        ok: false,
        status: cancelled ? "cancelled" : "login-timeout",
        operationId: args.operationId,
        message: cancelled
          ? "已取消获取店铺：登录窗口已关闭。"
          : "未检测到抖店登录完成，请完成登录后重试或确认账号有店铺权限。",
        details: { imported: [], failed: [] }
      };
    }
    await native.windows.destroy({ winId: loginWinId }).catch(() => null);
    loginWinId = null;

    let shopListResult = detection.shopListResult;
    let currentResult = detection.currentResult;
    let detectedStores = detection.stores || [];
    if (!detectedStores.length && (!shopListResult || !currentResult)) {
      progress(args, 40, "正在获取抖店店铺列表");
      [shopListResult, currentResult] = await Promise.all([
        runDoudianRequestPlan(adapter, { partition, planKey: "shopList" }),
        runDoudianRequestPlan(adapter, { partition, planKey: "currentShop" })
      ]);
    }
    if (!detectedStores.length && shopListResult && currentResult) {
      detectedStores = storesFromResponses(shopListResult.data, currentResult.data, adapter);
    }
    progress(args, 55, shopListResult && currentResult
      ? `Store APIs returned ${shopListResult.status}/${currentResult.status}`
      : detection.message);
    const sourceStores = filterRepairStores(detectedStores, args.repairShopIds);
    if (!sourceStores.length) {
      return {
        ...(await listStoreLedger()),
        ok: false,
        status: "not-detected",
        operationId: args.operationId,
        message: "未识别到店铺，请确认账号有店铺权限。",
        details: { imported: [], failed: [] }
      };
    }

    const changed: DoudianStoreSummary[] = [];
    const failed: DoudianRunDetail[] = [];
    for (const [index, shop] of sourceStores.entries()) {
      if (args.isCancelled?.()) throw new Error("cancelled");
      const targetPartition = shopPartition(adapter, shop, index);
      await native.cookies.copy({
        fromPartition: partition,
        toPartition: targetPartition,
        excludeNames: LUOPAN_VIEW_COOKIE_NAMES
      });
      const record = normalizeStore(shop, adapter, targetPartition, index);
      if (!record) {
        progress(args, Math.max(60, Math.round(((index + 1) / sourceStores.length) * 90)), "Copying login state");
        continue;
      }
      if (!text(shop.shopId) && text(shop.shopName)) {
        record.shopId = "";
        record.shopInfoSummary = {
          ...(record.shopInfoSummary || {}),
          id: "",
          shop_name: text(shop.shopName)
        };
      }
      progress(args, Math.max(60, Math.round(((index + 1) / sourceStores.length) * 85)), `${record.shopName} login copied`);
      const activation = await activateImportedStore(adapter, record, args);
      if (activation.ok) {
        const confirmedRecord = mergeConfirmedStore(record, activation, adapter, index);
        const [saved] = await upsertStoreLedgers([confirmedRecord]);
        if (saved) {
          changed.push(saved);
          storeProgress(args, Math.max(65, Math.round(((index + 1) / sourceStores.length) * 95)), saved, index + 1, sourceStores.length);
        }
      } else {
        await native.cookies.clear({ partition: targetPartition }).catch(() => null);
        const failure = failureDetail(record, activation.message || "target shop not confirmed after import", activation);
        failed.push(failure);
        const failedRecord: DoudianStoreSummary = {
          ...record,
          status: "check_failed",
          lastCheckStatus: "check_failed",
          lastCheckMessage: "登录态未确认，需重新登录",
          lastResult: "待复核",
          lastResultAt: nowIso(),
          lastFailureReason: failure.reason || "activate-store-failed",
          lastFailureMessage: failure.message
        };
        const [saved] = await upsertStoreLedgers([failedRecord]);
        if (saved) {
          storeProgress(args, Math.max(65, Math.round(((index + 1) / sourceStores.length) * 95)), saved, index + 1, sourceStores.length);
        }
      }
    }

    const details = changed.map((store, index) => detailForStore(store, index + 1, changed.length));
    return {
      ...(await listStoreLedger()),
      ok: failed.length === 0,
      status: failed.length ? (changed.length ? "partial" : "failed") : "ok",
      operationId: args.operationId,
      imported: changed.length,
      failed: failed.length,
      message: failed.length
        ? `登录成功已导入 ${changed.length} 家店铺，${failed.length} 家未确认`
        : `登录成功已导入 ${changed.length} 家店铺`,
      details: { imported: details, failed }
    };
  } finally {
    if (loginWinId) await native.windows.destroy({ winId: loginWinId }).catch(() => null);
    await native.cookies.clear({ partition }).catch(() => null);
    await cleanDoudianPartitions(native, adapter).catch(() => null);
  }
}

export async function runDoudianStoreImportStatusSelfCheck(options: { openUrl?: string } = {}) {
  const adapter = await loadDoudianAdapterPayload();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `stage5-self-check-${suffix}`;
  const importOperationId = `stage5-import-${suffix}`;
  const refreshOperationId = `stage5-refresh-${suffix}`;
  const cancelOperationId = `stage5-cancel-${suffix}`;

  const imported = await runFetchDoudianStoresTask({
    operationId: importOperationId,
    doudianAdapter: adapter,
    mockStores: [{
      shopId,
      shopName: `Stage5 自检店铺 ${suffix}`,
      status: "online"
    }]
  });
  const refreshed = await runRefreshDoudianStoreStatusTask({
    operationId: refreshOperationId,
    doudianAdapter: adapter,
    shopIds: [shopId],
    mockStatus: "online"
  });

  let cancelledFlag = false;
  const trackedWindows: number[] = [];
  const cancelPromise = runFetchDoudianStoresTask({
    operationId: cancelOperationId,
    doudianAdapter: adapter,
    mockDelayMs: 1500,
    mockOpenWindowUrl: options.openUrl || location.href,
    mockWindowTitle: "CHIHU Stage5 Cancel Window",
    isCancelled: () => cancelledFlag,
    trackWindow: (winId) => trackedWindows.push(winId),
    mockStores: [{
      shopId: `${shopId}-cancel`,
      shopName: "Stage5 Cancel Store",
      status: "online"
    }]
  });
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  cancelledFlag = true;
  await Promise.all(trackedWindows.map((winId) => window.chihuNative?.windows.destroy({ winId }).catch(() => null)));
  const cancelled = await cancelPromise.catch((error) => ({ ok: false, status: "cancelled", message: error instanceof Error ? error.message : String(error) }));
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  const cancelledWindowClosedOk = trackedWindows.length
    ? (await Promise.all(trackedWindows.map((winId) => window.chihuNative?.windows.isDestroyed?.({ winId })))).every((value) => value === true)
    : false;

  return {
    ok: imported.ok === true && refreshed.ok === true && ((cancelled as DoudianStoreResult).status === "cancelled" || /cancel/i.test(String((cancelled as DoudianStoreResult).message || ""))) && cancelledWindowClosedOk,
    importOk: imported.ok === true && !!imported.stores?.some((store) => store.shopId === shopId),
    refreshOk: refreshed.ok === true && !!refreshed.stores?.some((store) => store.shopId === shopId && store.status === "online"),
    cancelOk: (cancelled as DoudianStoreResult).status === "cancelled" || /cancel/i.test(String((cancelled as DoudianStoreResult).message || "")),
    cancelledWindowClosedOk
  };
}

async function waitForLoginDetection(winId: number, partition: string, args: FetchStoresPayload): Promise<LoginDetectionResult> {
  const native = requireChihuNative();
  const adapter = args.doudianAdapter;
  const timeoutMs = Math.max(3000, Number(args.timeoutMs || adapter.adapter.timeouts?.loginMs || 300000));
  const deadline = Date.now() + timeoutMs;
  let lastApiMessage = "";
  let lastRoleNames: string[] = [];
  let isHomePage = false;
  let homePageAttempts = 0;
  const roleListPollMs = adapterTimeout(adapter.adapter, "shopSwitchPollMs", Number(adapter.adapter.strategies?.roleListPollMs || 1500));
  const probeEvalTimeoutMs = Math.max(3000, adapterTimeout(adapter.adapter, "probeMs", 18000));
  const homePageConfirmAttempts = Math.max(1, Number(adapter.adapter.strategies?.homePageConfirmAttempts || 8));
  if (roleListPollMs > 0) {
    await delayWithCancel(Math.min(roleListPollMs, Math.max(0, deadline - Date.now())), args);
  }
  while (Date.now() < deadline) {
    if (args.isCancelled?.()) throw new Error("cancelled");
    if (await loginWindowClosed(native, winId)) return closedLoginDetection(lastRoleNames, isHomePage);
    const roleNames = await native.windows.command({
      winId,
      command: "collect-role-shop-names",
      timeoutMs: probeEvalTimeoutMs
    }).catch(() => []);
    if (Array.isArray(roleNames) && roleNames.length > 0) {
      lastRoleNames = roleNames.map((name) => text(name)).filter(Boolean);
      if (lastRoleNames.length) {
        const [shopListResult, currentResult] = await Promise.all([
          runDoudianRequestPlan(adapter, { partition, planKey: "shopList" }),
          runDoudianRequestPlan(adapter, { partition, planKey: "currentShop" })
        ]);
        const apiStores = storesFromResponses(shopListResult.data, currentResult.data, adapter);
        return {
          ok: true,
          source: "role-list",
          message: `Doudian role list detected ${lastRoleNames.length} stores`,
          shopListResult,
          currentResult,
          stores: storesFromRoleNames(lastRoleNames, apiStores),
          roleNames: lastRoleNames,
          isHomePage: false
        };
      }
    }

    if (await loginWindowClosed(native, winId)) return closedLoginDetection(lastRoleNames, isHomePage);

    isHomePage = !!(await native.windows.command({
      winId,
      command: "is-home-page",
      timeoutMs: probeEvalTimeoutMs
    }).catch(() => false));
    if (await loginWindowClosed(native, winId)) return closedLoginDetection(lastRoleNames, isHomePage);
    homePageAttempts = isHomePage ? homePageAttempts + 1 : 0;

    const [shopListResult, currentResult] = await Promise.all([
      runDoudianRequestPlan(adapter, { partition, planKey: "shopList" }),
      runDoudianRequestPlan(adapter, { partition, planKey: "currentShop" })
    ]);
    const stores = storesFromResponses(shopListResult.data, currentResult.data, adapter);
    if (stores.length) {
      return {
        ok: true,
        source: "api",
        message: `Doudian store API detected ${stores.length} stores`,
        shopListResult,
        currentResult,
        stores,
        roleNames: lastRoleNames,
        isHomePage
      };
    }
    if (homePageAttempts >= homePageConfirmAttempts) {
      const current = currentShopFromResponse(currentResult, adapter.adapter);
      if (current?.shopId || current?.shopName) {
        return {
          ok: true,
          source: "home-page",
          message: "Doudian home page detected current store",
          shopListResult,
          currentResult,
          stores: [current],
          roleNames: lastRoleNames,
          isHomePage: true
        };
      }
    }
    lastApiMessage = [shopListResult.error, currentResult.error]
      .map((item) => text(item))
      .filter(Boolean)
      .join(" / ");
    await delay(Math.min(roleListPollMs, Math.max(0, deadline - Date.now())));
  }
  return {
    ok: false,
    source: lastRoleNames.length ? "role-list" : "timeout",
    message: lastApiMessage
      ? `Doudian store API did not return stores after ${timeoutMs}ms: ${lastApiMessage}`
      : `Doudian store API did not return stores after ${timeoutMs}ms`,
    roleNames: lastRoleNames,
    isHomePage
  };
}
