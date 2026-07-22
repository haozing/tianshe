import { useEffect, useMemo, useRef, useState } from "react";
import { defaultConfig, loadConfig, loadManifest, RELEASE_MANIFEST_URL } from "./bridge/config";
import { listDoudianStores, runBridgeSelfCheck } from "./bridge/client";
import { getDoudianAdapterStatus, loadDoudianAdapterPayload } from "./bridge/doudianAdapter";
import {
  canAccessTier,
  checkLicense,
  getLicenseStatus,
  initialLicenseStatus,
  paidAccessRefreshDelayMs,
  redeemLicense,
  type LicenseStatus
} from "./bridge/license";
import { isSuccessfulLicenseRedemption } from "./bridge/licenseRedemption";
import {
  initStorage,
  refreshStorageHealth,
  STORAGE_KEY_DIAGNOSTICS,
  storageSet
} from "./bridge/storage";
import {
  addDoudianProgressListener,
  cancelDoudianTask,
  getDoudianTaskStatus,
  resubscribeDoudianTasks,
  runDoudianBulkDeleteSelfCheck,
  runDoudianBusinessDataSelfCheck,
  runDoudianFileImportSelfCheck,
  runDoudianFundsDataSelfCheck,
  runDoudianOpportunityReportSelfCheck,
  runProductCatalogSyncSelfCheck,
  runDoudianStoreImportStatusSelfCheck,
  runDoudianStoreGroupsSelfCheck,
  runDoudianStaleGoodsExecuteSelfCheck,
  runDoudianStaleGoodsScanSelfCheck,
  runDoudianViolationsDataSelfCheck,
  runDoudianRepositorySelfCheck,
  cleanupMarketingRecords,
  deferredMarketingScheduleReason,
  marketingWriteEnabled,
  marketingAdapterSnapshotHash,
  startMarketingScheduleRunner,
  rebaseDeferredMarketingSchedules,
  runDoudianStoreTask,
  type MarketingTaskResult,
  startMockLongDoudianTask,
  type DoudianProgressDetail
} from "./domain/doudian";
import { DiagnosticsPage } from "./components/DiagnosticsPage";
import { HomePage } from "./components/HomePage";
import { LicenseRenewDialog, PaidFeatureGate } from "./components/LicenseGate";
import { ShellHeader } from "./components/ShellHeader";
import { findFeatureRoute, firstAvailableRoute, resolveFeatureRoutes } from "./featureRoutes";
import { currentRoute } from "./lib/utils";
import type { DiagnosticEvent, DoudianAdapterPayload, ShellState } from "./types";

const initialBridge = {
  ok: false,
  hasClient: false,
  methodCount: 0,
  expectedMethodCount: 0,
  missingMethods: ["pending"]
};

const initialDoudianAdapter = {
  ok: false,
  source: "none" as const,
  adapterVersion: "",
  scriptsVersion: "",
  loadedAt: "",
  lastGoodAt: "",
  lastFailureReason: ""
};

function event(level: DiagnosticEvent["level"], category: string, message: string, detail: unknown = null): DiagnosticEvent {
  return {
    time: new Date().toISOString(),
    level,
    category,
    message,
    detail
  };
}

