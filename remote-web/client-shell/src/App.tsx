import { useEffect, useMemo, useState } from "react";
import { defaultConfig, loadConfig, loadManifest, RELEASE_MANIFEST_URL } from "./bridge/config";
import { listDoudianStores, runBridgeSelfCheck } from "./bridge/client";
import { getDoudianAdapterStatus, loadDoudianAdapterPayload } from "./bridge/doudianAdapter";
import {
  checkLicense,
  getLicenseStatus,
  initialLicenseStatus,
  redeemLicense,
  type LicenseStatus
} from "./bridge/license";
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
  marketingWriteEnabled,
  marketingAdapterSnapshotHash,
  startMarketingScheduleRunner,
  runDoudianStoreTask,
  type MarketingTaskResult,
  startMockLongDoudianTask,
  type DoudianProgressDetail
} from "./domain/doudian";
import { DiagnosticsPage } from "./components/DiagnosticsPage";
import { HomePage } from "./components/HomePage";
import { LicenseGateScreen, LicenseRenewDialog } from "./components/LicenseGate";
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

  useEffect(() => {
    const onHashChange = () => {
      setState((current) => ({ ...current, route: currentRoute() }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const enabled = !!adapterPayload && state.config.features.marketingMenu?.enabled === true && state.config.features.marketingLimitedTime?.enabled === true && marketingWriteEnabled(state.config, adapterPayload.adapter, "limited_time", "tool_renew");
    if (!enabled || !adapterPayload) return startMarketingScheduleRunner({ enabled: false, execute: async () => ({ ok: false }) });
    return startMarketingScheduleRunner({
      enabled: true,
      execute: async (schedule) => {
        if (!schedule.adapterSnapshotHash || schedule.adapterSnapshotHash !== marketingAdapterSnapshotHash(adapterPayload)) return { ok: false };
        const result = await runDoudianStoreTask({
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
        return { ok: result.status === "ok", operationId: result.operationId };
      }
    });
  }, [adapterPayload, state.config]);

  useEffect(() => {
    const progressEvents: DoudianProgressDetail[] = [];
    const remove = addDoudianProgressListener((progressEvent) => {
      progressEvents.push(progressEvent.detail);
    });
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
    void resubscribeDoudianTasks().catch(() => undefined);
    void cleanupMarketingRecords().catch(() => undefined);
    return () => {
      remove();
      delete window.chihuDoudianTaskRuntime;
      delete window.chihuDoudianStoreRuntime;
      delete window.chihuMarketingReadRuntime;
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
      setLicenseStatus(redeemed);
      setLicenseMessage(redeemed.status === "redeemed_refresh_failed" ? redeemed.message || "卡密兑换成功，但授权状态刷新失败。" : redeemed.licensed ? "卡密兑换成功，已绑定当前设备。" : redeemed.message || "卡密兑换失败");
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
  const effectiveRoute = diagnosticsRoute ? "/system/diagnostics" : activeDefinition?.route || firstAvailableRoute(resolvedRoutes);
  const ActiveComponent = activeDefinition?.component;
  const configStatus = state.configError ? "error" : "ready";
  const bridgeStatus = state.bridge.ok ? "ready" : "missing";
  const smokeMode = location.hostname === "chihu-remote.localhost" && new URLSearchParams(location.search).get("smoke") === "1";
  const licenseReady = smokeMode || Boolean(licenseStatus.licensed || licenseStatus.bypass);

  useEffect(() => {
    const accessResolutionReady = state.configSource !== "none" || state.configError !== "" || adapterPayload !== null;
    if (!accessResolutionReady || diagnosticsRoute || !requestedDefinition || activeDefinition) return;
    setRouteGuardMessage(`${requestedDefinition.navigation.label}当前不可用，已返回可用页面。`);
    const fallback = firstAvailableRoute(resolvedRoutes);
    if (state.route !== fallback) location.hash = `#${fallback}`;
  }, [activeDefinition, diagnosticsRoute, requestedDefinition, resolvedRoutes, state.route]);

  if (!licenseReady) {
    return (
      <LicenseGateScreen
        status={licenseStatus}
        checking={licenseChecking}
        redeeming={licenseRedeeming}
        message={licenseMessage}
        onRedeem={submitLicenseCard}
        onRefresh={() => refreshLicense("manual_refresh").then(() => undefined)}
      />
    );
  }

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
            {effectiveRoute === "/system/diagnostics" ? (
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
