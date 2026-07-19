import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import { RELEASE_MANIFEST_URL } from "../bridge/config";
import { STORAGE_KEYS } from "../bridge/storage";
import {
  addDoudianProgressListener,
  cancelDoudianTask,
  runDoudianRepositorySelfCheck,
  resubscribeDoudianTasks,
  startMockLongDoudianTask,
  type DoudianOperationRecord,
  type DoudianProgressDetail
} from "../domain/doudian";
import type { ShellState } from "../types";
import { StatusPill } from "./StatusPill";

function KeyValue({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="m-0 grid gap-2.5">
      {rows.map(([key, value]) => (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3" key={key}>
          <dt className="text-shell-muted">{key}</dt>
          <dd className="m-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({ title, marker, children }: { title: string; marker: string; children: React.ReactNode }) {
  return (
    <section className="min-h-0 overflow-auto rounded-lg border border-shell-line bg-white p-4">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-extrabold">{title}</h2>
        <span className="text-xs text-shell-muted">{marker}</span>
      </div>
      {children}
    </section>
  );
}

export function DiagnosticsPage({ state }: { state: ShellState }) {
  const bridgeStatus = state.bridge.ok ? "ready" : "missing";
  const configStatus = state.configError ? "error" : "ready";
  const [operation, setOperation] = useState<DoudianOperationRecord | null>(null);
  const [progress, setProgress] = useState<DoudianProgressDetail | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [repositoryStatus, setRepositoryStatus] = useState("pending");

  useEffect(() => {
    let cancelled = false;
    resubscribeDoudianTasks().then((records) => {
      if (cancelled) return;
      setActiveCount(records.length);
      setOperation(records[0] || null);
    }).catch(() => {
      if (!cancelled) setActiveCount(0);
    });
    runDoudianRepositorySelfCheck().then((result) => {
      if (!cancelled) setRepositoryStatus(result.ok ? `${result.dbName} / ${result.objectStores.length} stores` : "failed");
    }).catch((error) => {
      if (!cancelled) setRepositoryStatus(error instanceof Error ? error.message : String(error));
    });
    const remove = addDoudianProgressListener((event) => {
      setProgress(event.detail);
    });
    return () => {
      cancelled = true;
      remove();
    };
  }, []);

  async function startMockTask() {
    const record = await startMockLongDoudianTask({
      durationMs: 3000,
      stepMs: 300,
      adapterVersion: state.doudianAdapter.adapterVersion,
      ruleVersion: state.doudianAdapter.contractVersion,
      metadata: { source: "diagnostics" }
    });
    setOperation(record);
    setProgress({
      operationId: record.operationId,
      taskType: record.taskType,
      status: "running",
      progress: 0,
      message: "mock task started"
    });
    setActiveCount((count) => Math.max(1, count));
  }

  async function cancelMockTask() {
    if (!operation) return;
    await cancelDoudianTask(operation.operationId);
    setActiveCount(0);
  }

  return (
    <section className="min-h-0 rounded-xl border border-shell-line bg-white/90 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]" data-business-slot="ready">
      <div className="mb-5 flex min-w-0 items-start justify-between gap-4">
        <div>
          <span className="mb-1.5 inline-flex text-xs font-extrabold text-brand-fox">系统</span>
          <h1 className="m-0 text-2xl font-extrabold leading-tight text-shell-strong">赤狐管家诊断中心</h1>
          <p className="m-0 leading-relaxed text-shell-muted">底座自检保留在这里，方便发布和排障。</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <StatusPill status={configStatus} />
          <StatusPill status={bridgeStatus} />
          <StatusPill status={state.storageHealth} />
        </div>
      </div>

      <Tabs.Root defaultValue="overview">
        <Tabs.List className="mb-3 flex gap-2">
          <Tabs.Trigger className="rounded-md px-3 py-1.5 text-sm font-extrabold text-shell-muted data-[state=active]:bg-brand-foxSoft data-[state=active]:text-brand-navy" value="overview">
            Overview
          </Tabs.Trigger>
          <Tabs.Trigger className="rounded-md px-3 py-1.5 text-sm font-extrabold text-shell-muted data-[state=active]:bg-brand-foxSoft data-[state=active]:text-brand-navy" value="events">
            Events
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview">
          <div className="grid grid-cols-2 gap-3.5 max-[760px]:grid-cols-1">
            <Panel title="Foundation Status" marker="foundation">
              <KeyValue
                rows={[
                  ["Config", state.config.version],
                  ["Shell", `${state.config.shell.mode} / ${state.config.shell.shellVersion}`],
                  ["Release", state.manifest?.releaseId || "manifest pending"],
                  ["Manifest", RELEASE_MANIFEST_URL]
                ]}
              />
              {state.configError ? <p className="mt-2.5 text-red-600">Config error: {state.configError}</p> : null}
              {state.manifestError ? <p className="mt-2.5 text-red-600">Manifest error: {state.manifestError}</p> : null}
            </Panel>

            <Panel title="Bridge" marker={bridgeStatus}>
              <KeyValue
                rows={[
                  ["window.client", state.bridge.hasClient ? "present" : "missing"],
                  ["Methods", `${state.bridge.methodCount || 0} / ${state.bridge.expectedMethodCount || 0}`],
                  ["Missing", state.bridge.missingMethods.join(", ") || "none"]
                ]}
              />
            </Panel>

            <Panel title="Doudian Adapter" marker={state.doudianAdapter.source}>
              <KeyValue
                rows={[
                  ["Status", state.doudianAdapter.ok ? "ready" : "unloaded"],
                  ["Contract", state.doudianAdapter.contractVersion || "-"],
                  ["Adapter", state.doudianAdapter.adapterVersion || "-"],
                  ["Scripts", state.doudianAdapter.scriptsVersion || "-"],
                  ["Actions", state.doudianAdapter.capabilities?.actions?.join(", ") || "-"],
                  ["Source", state.doudianAdapter.source],
                  ["Loaded", state.doudianAdapter.loadedAt || "-"],
                  ["Last Good", state.doudianAdapter.lastGoodAt || "-"],
                  ["Last Failure", state.doudianAdapter.lastFailureReason || "none"]
                ]}
              />
            </Panel>

            <Panel title="Storage" marker={state.storageHealth}>
              <ul className="m-0 grid list-none gap-2 p-0">
                {STORAGE_KEYS.map((key) => (
                  <li className="break-words rounded-md bg-slate-100 px-2.5 py-2 font-mono" data-store-key={key} key={key}>
                    {key}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] font-semibold text-[#344054]">Doudian repository: {repositoryStatus}</p>
            </Panel>

            <Panel title="Diagnostics" marker={String(state.diagnostics.length)}>
              <ul className="m-0 grid list-none gap-2 p-0">
                {state.diagnostics.slice(0, 8).map((event) => (
                  <li className="rounded-md border border-shell-line p-2.5" key={event.time + event.message}>
                    <strong className="mr-2">{event.level}</strong>
                    <span className="text-shell-muted">{event.category}</span>
                    <p className="mt-1 leading-relaxed text-shell-muted">{event.message}</p>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Doudian Task Runner" marker={progress?.status || operation?.status || "idle"}>
              <KeyValue
                rows={[
                  ["Active", String(activeCount)],
                  ["Operation", operation?.operationId || "-"],
                  ["Task", operation?.taskType || "-"],
                  ["Status", progress?.status || operation?.status || "-"],
                  ["Progress", progress ? `${progress.progress}%` : `${operation?.progress || 0}%`],
                  ["Message", progress?.message || progress?.resultSummary || progress?.error || operation?.resultSummary || "-"]
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="h-8 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-50" type="button" disabled={progress?.status === "running"} onClick={() => void startMockTask()}>
                  Start Mock Task
                </button>
                <button className="h-8 rounded-md border border-[#dbe5f2] bg-white px-3 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={!operation || progress?.status !== "running"} onClick={() => void cancelMockTask()}>
                  Cancel
                </button>
              </div>
            </Panel>
          </div>
        </Tabs.Content>

        <Tabs.Content value="events">
          <Panel title="Recent Events" marker={String(state.diagnostics.length)}>
            <ul className="m-0 grid list-none gap-2 p-0">
              {state.diagnostics.map((event) => (
                <li className="rounded-md border border-shell-line p-2.5" key={event.time + event.category + event.message}>
                  <strong className="mr-2">{event.level}</strong>
                  <span className="text-shell-muted">{event.category}</span>
                  <p className="mt-1 leading-relaxed text-shell-muted">{event.message}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
