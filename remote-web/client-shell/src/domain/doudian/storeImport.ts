import type {
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
  source: "role-list" | "api" | "timeout";
  message: string;
  shopListResult?: RequestPlanResult;
  currentResult?: RequestPlanResult;
  stores?: Array<Partial<DoudianStoreSummary>>;
}

function nowIso() {
  return new Date().toISOString();
}

function text(value: unknown) {
  return String(value || "").trim();
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

function sourcePartition(adapter: DoudianAdapterPayload, operationId: string) {
  return `${adapter.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_"}source_${partitionToken(operationId)}_${Date.now()}`;
}

function shopPartition(adapter: DoudianAdapterPayload, shop: Partial<DoudianStoreSummary>, index = 0) {
  const id = text(shop.shopId || shop.shopName || `shop_${index}`);
  return `${adapter.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_"}${partitionToken(id)}_${Date.now()}`;
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

function normalizeShopItem(item: unknown): Partial<DoudianStoreSummary> | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const shopId = text(row.shopId || row.shop_id || row.mallId || row.mall_id || row.id);
  const shopName = text(row.shopName || row.shop_name || row.mallName || row.mall_name || row.name || row.label || row.title);
  if (!shopId && !shopName) return null;
  return {
    shopId,
    shopName,
    operateStatus: text(row.operateStatus || row.operate_status || row.operateStatusStr || row.operate_status_str),
    shopInfoSummary: row as DoudianStoreSummary["shopInfoSummary"]
  };
}

function storesFromResponses(shopListData: unknown, currentData: unknown, adapter: DoudianAdapterPayload) {
  const mappings = adapter.adapter.responseMappings;
  const listValue = firstPathValue(shopListData, mappings?.shopListPaths || []);
  const list = Array.isArray(listValue) ? listValue : Array.isArray(shopListData) ? shopListData : [];
  const stores = list.map(normalizeShopItem).filter((item): item is Partial<DoudianStoreSummary> => !!item);
  const currentObject = firstPathValue(currentData, mappings?.currentShopObjectPaths || []);
  const current = normalizeShopItem(currentObject);
  if (current && !stores.some((store) => store.shopId && store.shopId === current.shopId)) stores.unshift(current);
  return stores;
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
  const changed = await upsertStoreLedgers(records);
  const details = changed.map((store, index) => detailForStore(store, index + 1, changed.length));
  for (const item of details) {
    dispatchDoudianProgress({
      operationId: args.operationId,
      taskType: "fetchDoudianStores",
      status: "running",
      progress: Math.round(((item.index || 1) / Math.max(details.length, 1)) * 100),
      message: item.message
    });
  }
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
  progress(args, 5, "Opening Doudian login window");

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

    progress(args, 10, "Waiting for Doudian login state");
    const detection = await waitForLoginDetection(loginWinId, partition, args);
    progress(args, 30, detection.message);
    if (!detection.ok) {
      return {
        ...(await listStoreLedger()),
        ok: false,
        status: "login-timeout",
        operationId: args.operationId,
        message: "未检测到抖店登录完成，请完成登录后重试或确认账号有店铺权限。",
        details: { imported: [], failed: [] }
      };
    }

    let shopListResult = detection.shopListResult;
    let currentResult = detection.currentResult;
    if (!shopListResult || !currentResult) {
      progress(args, 40, "Fetching Doudian store list");
      [shopListResult, currentResult] = await Promise.all([
        runDoudianRequestPlan(adapter, { partition, planKey: "shopList" }),
        runDoudianRequestPlan(adapter, { partition, planKey: "currentShop" })
      ]);
    }
    progress(args, 55, `Store APIs returned ${shopListResult.status}/${currentResult.status}`);
    const detectedStores = detection.stores?.length
      ? detection.stores
      : storesFromResponses(shopListResult.data, currentResult.data, adapter);
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

    const records: DoudianStoreSummary[] = [];
    for (const [index, shop] of sourceStores.entries()) {
      const targetPartition = shopPartition(adapter, shop, index);
      await native.cookies.copy({ fromPartition: partition, toPartition: targetPartition });
      const record = normalizeStore(shop, adapter, targetPartition, index);
      if (record) records.push(record);
      progress(args, Math.max(60, Math.round(((index + 1) / sourceStores.length) * 90)), record ? `${record.shopName} login copied` : "Copying login state");
    }

    const changed = await upsertStoreLedgers(records);
    const details = changed.map((store, index) => detailForStore(store, index + 1, changed.length));
    return {
      ...(await listStoreLedger()),
      ok: true,
      status: "ok",
      operationId: args.operationId,
      imported: changed.length,
      failed: 0,
      message: `登录成功已导入 ${changed.length} 家店铺`,
      details: { imported: details, failed: [] }
    };
  } finally {
    if (loginWinId) await native.windows.destroy({ winId: loginWinId }).catch(() => null);
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
  let roleListDetected = false;
  while (Date.now() < deadline) {
    if (args.isCancelled?.()) throw new Error("cancelled");
    const roleNames = await native.windows.eval({
      winId,
      code: adapter.scripts?.collectRoleShopNames || "[]",
      timeoutMs: 3000
    }).catch(() => []);
    if (Array.isArray(roleNames) && roleNames.length > 0) roleListDetected = true;

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
        stores
      };
    }
    lastApiMessage = [shopListResult.error, currentResult.error]
      .map((item) => text(item))
      .filter(Boolean)
      .join(" / ");
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return {
    ok: false,
    source: roleListDetected ? "role-list" : "timeout",
    message: lastApiMessage
      ? `Doudian store API did not return stores after ${timeoutMs}ms: ${lastApiMessage}`
      : `Doudian store API did not return stores after ${timeoutMs}ms`
  };
}
