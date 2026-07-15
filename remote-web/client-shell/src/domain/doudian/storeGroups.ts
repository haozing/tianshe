import type { DoudianAdapterPayload, DoudianStoreGroup, DoudianStoreResult, DoudianStoreSummary } from "../../types";
import { getChihuNative } from "../../native/client";
import { repositoryDelete, repositoryDeleteMany, repositoryGet, repositoryGetAll, repositoryGetAllByPrefix, repositoryPut, repositoryPutMany } from "./repository";

const DEFAULT_GROUP_NAME = "未分组";
const ALL_GROUP_NAME = "全部分组";

interface StoreRecord extends DoudianStoreSummary {
  id: string;
}

interface GroupRecord {
  id: string;
  groupId: string;
  groupName: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenStoreOptions {
  doudianAdapter?: DoudianAdapterPayload;
  url?: string;
  title?: string;
  show?: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizedText(value: unknown) {
  return String(value || "").trim();
}

function defaultPartition(shopId: string, adapter?: DoudianAdapterPayload) {
  const prefix = adapter?.adapter.shopPartitionPrefix || "persist:chihu_doudian_shop_";
  return `${prefix}${shopId}`;
}

function normalizeGroupName(groupName: unknown) {
  const name = normalizedText(groupName);
  if (!name || name === DEFAULT_GROUP_NAME) return "";
  return name;
}

function publicGroupName(groupName: unknown) {
  return normalizedText(groupName) || DEFAULT_GROUP_NAME;
}

function protectedGroupName(groupName: string) {
  return !groupName || groupName === DEFAULT_GROUP_NAME || groupName === ALL_GROUP_NAME;
}

function toStoreRecord(store: Partial<DoudianStoreSummary> & { shopId?: string; id?: string }, previous?: StoreRecord | null): StoreRecord | null {
  const shopId = normalizedText(store.shopId || store.id);
  if (!shopId) return null;
  const now = nowIso();
  const groupName = normalizeGroupName(store.groupName ?? previous?.groupName);
  const groupId = groupName ? normalizedText(store.groupId || previous?.groupId || groupName) : "";

  return {
    ...(previous || {}),
    ...store,
    id: shopId,
    shopId,
    shopName: normalizedText(store.shopName || previous?.shopName) || `抖店 ${shopId}`,
    platform: "doudian",
    partition: normalizedText(store.partition || previous?.partition) || `persist:chihu_doudian_shop_${shopId}`,
    status: store.status || previous?.status || "unknown",
    operateStatus: normalizedText(store.operateStatus || previous?.operateStatus),
    groupId,
    groupName,
    shopInfoSummary: store.shopInfoSummary || previous?.shopInfoSummary || {},
    createdAt: previous?.createdAt || store.createdAt || now,
    updatedAt: now,
    lastLoginCheckAt: normalizedText(store.lastLoginCheckAt ?? previous?.lastLoginCheckAt),
    lastOnlineAt: normalizedText(store.lastOnlineAt ?? previous?.lastOnlineAt),
    lastCheckStatus: normalizedText(store.lastCheckStatus ?? previous?.lastCheckStatus),
    lastCheckMessage: normalizedText(store.lastCheckMessage ?? previous?.lastCheckMessage),
    lastResult: normalizedText(store.lastResult ?? previous?.lastResult),
    lastResultAt: normalizedText(store.lastResultAt ?? previous?.lastResultAt),
    lastFetchAt: normalizedText(store.lastFetchAt ?? previous?.lastFetchAt),
    lastFailureReason: normalizedText(store.lastFailureReason ?? previous?.lastFailureReason),
    lastFailureMessage: normalizedText(store.lastFailureMessage ?? previous?.lastFailureMessage),
    adapterVersion: normalizedText(store.adapterVersion ?? previous?.adapterVersion)
  };
}

function toPublicStore(record: StoreRecord): DoudianStoreSummary {
  const { id: _id, ...store } = record;
  return store;
}

function toGroupRecord(groupName: string, groupId = groupName, previous?: GroupRecord | null): GroupRecord {
  const now = nowIso();
  return {
    id: groupId || groupName,
    groupId: groupId || groupName,
    groupName,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
}

function snapshot(stores: StoreRecord[], storedGroups: GroupRecord[]): Pick<DoudianStoreResult, "stores" | "groups"> {
  const counts = new Map<string, number>();
  const groups = new Map<string, DoudianStoreGroup>();

  for (const store of stores) {
    const groupName = publicGroupName(store.groupName);
    counts.set(groupName, (counts.get(groupName) || 0) + 1);
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        groupId: store.groupId || (groupName === DEFAULT_GROUP_NAME ? "" : groupName),
        groupName,
        count: 0
      });
    }
  }