export function App() {
  const [state, setState] = useState<ShellState>(() => ({
    config: defaultConfig(),
    configSource: "none",
    configError: "",
    manifest: null,
    manifestError: "",
    bridge: initialBridge,
    doudianAdapter: getDoudianAdapterStatus(),
    diagnostics: [],
    storageHealth: "unknown",
    route: currentRoute(),
    workspace: initStorage()
  }));
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus>(initialLicenseStatus);
  const [licenseChecking, setLicenseChecking] = useState(true);
  const [licenseRedeeming, setLicenseRedeeming] = useState(false);
  const [licenseMessage, setLicenseMessage] = useState("");
  const [licenseDialogOpen, setLicenseDialogOpen] = useState(false);
  const [adapterPayload, setAdapterPayload] = useState<DoudianAdapterPayload | null>(null);
  const [routeGuardMessage, setRouteGuardMessage] = useState("");
  const previousPaidAccess = useRef(false);

  useEffect(() => {
    const onHashChange = () => {
      setState((current) => ({ ...current, route: currentRoute() }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const enabled = !!adapterPayload && state.config.features.marketingMenu?.enabled === true && state.config.features.marketingLimitedTime?.enabled === true && marketingWriteEnabled(state.config, adapterPayload.adapter, "limited_time", "tool_renew");
    if (!enabled || !adapterPayload) return startMarketingScheduleRunner({ enabled: false, execute: async () => ({ outcome: "deferred", reason: "auth_check_failed" }) });
    return startMarketingScheduleRunner({
      enabled: true,
      execute: async (schedule) => {
        if (!licenseStatus.paidAccessGranted) {
          return { outcome: "deferred", reason: licenseStatus.verificationPending ? "auth_check_failed" : "license_required" };
        }
        if (!schedule.adapterSnapshotHash || schedule.adapterSnapshotHash !== marketingAdapterSnapshotHash(adapterPayload)) return { outcome: "executed", ok: false };
        let result: MarketingTaskResult;
        try {
          result = await runDoudianStoreTask({
            taskType: "marketingTask",
            adapterVersion: adapterPayload.adapter.version,
            ruleVersion: adapterPayload.scripts?.version || "",
            metadata: { mutation: true, replaceActive: false, adapterSnapshotHash: marketingAdapterSnapshotHash(adapterPayload), dedupeKey: `${schedule.id}:${schedule.nextRunAt}` },
            payload: {
              feature: schedule.feature,
              action: "tool_renew",
              stores: [{ shopId: schedule.shopId, shopName: schedule.shopId, partition: schedule.partition, tenantId: schedule.tenantId, storeGeneration: schedule.storeGeneration }],
              context: { entityIds: [schedule.entityId], intervalDays: Math.max(1, Math.round(schedule.intervalMs / 86_400_000)) },
              config: state.config,
              doudianAdapter: adapterPayload
            }
          }, 900_000) as unknown as MarketingTaskResult;
        } catch (error) {
          const reason = deferredMarketingScheduleReason(error);
          if (reason) return { outcome: "deferred", reason };
          throw error;
        }
        const entity = result.entities?.[0];
        const start = Date.parse(entity?.startTime || "");
        const end = Date.parse(entity?.endTime || "");
        const intervalMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : schedule.intervalMs;
        return {
          outcome: "executed" as const,
          ok: result.status === "ok" && !!entity?.entityId,
          operationId: result.operationId,
          entityId: entity?.entityId,
          intervalMs,
          nextRunAt: Number.isFinite(end) ? new Date(Math.max(Date.now(), end - 24 * 60 * 60 * 1000)).toISOString() : undefined
        };
      }
    });
  }, [adapterPayload, licenseStatus.paidAccessGranted, licenseStatus.verificationPending, state.config]);

  useEffect(() => {
    const paid = licenseStatus.paidAccessGranted === true;
    if (paid && !previousPaidAccess.current) {
      void rebaseDeferredMarketingSchedules().catch(() => undefined);
      void cleanupMarketingRecords().catch(() => undefined);
    }
    previousPaidAccess.current = paid;
  }, [licenseStatus.paidAccessGranted]);

  useEffect(() => {
    const progressEvents: DoudianProgressDetail[] = [];
    const remove = addDoudianProgressListener((progressEvent) => {
      progressEvents.push(progressEvent.detail);
    });
    const smokeRuntime = location.hostname.endsWith(".localhost") && new URLSearchParams(location.search).get("smoke") === "1";
    if (smokeRuntime) {
    window.chihuDoudianTaskRuntime = {
      startMock: startMockLongDoudianTask,
      cancel: cancelDoudianTask,
      getStatus: getDoudianTaskStatus,
      restore: resubscribeDoudianTasks,
      repositorySelfCheck: runDoudianRepositorySelfCheck,
      snapshot: () => ({ progressEvents: [...progressEvents] })
    };
    window.chihuDoudianStoreRuntime = {
      selfCheck: runDoudianStoreGroupsSelfCheck,
      stage5SelfCheck: runDoudianStoreImportStatusSelfCheck,
      businessDataSelfCheck: async () => runDoudianBusinessDataSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      fundsDataSelfCheck: async () => runDoudianFundsDataSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      violationsDataSelfCheck: async () => runDoudianViolationsDataSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      fileImportSelfCheck: runDoudianFileImportSelfCheck,
      staleGoodsScanSelfCheck: async () => runDoudianStaleGoodsScanSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      staleGoodsExecuteSelfCheck: async () => runDoudianStaleGoodsExecuteSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      bulkDeleteSelfCheck: async () => runDoudianBulkDeleteSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      opportunityReportSelfCheck: async () => runDoudianOpportunityReportSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      }),
      productCatalogSelfCheck: async () => runProductCatalogSyncSelfCheck({
        doudianAdapter: await loadDoudianAdapterPayload({ force: true })
      })
    };
    window.chihuMarketingReadRuntime = {
      writeProbe: async () => {
        if (new URLSearchParams(window.location.search).get("smoke") !== "1") throw new Error("marketing write probe requires smoke mode");
        const [{ config }, doudianAdapter, storeResult] = await Promise.all([
          loadConfig(),
          loadDoudianAdapterPayload({ force: true }),
          listDoudianStores()
        ]);
        const stores = (storeResult.stores || []).filter((item) => item.status === "online" && item.partition);
        const store = stores[0];
        if (!store) throw new Error("no online Doudian store is available for the marketing write probe");
        if (!marketingWriteEnabled(config, doudianAdapter.adapter, "general_coupon", "create") || !marketingWriteEnabled(config, doudianAdapter.adapter, "general_coupon", "cancel")) {
          throw new Error("general coupon create/cancel capability is not enabled");
        }
        const run = (action: "create" | "cancel" | "detail", context: Record<string, unknown>) => runDoudianStoreTask({
          taskType: "marketingTask",
          adapterVersion: doudianAdapter.adapter.version,
          ruleVersion: doudianAdapter.scripts?.version || "",
          metadata: {
            mutation: action !== "detail",
            replaceActive: action === "detail",
            adapterSnapshotHash: marketingAdapterSnapshotHash(doudianAdapter),
            dedupeKey: `marketing-live-write-probe:${action}:${Date.now()}`
          },
          payload: {
            feature: "general_coupon",
            action,
            stores: [{ shopId: store.shopId, shopName: store.shopName, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration }],
            context,
            config,
            doudianAdapter
          }
        }, 180_000) as unknown as Promise<MarketingTaskResult>;
        const startTime = new Date(Date.now() + 15 * 60_000).toISOString();
        const endTime = new Date(Date.parse(startTime) + 24 * 60 * 60_000).toISOString();
        const create = await run("create", {
          scope: "shop",
          startTime,
          endTime,
          discountMode: "discount",
          discountValue: "9.9",
          issueCount: "1",
          perUserLimit: "1",
          officialRenew: false,
          couponValidityMode: "days",
          couponValidDays: "1",
          couponNameMode: "prefix",
          couponNamePrefix: "赤狐实测",
          couponProductsPerCoupon: "200",
          productIds: [],
          productIdsByShop: { [store.shopId]: [] },
          selectedProductsByShop: { [store.shopId]: [] }
        });
        const created = create.entities?.find((entity) => entity.entityId);
        if (create.status !== "ok" || !created?.entityId) {
          return { ok: false, storeCount: stores.length, createStatus: create.status, cancelStatus: "not-run", verificationStatus: "not-run", cleanupRequired: create.status === "ok" };
        }
        const selectedEntity = { ...created, rawStatus: created.rawStatus || "13", status: created.status || "未开始" };
        const cancel = await run("cancel", {
          entityId: created.entityId,
          entityIds: [created.entityId],
          selectedEntity,
          selectedEntities: [selectedEntity],
          entityIdsByShop: { [store.shopId]: [created.entityId] },
          selectedEntitiesByShop: { [store.shopId]: [selectedEntity] }
        });
        const detail = await run("detail", { entityId: created.entityId });
        const verifiedStatus = detail.entities?.[0]?.rawStatus || "";
        const cancelled = cancel.status === "ok" && verifiedStatus === "2";
        return {
          ok: create.status === "ok" && cancelled,
          storeCount: stores.length,
          createStatus: create.status,
          cancelStatus: cancel.status,
          verificationStatus: verifiedStatus === "2" ? "cancelled" : verifiedStatus || detail.status,
          cleanupRequired: !cancelled
        };
      },
      probe: async () => {
        const [{ config }, doudianAdapter, storeResult] = await Promise.all([
          loadConfig(),
          loadDoudianAdapterPayload({ force: true }),
          listDoudianStores()
        ]);
        const stores = (storeResult.stores || []).filter((item) => item.status === "online" && item.partition).slice(0, 5);
        if (!stores.length) throw new Error("no online Doudian store is available for the marketing read probe");
        const checks: Array<{ feature: string; action: string; ok: boolean; status: string; count: number; storesTried?: number; skipped?: boolean; diagnostic?: string }> = [];
        const diagnostic = (result: MarketingTaskResult) => String(result.stores.find((item) => !item.ok)?.message || "")
          .replace(/\b\d{6,}\b/g, "[id]")
          .slice(0, 160);
        const runRead = async (feature: "limited_time" | "new_user_bonus" | "general_coupon", action: "load_products" | "list" | "detail", store: typeof stores[number], context: Record<string, unknown> = {}) => runDoudianStoreTask({
          taskType: "marketingTask",
          adapterVersion: doudianAdapter.adapter.version,
          ruleVersion: doudianAdapter.scripts?.version || "",
          metadata: {
            mutation: false,
            replaceActive: true,
            adapterSnapshotHash: marketingAdapterSnapshotHash(doudianAdapter),
            dedupeKey: `marketing-read-probe:${feature}:${action}:${Date.now()}`
          },
          payload: {
            feature,
            action,
            stores: [{ shopId: store.shopId, shopName: store.shopName, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration }],
            context,
            config,
            doudianAdapter
          }
        }, 180_000) as unknown as Promise<MarketingTaskResult>;
        for (const feature of ["limited_time", "new_user_bonus", "general_coupon"] as const) {
          const products = await runRead(feature, "load_products", stores[0]);
          checks.push({ feature, action: "load_products", ok: products.status === "ok", status: products.status, count: products.entities?.length || 0, storesTried: 1, diagnostic: diagnostic(products) });
          let list: MarketingTaskResult | null = null;
          let firstSuccessfulList: MarketingTaskResult | null = null;
          let lastFailedList: MarketingTaskResult | null = null;
          let listStore = stores[0];
          let firstSuccessfulStore = stores[0];
          let storesTried = 0;
          for (const candidate of stores) {
            storesTried += 1;
            const candidateList = await runRead(feature, "list", candidate);
            if (candidateList.status === "ok") {
              if (!firstSuccessfulList) {
                firstSuccessfulList = candidateList;
                firstSuccessfulStore = candidate;
              }
              if (candidateList.entities.length > 0) {
                list = candidateList;
                listStore = candidate;
                break;
              }
            } else {
              lastFailedList = candidateList;
            }
          }
          if (!list && firstSuccessfulList) {
            list = firstSuccessfulList;
            listStore = firstSuccessfulStore;
          }
          if (!list) list = lastFailedList;
          if (!list) throw new Error(`marketing list probe did not run for ${feature}`);
          const firstEntityId = list.entities?.[0]?.entityId || "";
          checks.push({ feature, action: "list", ok: list.status === "ok", status: list.status, count: list.entities?.length || 0, storesTried, diagnostic: diagnostic(list) });
          if (!firstEntityId) {
            checks.push({ feature, action: "detail", ok: false, status: "not-run-empty-list", count: 0, storesTried, skipped: true });
            continue;
          }
          const detail = await runRead(feature, "detail", listStore, { entityId: firstEntityId });
          checks.push({ feature, action: "detail", ok: detail.status === "ok" && detail.entities.length > 0, status: detail.status, count: detail.entities.length, storesTried, diagnostic: diagnostic(detail) });
        }
        return {
          ok: checks.every((check) => check.ok),
          storeCount: storeResult.stores?.length || 0,
          writeActionsEnabled: config.features.marketingWriteActions?.enabled === true,
          checks
        };
      }
    };
    }
    void resubscribeDoudianTasks().catch(() => undefined);
    return () => {
      remove();
      if (smokeRuntime) {
        delete window.chihuDoudianTaskRuntime;
        delete window.chihuDoudianStoreRuntime;
        delete window.chihuMarketingReadRuntime;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootLicense() {
      setLicenseChecking(true);
      setLicenseMessage("");
      const stored = await getLicenseStatus();
      if (!cancelled) setLicenseStatus(stored);
      const checked = await checkLicense("startup");
      if (!cancelled) {
        setLicenseStatus(checked);
        setLicenseMessage(checked.licensed ? "" : checked.message || "");
        setLicenseChecking(false);
      }
    }

    void bootLicense().catch((error) => {
      if (!cancelled) {
        setLicenseStatus({
          ...initialLicenseStatus,
          status: "error",
          reason: "LICENSE_CHECK_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
        setLicenseChecking(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const delayMs = paidAccessRefreshDelayMs(licenseStatus);
    if (delayMs === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkLicense("lease_refresh").then((checked) => {
        if (cancelled) return;
        setLicenseStatus(checked);
        if (!checked.paidAccessGranted) setLicenseMessage(checked.message || "授权已失效，请重新验证");
      }).catch((error) => {
        if (!cancelled) setLicenseMessage(error instanceof Error ? error.message : String(error));
      });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [licenseStatus.lastCheckedAt, licenseStatus.paidAccessGranted, licenseStatus.paidAccessLeaseRemainingSeconds, licenseStatus.paidAccessSource]);

  async function refreshLicense(scene = "manual_refresh") {
    setLicenseChecking(true);
    setLicenseMessage("");
    try {
      const checked = await checkLicense(scene);
      setLicenseStatus(checked);
      setLicenseMessage(checked.licensed ? "授权状态已刷新" : checked.message || "");
      return checked;
    } finally {
      setLicenseChecking(false);
    }
  }

  async function submitLicenseCard(cardKey: string) {
    setLicenseRedeeming(true);
    setLicenseMessage("");
    try {
      const redeemed = await redeemLicense(cardKey);
      const redemptionSucceeded = isSuccessfulLicenseRedemption(redeemed);
      setLicenseStatus(redeemed);
      setLicenseMessage(redeemed.status === "redeemed_refresh_failed" ? redeemed.message || "卡密兑换成功，但授权状态刷新失败。" : redemptionSucceeded ? "卡密兑换成功，已绑定当前设备。" : redeemed.message || "卡密兑换失败，请检查卡密后重试。");
      if (redemptionSucceeded) setLicenseDialogOpen(false);
      return redemptionSucceeded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLicenseStatus((current) => ({
        ...current,
        ok: false,
        status: "redeem_error",
        reason: "CARD_REDEEM_FAILED",
        message
      }));
      setLicenseMessage(message || "卡密兑换失败，请稍后重试。");
      return false;
    } finally {
      setLicenseRedeeming(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const diagnostics: DiagnosticEvent[] = [];
      const push = (item: DiagnosticEvent) => diagnostics.unshift(item);

      let nextConfig = defaultConfig();
      let configSource: ShellState["configSource"] = "none";
      let configError = "";
      let manifest = null;
      let manifestError = "";
      let bridge = initialBridge;
      let doudianAdapter = getDoudianAdapterStatus();
      let loadedAdapterPayload: DoudianAdapterPayload | null = null;
      let storageHealth = "unknown" as ShellState["storageHealth"];

      try {
        storageHealth = refreshStorageHealth();
        push(event("info", "storage", "storage_checked", { status: storageHealth }));

        try {
          const loaded = await loadConfig();
          nextConfig = loaded.config;
          configSource = loaded.source;
          push(event("info", "config", "config_loaded", { source: loaded.source, version: loaded.config.version }));
        } catch (error) {
          configSource = "error-default";
          configError = error instanceof Error ? error.message : String(error);
          push(event("error", "config", "config_error", { message: configError }));
        }

        try {
          manifest = await loadManifest();
          push(event("info", "release", "manifest_loaded", { releaseId: manifest.releaseId }));
        } catch (error) {
          manifestError = error instanceof Error ? error.message : String(error);
          push(event("error", "release", "manifest_error", { message: manifestError }));
        }

        bridge = await runBridgeSelfCheck();
        push(event(bridge.ok ? "info" : "warn", "bridge", "bridge_self_check", {
          methodCount: bridge.methodCount,
          missingMethods: bridge.missingMethods
        }));
        try {
          loadedAdapterPayload = await loadDoudianAdapterPayload();
        } catch (error) {
          push(event("error", "doudian-adapter", "adapter_error", {
            message: error instanceof Error ? error.message : String(error)
          }));
        }
        doudianAdapter = getDoudianAdapterStatus();
        push(event(doudianAdapter.ok ? "info" : "warn", "doudian-adapter", "adapter_status", doudianAdapter));
        storageHealth = refreshStorageHealth();
      } catch (error) {
        push(event("error", "boot", "boot_error", { message: error instanceof Error ? error.message : String(error) }));
      }

      try {
        storageSet(STORAGE_KEY_DIAGNOSTICS, diagnostics.slice(0, 30));
      } catch {}

      if (!cancelled) {
        setAdapterPayload(loadedAdapterPayload);
        setState((current) => ({
          ...current,
          config: nextConfig,
          configSource,
          configError,
          manifest,
          manifestError,
          bridge,
          doudianAdapter,
          diagnostics,
          storageHealth
        }));
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolvedRoutes = useMemo(() => resolveFeatureRoutes(state.config, adapterPayload?.adapter), [state.config, adapterPayload]);
  const requestedDefinition = findFeatureRoute(state.route);
  const activeDefinition = findFeatureRoute(state.route, resolvedRoutes);
  const diagnosticsRoute = state.route === "/system/diagnostics";
  const homeRoute = state.route === "/";
  const routeResolutionReady = state.configSource !== "none" && (adapterPayload !== null || state.doudianAdapter.lastFailureReason !== "");
  const routeState = !routeResolutionReady
    ? "loading"
    : diagnosticsRoute || homeRoute
      ? "active"
      : !requestedDefinition || !activeDefinition
        ? "unavailable"
        : canAccessTier(licenseStatus, activeDefinition.accessTier)
          ? "active"
          : "locked";
  const effectiveRoute = diagnosticsRoute ? "/system/diagnostics" : activeDefinition?.route || firstAvailableRoute(resolvedRoutes);
  const ActiveComponent = activeDefinition?.component;
  const configStatus = state.configError ? "error" : "ready";
  const bridgeStatus = state.bridge.ok ? "ready" : "missing";

  useEffect(() => {
    if (routeState !== "unavailable" || diagnosticsRoute || homeRoute) return;
    setRouteGuardMessage(`${requestedDefinition?.navigation.label || "该页面"}当前不可用，已返回可用页面。`);
    const fallback = firstAvailableRoute(resolvedRoutes);
    if (state.route !== fallback) location.hash = `#${fallback}`;
  }, [diagnosticsRoute, homeRoute, requestedDefinition, resolvedRoutes, routeState, state.route]);

  return (
    <>
      <main
        className="grid h-screen grid-rows-[84px_minmax(0,1fr)] bg-[#f5f7fb] text-shell-text max-[860px]:h-auto max-[860px]:min-h-screen max-[860px]:grid-rows-[auto_minmax(0,1fr)]"
        data-foundation-shell="ready"
        data-client-shell="ready"
        data-single-entry="true"
        data-route-slot="ready"
        data-entry-origin={location.origin}
        data-config-status={configStatus}
        data-config-source={state.configSource}
        data-config-schema={state.config.schemaVersion}
        data-bridge-status={bridgeStatus}
        data-bridge-method-count={state.bridge.methodCount || 0}
        data-storage-health={state.storageHealth}
        data-release-manifest={RELEASE_MANIFEST_URL}
      >
        <ShellHeader
          route={state.route}
          routes={resolvedRoutes}
          workspace={state.workspace}
          licenseStatus={licenseStatus}
          onOpenLicenseDialog={() => setLicenseDialogOpen(true)}
        />
        <section className="flex min-h-0 flex-col gap-4 overflow-hidden p-4 max-[760px]:overflow-visible max-[760px]:p-3">
          {state.configError ? (
            <div className="flex min-h-[38px] items-center gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
              <strong>Config error</strong>
              <span className="min-w-0 break-words">{state.configError}</span>
            </div>
          ) : null}
          {state.manifestError ? (
            <div className="flex min-h-[38px] items-center gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
              <strong>Manifest error</strong>
              <span className="min-w-0 break-words">{state.manifestError}</span>
            </div>
          ) : null}
          {routeGuardMessage ? <div className="flex min-h-[38px] items-center justify-between gap-3 rounded-lg border border-[#ffdca8] bg-[#fff7e8] px-3 py-2 text-[13px] text-[#8a4b00]"><span>{routeGuardMessage}</span><button className="font-semibold" type="button" onClick={() => setRouteGuardMessage("")}>关闭</button></div> : null}
          <div className={`min-h-0 flex-1 ${activeDefinition?.overflow === "hidden" ? "overflow-hidden" : "overflow-auto"}`} data-resolved-route={effectiveRoute}>
            {routeState === "loading" ? (
              <div className="grid min-h-full place-items-center text-[13px] font-medium text-[#667085]">正在加载功能配置...</div>
            ) : routeState === "locked" ? (
              <PaidFeatureGate
                status={licenseStatus}
                checking={licenseChecking}
                redeeming={licenseRedeeming}
                message={licenseMessage}
                onRedeem={submitLicenseCard}
                onRefresh={() => refreshLicense("paid_route_refresh").then(() => undefined)}
              />
            ) : effectiveRoute === "/system/diagnostics" ? (
              <DiagnosticsPage state={state} />
            ) : ActiveComponent ? (
              <ActiveComponent />
            ) : (
              <HomePage routes={resolvedRoutes} />
            )}
          </div>
        </section>
      </main>
      <LicenseRenewDialog
        open={licenseDialogOpen}
        status={licenseStatus}
        checking={licenseChecking}
        redeeming={licenseRedeeming}
        message={licenseMessage}
        onOpenChange={setLicenseDialogOpen}
        onRedeem={submitLicenseCard}
        onRefresh={() => refreshLicense("license_dialog").then(() => undefined)}
      />
    </>
  );
}
