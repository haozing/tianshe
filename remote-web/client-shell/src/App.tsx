import { useEffect, useMemo, useState } from "react";
import { defaultConfig, loadConfig, loadManifest, RELEASE_MANIFEST_URL } from "./bridge/config";
import { runBridgeSelfCheck } from "./bridge/client";
import { getDoudianAdapterStatus, loadDoudianAdapterPayload } from "./bridge/doudianAdapter";
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
  restoreDoudianTasks,
  runDoudianBusinessDataSelfCheck,
  runDoudianFileImportSelfCheck,
  runDoudianFundsDataSelfCheck,
  runDoudianStoreImportStatusSelfCheck,
  runDoudianStoreGroupsSelfCheck,
  runDoudianStaleGoodsExecuteSelfCheck,
  runDoudianStaleGoodsScanSelfCheck,
  runDoudianViolationsDataSelfCheck,
  runDoudianRepositorySelfCheck,
  startMockLongDoudianTask,
  type DoudianProgressDetail
} from "./domain/doudian";
import { DiagnosticsPage } from "./components/DiagnosticsPage";
import { BusinessDataPage } from "./components/BusinessDataPage";
import { FundsDataPage } from "./components/FundsDataPage";
import { HomePage } from "./components/HomePage";
import { ModulePage } from "./components/ModulePage";
import { ShellHeader } from "./components/ShellHeader";
import { SlowMovingCleanupPage } from "./components/SlowMovingCleanupPage";
import { StoreManagementPage } from "./components/StoreManagementPage";
import { ViolationsPage } from "./components/ViolationsPage";
import { allModules } from "./data/modules";
import { currentRoute } from "./lib/utils";
import type { DiagnosticEvent, ShellState } from "./types";

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

  const moduleMap = useMemo(() => new Map(allModules.map((item) => [item.route, item])), []);

  useEffect(() => {
    const onHashChange = () => {
      setState((current) => ({ ...current, route: currentRoute() }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const progressEvents: DoudianProgressDetail[] = [];
    const remove = addDoudianProgressListener((progressEvent) => {
      progressEvents.push(progressEvent.detail);
    });
    window.chihuDoudianTaskRuntime = {
      startMock: startMockLongDoudianTask,
      cancel: cancelDoudianTask,
      getStatus: getDoudianTaskStatus,
      restore: restoreDoudianTasks,
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
      })
    };
    return () => {
      remove();
      delete window.chihuDoudianTaskRuntime;
      delete window.chihuDoudianStoreRuntime;
    };
  }, []);

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
          await loadDoudianAdapterPayload();
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

  const routeAliases = useMemo(() => new Map([
    ["/products", "/products/slow-moving"]
  ]), []);
  const effectiveRoute = routeAliases.get(state.route) || state.route;
  const selectedModule = moduleMap.get(effectiveRoute);
  const configStatus = state.configError ? "error" : "ready";
  const bridgeStatus = state.bridge.ok ? "ready" : "missing";

  return (
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
      <ShellHeader route={state.route} workspace={state.workspace} />
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
        <div className={`min-h-0 flex-1 ${state.route === "/stores" || state.route === "/stores/business-data" || state.route === "/stores/funds" || state.route === "/warnings" || effectiveRoute === "/products/slow-moving" ? "overflow-hidden" : "overflow-auto"}`}>
          {state.route === "/system/diagnostics" ? (
            <DiagnosticsPage state={state} />
          ) : state.route === "/stores" ? (
            <StoreManagementPage />
          ) : state.route === "/stores/business-data" ? (
            <BusinessDataPage />
          ) : state.route === "/stores/funds" ? (
            <FundsDataPage />
          ) : state.route === "/warnings" ? (
            <ViolationsPage />
          ) : effectiveRoute === "/products/slow-moving" ? (
            <SlowMovingCleanupPage />
          ) : selectedModule ? (
            <ModulePage module={selectedModule} />
          ) : (
            <HomePage />
          )}
        </div>
      </section>
    </main>
  );
}