  for (const group of storedGroups) {
    if (protectedGroupName(group.groupName)) continue;
    groups.set(group.groupName, {
      groupId: group.groupId || group.groupName,
      groupName: group.groupName,
      count: 0
    });
  }

  if (!groups.has(DEFAULT_GROUP_NAME)) {
    groups.set(DEFAULT_GROUP_NAME, {
      groupId: "",
      groupName: DEFAULT_GROUP_NAME,
      count: 0,
      virtual: true
    });
  }

  return {
    stores: stores.map(toPublicStore).sort((left, right) => {
      const byName = left.shopName.localeCompare(right.shopName, "zh-CN");
      if (byName !== 0) return byName;
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    }),
    groups: Array.from(groups.values())
      .map((group) => ({
        ...group,
        count: counts.get(group.groupName) || 0,
        virtual: group.groupName === DEFAULT_GROUP_NAME || (counts.get(group.groupName) || 0) === 0
      }))
      .sort((left, right) => {
        if (left.groupName === DEFAULT_GROUP_NAME) return -1;
        if (right.groupName === DEFAULT_GROUP_NAME) return 1;
        return left.groupName.localeCompare(right.groupName, "zh-CN");
      })
  };
}

async function ledgerSnapshot(): Promise<Pick<DoudianStoreResult, "stores" | "groups">> {
  const [stores, groups] = await Promise.all([
    repositoryGetAll<StoreRecord>("stores"),
    repositoryGetAll<GroupRecord>("groups")
  ]);
  return snapshot(stores, groups);
}

async function ensureGroup(groupName: string, groupId = groupName) {
  const name = normalizeGroupName(groupName);
  if (!name) return null;
  const id = normalizedText(groupId || name);
  const previous = await repositoryGet<GroupRecord>("groups", id);
  return repositoryPut("groups", toGroupRecord(name, id, previous));
}

export async function upsertStoreLedger(store: Partial<DoudianStoreSummary> & { shopId?: string; id?: string }) {
  const shopId = normalizedText(store.shopId || store.id);
  const previous = shopId ? await repositoryGet<StoreRecord>("stores", shopId) : null;
  const record = toStoreRecord(store, previous);
  if (!record) return null;
  if (record.groupName) await ensureGroup(record.groupName, record.groupId || record.groupName);
  return repositoryPut("stores", record);
}

export async function upsertStoreLedgers(stores: Array<Partial<DoudianStoreSummary> & { shopId?: string; id?: string }>) {
  const inputs = stores || [];
  if (!inputs.length) return [];
  const [existingStores, existingGroups] = await Promise.all([
    repositoryGetAll<StoreRecord>("stores"),
    repositoryGetAll<GroupRecord>("groups")
  ]);
  const previousStores = new Map(existingStores.map((store) => [store.id, store]));
  const previousGroups = new Map(existingGroups.map((group) => [group.id, group]));
  const storeRecords: StoreRecord[] = [];
  const groupRecords = new Map<string, GroupRecord>();

  for (const store of inputs) {
    const shopId = normalizedText(store.shopId || store.id);
    const record = toStoreRecord(store, shopId ? previousStores.get(shopId) : null);
    if (!record) continue;
    storeRecords.push(record);
    previousStores.set(record.id, record);
    if (record.groupName) {
      const groupRecord = toGroupRecord(record.groupName, record.groupId || record.groupName, previousGroups.get(record.groupId || record.groupName));
      groupRecords.set(groupRecord.id, groupRecord);
      previousGroups.set(groupRecord.id, groupRecord);
    }
  }

  if (groupRecords.size) await repositoryPutMany("groups", Array.from(groupRecords.values()));
  const changed = await repositoryPutMany("stores", storeRecords);
  return changed.map(toPublicStore);
}

export async function getStoreLedger(shopId: string) {
  const record = await repositoryGet<StoreRecord>("stores", normalizedText(shopId));
  return record ? toPublicStore(record) : null;
}

export async function listStoreLedger(): Promise<DoudianStoreResult> {
  return {
    ok: true,
    message: "已读取远程店铺台账。",
    ...(await ledgerSnapshot())
  };
}

async function deleteStoreLatestCaches(shopIds: string[]) {
  await Promise.all(shopIds.map(async (shopId) => {
    const [businessRows, violationRows] = await Promise.all([
      repositoryGetAllByPrefix<{ id: string }>("business_latest", `${shopId}::`, { pageSize: 500, maxItems: 10000 }),
      repositoryGetAllByPrefix<{ id: string }>("violations_latest", `${shopId}::`, { pageSize: 500, maxItems: 10000 })
    ]);
    await Promise.all([
      repositoryDelete("funds_latest", shopId).catch(() => undefined),
      repositoryDeleteMany("business_latest", businessRows.map((record) => record.id)),
      repositoryDeleteMany("violations_latest", violationRows.map((record) => record.id))
    ]);
  }));
}

export async function deleteStoreLedger(shopIds: string[]): Promise<DoudianStoreResult> {
  const ids = Array.from(new Set((shopIds || []).map((id) => normalizedText(id)).filter(Boolean)));
  const native = getChihuNative();
  const deletedStores = (await Promise.all(ids.map((id) => repositoryGet<StoreRecord>("stores", id)))).filter((store): store is StoreRecord => !!store);

  await Promise.all(ids.map((id) => repositoryDelete("stores", id)));
  await deleteStoreLatestCaches(ids);
  if (native?.cookies.clear) {
    await Promise.all(deletedStores.map((store) => store.partition ? native.cookies.clear({ partition: store.partition }).catch(() => null) : null));
  }
  const nextSnapshot = await ledgerSnapshot();
  if (native?.partitions.cleanInvalid) {
    const currentPartitions = (nextSnapshot.stores || []).map((store) => normalizedText(store.partition)).filter(Boolean);
    const deletedPartitions = deletedStores.map((store) => normalizedText(store.partition)).filter(Boolean);
    await native.partitions.cleanInvalid({
      currentPartitions,
      prefixes: ["persist:chihu_doudian_shop_", ...deletedPartitions]
    }).catch(() => null);
  }

  return {
    ok: true,
    deleted: deletedStores.length,
    message: `已删除 ${deletedStores.length} 家店铺。`,
    ...nextSnapshot
  };
}

export async function createStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  const name = normalizedText(groupName);
  if (protectedGroupName(name)) {
    return {
      ok: false,
      status: "protected",
      message: "该分组不能创建。",
      ...(await ledgerSnapshot())
    };
  }

  await ensureGroup(name, name);
  return {
    ok: true,
    status: "created",
    message: "已创建分组。",
    updated: 0,
    ...(await ledgerSnapshot())
  };
}

export async function renameStoreGroup(oldGroupName: string, nextGroupName: string): Promise<DoudianStoreResult> {
  const oldName = publicGroupName(oldGroupName);
  const nextName = publicGroupName(nextGroupName);
  if (!oldName || oldName === ALL_GROUP_NAME || nextName === ALL_GROUP_NAME) {
    return {
      ok: false,
      status: "protected",
      message: "该分组不能重命名。",
      ...(await ledgerSnapshot())
    };
  }

  const stores = await repositoryGetAll<StoreRecord>("stores");
  const changed = stores.filter((store) => publicGroupName(store.groupName) === oldName);
  const normalizedNextName = normalizeGroupName(nextName);

  if (normalizedNextName) await ensureGroup(normalizedNextName, normalizedNextName);
  await repositoryPutMany("stores", changed.map((store) => ({
    ...store,
    groupId: normalizedNextName ? normalizedNextName : "",
    groupName: normalizedNextName,
    updatedAt: nowIso()
  })));

  if (oldName !== DEFAULT_GROUP_NAME) {
    const groups = await repositoryGetAll<GroupRecord>("groups");
    await Promise.all(groups.filter((group) => group.groupName === oldName).map((group) => repositoryDelete("groups", group.id)));
  }

  return {
    ok: true,
    updated: changed.length,
    message: `已重命名 ${changed.length} 家店铺的分组。`,
    ...(await ledgerSnapshot())
  };
}

export async function deleteEmptyStoreGroup(groupName: string): Promise<DoudianStoreResult> {
  const name = normalizedText(groupName);
  if (protectedGroupName(name)) {
    return {
      ok: false,
      status: "protected",
      message: "该分组不能删除。",
      ...(await ledgerSnapshot())
    };
  }

  const stores = await repositoryGetAll<StoreRecord>("stores");
  if (stores.some((store) => publicGroupName(store.groupName) === name)) {
    return {
      ok: false,
      status: "not-empty",
      message: "该分组下仍有店铺，不能删除空分组。",
      ...(await ledgerSnapshot())
    };
  }

  const groups = await repositoryGetAll<GroupRecord>("groups");
  await Promise.all(groups.filter((group) => group.groupName === name).map((group) => repositoryDelete("groups", group.id)));
  return {
    ok: true,
    status: "deleted",
    message: "已删除空分组。",
    updated: 0,
    ...(await ledgerSnapshot())
  };
}

export async function updateStoreGroup(shopIds: string[], groupName: string): Promise<DoudianStoreResult> {
  const ids = Array.from(new Set((shopIds || []).map((id) => normalizedText(id)).filter(Boolean)));
  const normalizedGroupName = normalizeGroupName(groupName);
  if (normalizedGroupName) await ensureGroup(normalizedGroupName, normalizedGroupName);

  const existing = (await Promise.all(ids.map((id) => repositoryGet<StoreRecord>("stores", id)))).filter((store): store is StoreRecord => !!store);
  await repositoryPutMany("stores", existing.map((store) => ({
    ...store,
    groupId: normalizedGroupName ? normalizedGroupName : "",
    groupName: normalizedGroupName,
    updatedAt: nowIso()
  })));

  return {
    ok: true,
    updated: existing.length,
    message: `已更新 ${existing.length} 家店铺分组。`,
    ...(await ledgerSnapshot())
  };
}

export async function openStoreWindow(shopId: string, options: OpenStoreOptions = {}): Promise<DoudianStoreResult> {
  const id = normalizedText(shopId);
  const store = id ? await repositoryGet<StoreRecord>("stores", id) : null;
  if (!store) {
    return {
      ok: false,
      status: "missing",
      message: "店铺不存在。",
      ...(await ledgerSnapshot())
    };
  }

  const native = getChihuNative();
  if (!native?.windows.open) {
    return {
      ok: false,
      status: "missing-native",
      message: "native window bridge unavailable",
      currentStore: toPublicStore(store),
      ...(await ledgerSnapshot())
    };
  }

  const url = options.url || options.doudianAdapter?.adapter.homeUrl || options.doudianAdapter?.adapter.loginUrl;
  if (!url) {
    return {
      ok: false,
      status: "missing-url",
      message: "缺少店铺打开地址。",
      currentStore: toPublicStore(store),
      ...(await ledgerSnapshot())
    };
  }

  const winId = await native.windows.open({
    url,
    title: options.title || `${store.shopName || store.shopId} - 抖店后台`,
    partition: store.partition || defaultPartition(store.shopId, options.doudianAdapter),
    width: 1280,
    height: 820,
    show: options.show !== false,
    nodeIntegration: false,
    contextIsolation: true
  });

  return {
    ok: true,
    status: "opened",
    message: "已打开店铺后台。",
    currentStore: toPublicStore(store),
    details: [{
      shopId: store.shopId,
      shopName: store.shopName,
      ok: true,
      message: "已打开店铺后台",
      diagnostic: { winId }
    }],
    ...(await ledgerSnapshot())
  };
}

export async function runDoudianStoreGroupsSelfCheck(options: { openUrl?: string } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `store-self-check-${suffix}`;
  const originalGroupName = `自检分组-${suffix}`;
  const renamedGroupName = `自检改名-${suffix}`;
  let openedWinId: number | null = null;

  try {
    await upsertStoreLedger({
      shopId,
      shopName: `自检店铺 ${suffix}`,
      partition: `persist:chihu-store-self-check-${suffix}`,
      status: "online",
      operateStatus: "正常经营",
      lastFetchAt: nowIso(),
      lastLoginCheckAt: nowIso(),
      lastCheckStatus: "ok",
      lastCheckMessage: "自检通过",
      lastResult: "登录有效",
      lastResultAt: nowIso(),
      adapterVersion: "self-check"
    });

    const listed = await listStoreLedger();
    const listOk = listed.ok && !!listed.stores?.some((store) => store.shopId === shopId);
    const created = await createStoreGroup(originalGroupName);
    const moved = await updateStoreGroup([shopId], originalGroupName);
    const renamed = await renameStoreGroup(originalGroupName, renamedGroupName);
    const opened = await openStoreWindow(shopId, {
      url: options.openUrl || location.href,
      title: "CHIHU Store Self Check",
      show: false
    });
    const diagnostic = Array.isArray(opened.details) ? opened.details[0]?.diagnostic : null;
    openedWinId = typeof diagnostic === "object" && diagnostic && Number.isInteger((diagnostic as { winId?: unknown }).winId)
      ? (diagnostic as { winId: number }).winId
      : null;
    const deletedStore = await deleteStoreLedger([shopId]);
    const deletedGroup = await deleteEmptyStoreGroup(renamedGroupName);

    return {
      ok: listOk && created.ok && moved.ok && renamed.ok && opened.ok && deletedStore.ok && deletedGroup.ok,
      listOk,
      createOk: created.ok,
      updateOk: moved.ok,
      renameOk: renamed.ok,
      openOk: opened.ok,
      deleteStoreOk: deletedStore.ok,
      deleteGroupOk: deletedGroup.ok,
      openedWinId
    };
  } finally {
    if (openedWinId) {
      await getChihuNative()?.windows.destroy({ winId: openedWinId }).catch(() => null);
    }
    await repositoryDelete("stores", shopId).catch(() => undefined);
    const groups = await repositoryGetAll<GroupRecord>("groups").catch(() => []);
    await Promise.all(groups
      .filter((group) => group.groupName === originalGroupName || group.groupName === renamedGroupName)
      .map((group) => repositoryDelete("groups", group.id).catch(() => undefined)));
  }
}
