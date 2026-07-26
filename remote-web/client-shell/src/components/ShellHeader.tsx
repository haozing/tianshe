import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ChevronRight,
  CheckCircle2,
  Crown,
  CreditCard,
  Download,
  FileClock,
  LogOut,
  Lock,
  Mail,
  Maximize2,
  Minus,
  Loader2,
  RefreshCcw,
  Settings,
  X
} from "lucide-react";
import type { LicenseStatus } from "../bridge/license";
import type { ReleaseManifest, WorkspaceState } from "../types";
import { cn, isActiveRoute } from "../lib/utils";
import { remoteAsset } from "../lib/assets";
import { closeMainWindow, getDesktopVersionData, mainZoomSupported, minimizeMainWindow, reloadMainWindowUrl, setMainZoom, startDesktopUpdate, toggleMaximizeMainWindow } from "../bridge/client";
import { addPreferencesListener, getPreferences, hasRecentReleaseRedirect, markReleaseRedirect, releaseChannelLabel, releaseChannelToUpdateChannel, savePreferences } from "../bridge/storage";
import type { ChihuPreferences, PageScale, ReleaseChannel } from "../bridge/storage";
import { RELEASE_MANIFEST_URL, loadJson } from "../bridge/config";
import { releaseChannelFromRemoteOrigin, remoteUrlForReleaseChannel } from "../bridge/releaseChannel";
import { applyAndPersistPageScale } from "../bridge/pageScale";
import type { PageScaleChangeResult } from "../bridge/pageScale";
import type { NativeUpdateVersionData } from "../native/types";
import type { ResolvedFeatureRoute } from "../featureRoutes";

type TopRoute = {
  label: string;
  route: string;
  href: string;
  topOrder: number;
  subRoutes: ResolvedFeatureRoute[];
};

function buildTopRoutes(routes: ResolvedFeatureRoute[]): TopRoute[] {
  const groups = new Map<string, TopRoute>();
  for (const feature of routes) {
    const current = groups.get(feature.parentRoute);
    if (current) current.subRoutes.push(feature);
    else groups.set(feature.parentRoute, {
      label: feature.navigation.topLabel,
      route: feature.parentRoute,
      href: feature.route,
      topOrder: feature.navigation.topOrder,
      subRoutes: [feature]
    });
  }
  return Array.from(groups.values())
    .sort((left, right) => left.topOrder - right.topOrder)
    .map((group) => ({ ...group, subRoutes: group.subRoutes.sort((left, right) => left.navigation.order - right.navigation.order) }));
}

function activeSecondaryRoute(route: string, routes: ResolvedFeatureRoute[]) {
  const exact = routes.find((item) => route === item.route)?.route;
  if (exact) {
    return exact;
  }
  return [...routes]
    .sort((first, second) => second.route.length - first.route.length)
    .find((item) => isActiveRoute(route, item.route))?.route || routes[0]?.route || "";
}

type UpdateCheckState = "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error" | "unsupported";

interface UpdateNotesSection {
  title: string;
  items: string[];
}

interface UpdateNotesRelease {
  version: string;
  date: string;
  sections: UpdateNotesSection[];
}

interface UpdateNotesDocument {
  schemaVersion: 1;
  productName: string;
  currentVersion: string;
  updatedAt: string;
  summary: string;
  releases: UpdateNotesRelease[];
}

const UPDATE_NOTES_URL = "./config/update-notes.json";
const fallbackUpdateNotes: UpdateNotesDocument = {
  schemaVersion: 1,
  productName: "赤狐管家",
  currentVersion: "2.1.11-phase2",
  updatedAt: "2026-07-16T00:00:00+08:00",
  summary: "本次集中修复商机中心提报流程的并发、跨日统计、历史数据和批量写入问题。",
  releases: [
    {
      version: "2.1.11-phase2",
      date: "2026-07-16",
      sections: [
        {
          title: "修复",
          items: [
            "修复商机提报可能重复提交、错误未上报和跨日统计偏差的问题。",
            "修复历史提报记录退化及任务恢复状态不准确的问题。",
            "优化批量写入、缓存保留和后台轮询开销。"
          ]
        }
      ]
    }
  ]
};

function versionText(data: NativeUpdateVersionData | null | undefined, key: "current" | "latest") {
  if (!data) return "-";
  if (key === "current") return data.currentVersion || "-";
  return data.latestVersion || data.newVersion || data.currentVersion || "-";
}

function hasDesktopUpdate(data: NativeUpdateVersionData | null | undefined) {
  if (!data) return false;
  if (typeof data.hasUpdate === "boolean") return data.hasUpdate;
  if (typeof data.isNewVersion === "boolean") return !data.isNewVersion;
  const currentVersion = data.currentVersion || "";
  const latestVersion = data.latestVersion || data.newVersion || "";
  return Boolean(currentVersion && latestVersion && currentVersion !== latestVersion);
}

function isUpdateBusy(state: UpdateCheckState) {
  return state === "checking" || state === "downloading" || state === "installing";
}

function clampProgress(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function formatReleaseDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function updateStateCopy(state: UpdateCheckState, data: NativeUpdateVersionData | null) {
  if (state === "checking") return "检查中";
  if (state === "available") return `发现 ${versionText(data, "latest")}`;
  if (state === "downloading") return "下载更新中";
  if (state === "downloaded") return "下载完成";
  if (state === "installing") return "正在安装";
  if (state === "current") return "暂无版本更新";
  if (state === "unsupported") return "暂不支持检查";
  if (state === "error") return "检查失败";
  return "检查更新";
}

function UpdateNotesDialog({
  open,
  notes,
  loading,
  error,
  onOpenChange
}: {
  open: boolean;
  notes: UpdateNotesDocument;
  loading: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[min(680px,calc(100vh-44px))] w-[min(620px,calc(100vw-36px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-[#dbe5f2] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="flex items-start justify-between gap-4 border-b border-[#edf1f6] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[18px] font-semibold text-[#101828]">更新说明</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-[#667085]">
                {notes.productName} {notes.currentVersion} · {formatReleaseDate(notes.updatedAt)}
              </Dialog.Description>
            </div>
            <Dialog.Close className="grid size-8 shrink-0 place-items-center rounded-md border border-[#dbe5f2] text-[#667085] hover:bg-[#f6f8fc]" type="button" aria-label="关闭更新说明">
              <X className="size-[15px]" strokeWidth={2} />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {loading ? (
              <div className="flex min-h-[160px] items-center justify-center gap-2 text-[13px] font-medium text-[#667085]">
                <Loader2 className="size-[16px] animate-spin" strokeWidth={2.2} />
                正在读取更新说明
              </div>
            ) : (
              <div className="grid gap-4">
                {error ? (
                  <div className="flex items-start gap-2 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-3 py-2 text-[13px] leading-5 text-[#b54708]">
                    <AlertCircle className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} />
                    <span>{error}，已展示内置说明。</span>
                  </div>
                ) : null}
                <p className="m-0 rounded-md border border-[#e6ebf3] bg-[#f8fbff] px-3 py-2 text-[13px] leading-6 text-[#344054]">{notes.summary}</p>
                {notes.releases.map((release) => (
                  <section className="rounded-lg border border-[#e6ebf3] bg-white" key={`${release.version}-${release.date}`}>
                    <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-4 py-3">
                      <strong className="text-[15px] font-semibold text-[#101828]">{release.version}</strong>
                      <span className="text-[12px] font-medium text-[#667085]">{release.date}</span>
                    </div>
                    <div className="grid gap-4 px-4 py-3">
                      {release.sections.map((section) => (
                        <div key={section.title}>
                          <div className="mb-2 text-[13px] font-semibold text-brand-navy">{section.title}</div>
                          <ul className="m-0 grid gap-1.5 pl-4 text-[13px] leading-6 text-[#475467]">
                            {section.items.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function VersionCheckDialog({
  open,
  state,
  data,
  message,
  downloadProgress,
  onOpenChange,
  onRecheck,
  onInstall
}: {
  open: boolean;
  state: UpdateCheckState;
  data: NativeUpdateVersionData | null;
  message: string;
  downloadProgress: number;
  onOpenChange: (open: boolean) => void;
  onRecheck: () => void;
  onInstall: () => void;
}) {
  const busy = isUpdateBusy(state);
  const installing = state === "downloading" || state === "installing";
  const available = state === "available" || state === "downloading" || state === "downloaded" || state === "installing" || hasDesktopUpdate(data);
  const progress = Math.round(clampProgress(downloadProgress));
  const Icon = busy ? Loader2 : available ? RefreshCcw : state === "error" || state === "unsupported" ? AlertCircle : CheckCircle2;
  const toneClass = available
    ? "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]"
    : state === "error" || state === "unsupported"
      ? "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]"
      : "border-[#bff0cf] bg-[#f0fff5] text-[#087443]";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[min(460px,calc(100vw-36px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[#dbe5f2] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="mb-4 flex items-start gap-3">
            <span className={cn("grid size-10 shrink-0 place-items-center rounded-full border", toneClass)}>
              <Icon className={cn("size-5", busy ? "animate-spin" : "")} strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[17px] font-semibold text-[#101828]">检查更新</Dialog.Title>
              <Dialog.Description className="mt-2 text-[13px] leading-6 text-[#667085]">
                {message || (available ? "检测到新的桌面本体版本。" : "当前已是最新版本。")}
              </Dialog.Description>
            </div>
          </div>
          <div className="mb-4 grid gap-2 rounded-lg border border-[#e6ebf3] bg-[#f8fbff] px-3 py-2 text-[13px] text-[#344054]">
            <div className="flex items-center justify-between gap-3">
              <span>当前版本</span>
              <strong className="font-semibold text-[#101828]">{versionText(data, "current")}</strong>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>最新版本</span>
              <strong className={cn("font-semibold", available ? "text-[#1d4ed8]" : "text-[#101828]")}>{versionText(data, "latest")}</strong>
            </div>
            {data?.releaseDate ? (
              <div className="flex items-center justify-between gap-3">
                <span>发布时间</span>
                <strong className="font-semibold text-[#101828]">{formatReleaseDate(data.releaseDate)}</strong>
              </div>
            ) : null}
          </div>
          {installing ? (
            <div className="mb-4 rounded-lg border border-[#dbeafe] bg-[#eff6ff] px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-[12px] font-semibold text-[#1d4ed8]">
                <span>{state === "installing" ? "准备重启安装" : "正在下载更新包"}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white">
                <div className="h-full rounded-full bg-[#2563eb] transition-[width] duration-200" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : null}
          <div className="flex justify-end gap-3">
            <Dialog.Close className="h-9 rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#344054] hover:bg-[#f6f8fc]" type="button">
              关闭
            </Dialog.Close>
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#344054] hover:bg-[#f6f8fc] disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={busy}
              onClick={onRecheck}
            >
              {state === "checking" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <RefreshCcw className="size-[14px]" strokeWidth={2.2} />}
              重新检查
            </button>
            {available ? (
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white hover:bg-brand-foxHover disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                disabled={busy}
                onClick={onInstall}
              >
                {installing ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <Download className="size-[14px]" strokeWidth={2.2} />}
                {state === "installing" ? "正在安装" : state === "downloading" ? "下载中" : "下载并安装"}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{8}$/;
const PAGE_SCALE_OPTIONS: PageScale[] = [1, 1.1, 1.25];

function SettingsDialog({
  open,
  preferences,
  actualReleaseChannel,
  onOpenChange,
  onSaved,
  onReloadChannel,
  pageScaleSupported,
  onPageScaleChange
}: {
  open: boolean;
  preferences: ChihuPreferences;
  actualReleaseChannel: ReleaseChannel | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (preferences: ChihuPreferences) => void;
  onReloadChannel: (channel: ReleaseChannel) => Promise<"reloaded" | "same" | "unsupported" | "unavailable" | "error">;
  pageScaleSupported: boolean;
  onPageScaleChange: (scale: PageScale) => Promise<PageScaleChangeResult>;
}) {
  const [draft, setDraft] = useState<ChihuPreferences>(preferences);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pageScaleBusy, setPageScaleBusy] = useState(false);
  const displayedReleaseChannel = actualReleaseChannel || draft.releaseChannel;
  const isBeta = displayedReleaseChannel === "beta";

  useEffect(() => {
    if (!open) return;
    setDraft(preferences);
    setInviteCode("");
    setMessage("");
    setError("");
  }, [open]);

  async function changePageScale(scale: PageScale) {
    if (!pageScaleSupported || pageScaleBusy) return;
    setDraft((current) => ({ ...current, pageScale: scale }));
    setPageScaleBusy(true);
    try {
      const result = await onPageScaleChange(scale);
      setDraft((current) => ({ ...current, pageScale: result.factor }));
      if (!result.ok) setError(result.message || "页面大小设置失败");
      else setError("");
    } finally {
      setPageScaleBusy(false);
    }
  }

  function persist(patch: Partial<ChihuPreferences>) {
    const next = savePreferences(patch);
    setDraft(next);
    onSaved(next);
    return next;
  }

  async function switchReleaseChannel() {
    setError("");
    setMessage("");

    if (isBeta) {
      const next = persist({
        releaseChannel: "stable",
        autoOperationLog: draft.autoOperationLog
      });
      const reloadStatus = await onReloadChannel(next.releaseChannel);
      setMessage(reloadStatus === "reloaded" ? "正在切回正式功能版本。" : "已切回正式功能版本。");
      return;
    }

    const normalizedCode = inviteCode.trim().toUpperCase();
    if (!INVITE_CODE_PATTERN.test(normalizedCode)) {
      setError("请输入 8 位邀请码。");
      return;
    }

    const next = persist({
      releaseChannel: "beta",
      betaInviteVerifiedAt: new Date().toISOString(),
      betaInviteCodeHint: normalizedCode.slice(-4),
      autoOperationLog: draft.autoOperationLog
    });
    setInviteCode("");
    const reloadStatus = await onReloadChannel(next.releaseChannel);
    if (reloadStatus === "reloaded") {
      setMessage("正在切换到内测功能版本。");
    } else if (reloadStatus === "unavailable") {
      setMessage("已保存内测功能版本；内测远程包未发布，当前页面保持不变。");
    } else if (reloadStatus === "unsupported") {
      setMessage("已保存内测功能版本；当前运行地址不支持远程版本跳转。");
    } else {
      setMessage("已切换到内测功能版本。");
    }
  }

  function confirm() {
    persist({ autoOperationLog: draft.autoOperationLog });
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex max-h-[min(680px,calc(100vh-36px))] w-[min(632px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-[#dbe5f2] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="flex items-center justify-between gap-4 border-b border-[#edf1f6] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[18px] font-semibold text-[#101828]">设置</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-[#667085]">页面显示、版本体验和异常排查配置</Dialog.Description>
            </div>
            <Dialog.Close className="grid size-8 shrink-0 place-items-center rounded-md border border-[#dbe5f2] text-[#667085] hover:bg-[#f6f8fc]" type="button" aria-label="关闭设置">
              <X className="size-[15px]" strokeWidth={2} />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <section>
              <h3 className="m-0 text-[16px] font-semibold text-[#101828]">页面显示</h3>
              <div className="mt-4 flex items-center gap-3 max-[560px]:items-start max-[560px]:flex-col">
                <span className="text-[14px] font-medium text-[#344054]">页面大小</span>
                <div className="inline-flex rounded-md border border-[#dbe5f2] bg-[#f8fafc] p-0.5" role="group" aria-label="页面大小">
                  {PAGE_SCALE_OPTIONS.map((scale) => (
                    <button
                      className={cn(
                        "h-8 min-w-[76px] rounded px-3 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                        draft.pageScale === scale ? "bg-[#3346e8] text-white shadow-sm" : "text-[#475467] hover:bg-white"
                      )}
                      key={scale}
                      type="button"
                      disabled={!pageScaleSupported || pageScaleBusy}
                      aria-pressed={draft.pageScale === scale}
                      onClick={() => void changePageScale(scale)}
                    >
                      {scale === 1 ? "标准 100%" : scale === 1.1 ? "中 110%" : "大 125%"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="m-0 mt-2 text-[13px] leading-6 text-[#667085]">
                {pageScaleSupported ? "选择后立即生效并保存在本机，重启后继续使用当前页面大小。" : "当前客户端不支持页面缩放，升级客户端后可使用。"}
              </p>
            </section>

            <div className="my-6 h-px bg-[#edf1f6]" />

            <section>
              <h3 className="m-0 text-[16px] font-semibold text-[#101828]">内测体验</h3>
              <div className="mt-4 grid grid-cols-[48px_minmax(0,234px)_auto] items-center gap-3 max-[560px]:grid-cols-1">
                <label className="text-[14px] font-medium text-[#344054]" htmlFor="chihu-beta-invite">邀请码</label>
                <input
                  id="chihu-beta-invite"
                  className="h-9 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-3 text-[14px] text-[#101828] outline-none transition-colors placeholder:text-[#98a2b3] focus:border-[#3346e8] focus:ring-2 focus:ring-[#3346e8]/12 disabled:bg-[#f6f8fc] disabled:text-[#98a2b3]"
                  value={inviteCode}
                  maxLength={8}
                  placeholder={isBeta ? `已验证 ****${draft.betaInviteCodeHint || "****"}` : "请输入8位邀请码"}
                  disabled={isBeta}
                  onChange={(event) => {
                    setInviteCode(event.target.value.replace(/\s/g, "").slice(0, 8));
                    setError("");
                  }}
                />
                <button
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center justify-center rounded-md px-4 text-[14px] font-semibold text-white transition-colors max-[560px]:w-full",
                    isBeta ? "bg-[#475467] hover:bg-[#344054]" : "bg-[#3346e8] hover:bg-[#2738d6]"
                  )}
                  type="button"
                  onClick={() => void switchReleaseChannel()}
                >
                  {isBeta ? "切回正式" : "切换版本"}
                </button>
              </div>
              <div className="mt-3 text-[14px] leading-6 text-[#344054]">
                当前环境：<span className={cn("font-semibold", isBeta ? "text-[#c2410c]" : "text-[#087443]")}>{releaseChannelLabel(displayedReleaseChannel)}</span>
              </div>
              {message ? <div className="mt-2 text-[13px] leading-5 text-[#087443]">{message}</div> : null}
              {error ? <div className="mt-2 text-[13px] leading-5 text-[#d92d20]">{error}</div> : null}
            </section>

            <div className="my-6 h-px bg-[#edf1f6]" />

            <section>
              <h3 className="m-0 text-[16px] font-semibold text-[#101828]">异常排查</h3>
              <label className="mt-4 flex cursor-pointer items-center gap-3 text-[14px] font-medium text-[#344054]">
                <span>功能运行时自动生成操作日志</span>
                <input
                  className="peer sr-only"
                  type="checkbox"
                  role="switch"
                  checked={draft.autoOperationLog}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, autoOperationLog: event.target.checked }));
                    setMessage("");
                  }}
                />
                <span className="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-[#c7ced8] transition-colors peer-checked:bg-[#3346e8] after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4" />
              </label>
              <p className="m-0 mt-2 max-w-[560px] text-[13px] leading-6 text-[#667085]">
                店铺同步、经营/资金/违规数据、商品清理或商机提报出现异常时可启用。开启后会记录关键操作状态，便于定位问题。
              </p>
            </section>
          </div>

          <div className="flex justify-end border-t border-[#edf1f6] bg-[#fbfcff] px-4 py-3">
            <button className="h-9 rounded-md bg-[#3346e8] px-4 text-[14px] font-semibold text-white hover:bg-[#2738d6]" type="button" onClick={confirm}>
              确认
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatLicenseDate(value?: string | null) {
  if (!value) return "未开通";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatLicenseDays(seconds?: number) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "0";
  return String(Math.ceil(value / 86400));
}

function ProfileMenuV2({
  workspace,
  licenseStatus,
  onOpenLicenseDialog
}: {
  workspace: WorkspaceState;
  licenseStatus?: LicenseStatus;
  onOpenLicenseDialog?: () => void;
}) {
  const deviceNo = licenseStatus?.deviceNo || "未同步设备";
  const paid = licenseStatus?.paidAccessGranted === true;
  const userName = paid || licenseStatus?.bypass ? deviceNo : "免费版";
  const avatarText = paid || licenseStatus?.bypass ? "D" : "F";
  const authLine = licenseStatus?.verificationPending
    ? "完整版 · 授权待刷新"
    : paid
      ? licenseStatus?.isPermanent ? "永久完整版" : `完整版 · 有效期至 ${formatLicenseDate(licenseStatus?.expireAt)}`
      : "免费版";
  const remainingDays = paid ? (licenseStatus?.isPermanent ? "永久" : formatLicenseDays(licenseStatus?.remainingSeconds)) : "免费";
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<UpdateNotesDocument>(fallbackUpdateNotes);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle");
  const [versionData, setVersionData] = useState<NativeUpdateVersionData | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState<ChihuPreferences>(() => getPreferences());
  const [releaseRemoteOrigin, setReleaseRemoteOrigin] = useState("");
  const [actualReleaseChannel, setActualReleaseChannel] = useState<ReleaseChannel | null>(null);
  const [pageScaleSupported, setPageScaleSupported] = useState(() => mainZoomSupported());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const displayedReleaseChannel = actualReleaseChannel || preferences.releaseChannel;
  const updateChannel = releaseChannelToUpdateChannel(displayedReleaseChannel);

  useEffect(() => {
    const supported = mainZoomSupported();
    setPageScaleSupported(supported);
    if (!supported) return;
    const savedScale = getPreferences().pageScale;
    void setMainZoom(savedScale).then((result) => {
      if (!result.ok) return;
    }).catch(() => undefined);
  }, []);

  async function changePageScale(scale: PageScale): Promise<PageScaleChangeResult> {
    if (!pageScaleSupported) return { ok: false, factor: preferences.pageScale, message: "当前客户端不支持页面缩放" };
    const update = await applyAndPersistPageScale({
      scale,
      previousScale: preferences.pageScale,
      applyZoom: setMainZoom,
      savePreferences
    });
    if (update.preferences) setPreferences(update.preferences);
    return update.result;
  }

  async function reloadReleaseChannel(channel: ReleaseChannel): Promise<"reloaded" | "same" | "unsupported" | "unavailable" | "error"> {
    const targetUrl = remoteUrlForReleaseChannel(channel, releaseRemoteOrigin || window.location.href);
    if (!targetUrl) return "unsupported";
    if (targetUrl === window.location.href) return "same";
    try {
      markReleaseRedirect(channel, targetUrl);
      return await reloadMainWindowUrl(targetUrl) ? "reloaded" : "error";
    } catch {
      return "error";
    }
  }

  async function checkForUpdate(manual: boolean, isCancelled: boolean | (() => boolean) = false) {
    const cancelled = () => typeof isCancelled === "function" ? isCancelled() : isCancelled;
    if (isUpdateBusy(updateState)) return;
    setUpdateState("checking");
    setDownloadProgress(0);
    setUpdateMessage(manual ? "正在连接更新源，请稍候。" : "");

    try {
      const data = await getDesktopVersionData({ channel: updateChannel });
      if (cancelled()) return;
      setVersionData(data);
      if (data.status === "unavailable" || data.reason === "local_update_bridge_unavailable") {
        setUpdateState("unsupported");
        setUpdateMessage("当前运行环境不支持检查桌面本体更新。");
      } else if (data.status === "error" || data.error) {
        setUpdateState("error");
        setUpdateMessage(data.error || data.message || "检查更新失败，请稍后再试。");
      } else if (hasDesktopUpdate(data)) {
        setUpdateState("available");
        setUpdateMessage(`发现新版本 ${versionText(data, "latest")}，可以下载更新包并重启安装。`);
        setVersionDialogOpen(true);
      } else {
        setUpdateState("current");
        setUpdateMessage("当前已是最新桌面本体版本。");
      }
    } catch (error) {
      if (cancelled()) return;
      const message = error instanceof Error ? error.message : String(error);
      setVersionData({
        ok: false,
        status: "error",
        hasUpdate: false,
        isNewVersion: true,
        currentVersion: versionData?.currentVersion || "",
        latestVersion: versionData?.latestVersion || versionData?.newVersion || "",
        newVersion: versionData?.newVersion || "",
        error: message
      });
      setUpdateState("error");
      setUpdateMessage(message);
    } finally {
      if (manual && !cancelled()) setVersionDialogOpen(true);
    }
  }

  async function installUpdate() {
    if (isUpdateBusy(updateState)) return;
    setVersionDialogOpen(true);
    setUpdateState("downloading");
    setDownloadProgress(0);
    setUpdateMessage("正在准备下载更新包，请不要关闭应用。");

    try {
      const result = await startDesktopUpdate({ autoDownload: true, quitAndInstall: true, channel: updateChannel }) as { ok?: boolean; skipped?: boolean; reason?: string; message?: string };
      if (result?.skipped) {
        setUpdateMessage("已有更新任务正在进行，请稍候。");
        return;
      }
      if (!result?.ok) {
        setUpdateState("error");
        setUpdateMessage(result?.message || result?.reason || "启动更新安装失败，请稍后再试。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateState("error");
      setUpdateMessage(message);
    }
  }

  useEffect(() => {
    return addPreferencesListener(setPreferences);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadJson<ReleaseManifest>(RELEASE_MANIFEST_URL).then((manifest) => {
      if (cancelled) return;
      const remoteOrigin = manifest.entry?.remoteWebOrigin || "";
      const actualChannel = releaseChannelFromRemoteOrigin(remoteOrigin);
      setReleaseRemoteOrigin(remoteOrigin);
      setActualReleaseChannel(actualChannel);
      if (!actualChannel) return;
      const current = getPreferences();
      if (current.releaseChannel === actualChannel) return;
      setPreferences(savePreferences({ releaseChannel: actualChannel }));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!profileMenuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const root = profileMenuRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setProfileMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    async function alignRemoteEntry() {
      const targetUrl = remoteUrlForReleaseChannel(preferences.releaseChannel, releaseRemoteOrigin || window.location.href);
      if (!targetUrl || targetUrl === window.location.href) return;
      if (hasRecentReleaseRedirect(preferences.releaseChannel, targetUrl)) return;
      if (cancelled) return;
      markReleaseRedirect(preferences.releaseChannel, targetUrl);
      await reloadMainWindowUrl(targetUrl).catch(() => undefined);
    }
    void alignRemoteEntry();
    return () => {
      cancelled = true;
    };
  }, [preferences.releaseChannel, releaseRemoteOrigin]);

  useEffect(() => {
    const onUpdateAvailable = (event: Event) => {
      const detail = ((event as CustomEvent<Partial<NativeUpdateVersionData> & { version?: string }>).detail || {});
      const latestVersion = detail.latestVersion || detail.newVersion || detail.version || "";
      setVersionData((current) => ({
        ok: true,
        status: "available",
        hasUpdate: true,
        isNewVersion: false,
        currentVersion: current?.currentVersion || "",
        latestVersion: latestVersion || current?.latestVersion || current?.newVersion || "",
        newVersion: latestVersion || current?.newVersion || current?.latestVersion || "",
        releaseDate: detail.releaseDate || current?.releaseDate || "",
        releaseName: detail.releaseName || current?.releaseName || "",
        releaseNotes: detail.releaseNotes || current?.releaseNotes || ""
      }));
      setUpdateState((current) => current === "downloading" || current === "installing" ? current : "available");
      setUpdateMessage(latestVersion ? `发现新版本 ${latestVersion}，正在准备下载更新包。` : "发现新版本，正在准备下载更新包。");
    };

    const onDownloadProgress = (event: Event) => {
      const detail = (event as CustomEvent<number | { percent?: number }>).detail;
      const percent = clampProgress(typeof detail === "number" ? detail : detail?.percent);
      setDownloadProgress(percent);
      setUpdateState("downloading");
      setUpdateMessage(`正在下载更新包 ${Math.round(percent)}%，下载完成后会自动重启安装。`);
    };

    const onUpdateDownloaded = () => {
      setDownloadProgress(100);
      setUpdateState("installing");
      setUpdateMessage("更新包下载完成，正在重启安装。");
    };

    const onUpdateNotAvailable = () => {
      setDownloadProgress(0);
      setUpdateState("current");
      setUpdateMessage("当前已是最新桌面本体版本。");
    };

    const onUpdateError = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const message = typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message?: unknown }).message || "")
          : "更新安装失败，请稍后再试。";
      setUpdateState("error");
      setUpdateMessage(message || "更新安装失败，请稍后再试。");
    };

    window.addEventListener("chihu:update-available", onUpdateAvailable);
    window.addEventListener("chihu:download-progress", onDownloadProgress);
    window.addEventListener("chihu:update-downloaded", onUpdateDownloaded);
    window.addEventListener("chihu:update-not-available", onUpdateNotAvailable);
    window.addEventListener("chihu:update-error", onUpdateError);

    return () => {
      window.removeEventListener("chihu:update-available", onUpdateAvailable);
      window.removeEventListener("chihu:download-progress", onDownloadProgress);
      window.removeEventListener("chihu:update-downloaded", onUpdateDownloaded);
      window.removeEventListener("chihu:update-not-available", onUpdateNotAvailable);
      window.removeEventListener("chihu:update-error", onUpdateError);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkForUpdate(false, () => cancelled);
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!notesOpen || notes !== fallbackUpdateNotes) return;
    let cancelled = false;

    async function loadNotes() {
      setNotesLoading(true);
      setNotesError("");
      try {
        const response = await fetch(UPDATE_NOTES_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as UpdateNotesDocument;
        if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.releases)) {
          throw new Error("更新说明格式不正确");
        }
        if (!cancelled) setNotes(payload);
      } catch (error) {
        if (!cancelled) {
          setNotes(fallbackUpdateNotes);
          setNotesError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    }

    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [notesOpen, notes]);

  const versionSuffix = useMemo(() => (
    <span className={cn(
      "ml-auto inline-flex items-center gap-1 text-[12px]",
      updateState === "available" || updateState === "downloading" || updateState === "downloaded" || updateState === "installing" ? "font-semibold text-[#1d4ed8]" :
        updateState === "error" || updateState === "unsupported" ? "text-[#b54708]" :
          "text-[#98a2b3]"
    )}>
      {isUpdateBusy(updateState) ? <Loader2 className="size-[12px] animate-spin" strokeWidth={2.2} /> : null}
      {updateState === "downloading" ? `下载 ${Math.round(clampProgress(downloadProgress))}%` : updateStateCopy(updateState, versionData)}
    </span>
  ), [downloadProgress, updateState, versionData]);

  const menuItems = [
    { key: "license", label: paid ? "卡密续费" : "开通完整版", Icon: CreditCard, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} />, onClick: () => {
      setProfileMenuOpen(false);
      onOpenLicenseDialog?.();
    } },
    { key: "logs", label: "授权记录", Icon: FileClock, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} />, disabled: true },
    { key: "notes", label: "更新说明", Icon: Mail, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} />, onClick: () => {
      setProfileMenuOpen(false);
      setNotesOpen(true);
    } },
    { key: "update", label: "检查更新", Icon: RefreshCcw, suffix: versionSuffix, onClick: () => {
      setProfileMenuOpen(false);
      void checkForUpdate(true);
    }, disabled: isUpdateBusy(updateState) }
  ];

  return (
    <>
      <div className="relative" ref={profileMenuRef}>
        <button
          className={cn("inline-flex h-8 items-center gap-2 rounded-md px-2 font-medium text-[#101828] transition-colors", profileMenuOpen ? "bg-[#eef3ff]" : "hover:bg-[#f6f8fc]")}
          type="button"
          aria-haspopup="menu"
          aria-expanded={profileMenuOpen}
          onClick={() => setProfileMenuOpen((open) => !open)}
        >
          <span className="grid size-5 place-items-center rounded-full bg-brand-navy text-[12px] font-bold text-white">{avatarText}</span>
          <span className="max-w-[138px] truncate">{userName}</span>
        </button>

        <div
          className={cn(
            "absolute right-0 top-[30px] z-50 w-[250px] transition duration-150",
            profileMenuOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
          )}
        >
          <div className="mt-2 overflow-hidden rounded-md border border-[#e4eaf3] bg-white text-[#344054] shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
            <div className="px-5 pb-3 pt-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-[#3d43e9] text-[17px] font-semibold text-white">{avatarText}</span>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold leading-5 text-[#1d2939]">{userName}</div>
                  <div className="mt-1 truncate text-[12px] text-[#98a2b3]">授权： {authLine}</div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-center">
                <div className="min-w-[92px] text-center">
                  <div className="text-[19px] font-bold leading-6 text-[#3346e8]">{remainingDays}</div>
                  <div className="mt-1 text-[12px] text-[#344054]">剩余天数</div>
                </div>
              </div>
            </div>

            <div className="px-3 pb-2">
              {menuItems.map((item, index) => {
                const Icon = item.Icon;
                return (
                  <div key={item.key}>
                    {index === 2 ? <div className="my-1 h-px bg-[#edf1f6]" /> : null}
                    <button
                      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-[#475467] transition-colors hover:bg-[#f6f8fc] hover:text-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      disabled={item.disabled}
                      onClick={item.onClick}
                    >
                      <Icon className={cn("size-[16px] shrink-0 text-[#52627a]", item.key === "update" && isUpdateBusy(updateState) ? "animate-spin" : "")} strokeWidth={1.9} />
                      <span>{item.label}</span>
                      <span className="ml-auto inline-flex items-center">{item.suffix}</span>
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="grid h-11 grid-cols-[1fr_1px_1fr] items-center border-t border-[#edf1f6]">
              <button
                className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#3346e8] transition-colors hover:bg-[#f6f8fc]"
                type="button"
                onClick={() => {
                  setProfileMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <Settings className="size-[15px]" strokeWidth={1.9} />
                <span>设置</span>
              </button>
              <span className="h-4 bg-[#d8dee8]" />
              <button
                className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#3346e8] transition-colors hover:bg-[#f6f8fc]"
                type="button"
                onClick={() => {
                  setProfileMenuOpen(false);
                  onOpenLicenseDialog?.();
                }}
              >
                <CreditCard className="size-[15px]" strokeWidth={1.9} />
                <span>设备续费</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <UpdateNotesDialog
        open={notesOpen}
        notes={notes}
        loading={notesLoading}
        error={notesError}
        onOpenChange={setNotesOpen}
      />
      <VersionCheckDialog
        open={versionDialogOpen}
        state={updateState}
        data={versionData}
        message={updateMessage}
        downloadProgress={downloadProgress}
        onOpenChange={setVersionDialogOpen}
        onRecheck={() => void checkForUpdate(true)}
        onInstall={() => void installUpdate()}
      />
      <SettingsDialog
        open={settingsOpen}
        preferences={preferences}
        actualReleaseChannel={actualReleaseChannel}
        onOpenChange={setSettingsOpen}
        onSaved={setPreferences}
        onReloadChannel={reloadReleaseChannel}
        pageScaleSupported={pageScaleSupported}
        onPageScaleChange={changePageScale}
      />
    </>
  );
}

export function ShellHeader({
  route,
  routes,
  workspace,
  licenseStatus,
  onOpenLicenseDialog
}: {
  route: string;
  routes: ResolvedFeatureRoute[];
  workspace: WorkspaceState;
  licenseStatus?: LicenseStatus;
  onOpenLicenseDialog?: () => void;
}) {
  const topRoutes = useMemo(() => buildTopRoutes(routes), [routes]);
  const activeTopRoute = topRoutes.find((item) => isActiveRoute(route, item.route)) || topRoutes[0];
  const secondaryRoutes = activeTopRoute?.subRoutes || [];
  const subActive = activeSecondaryRoute(route, secondaryRoutes);

  return (
    <header className="app-drag-region relative z-[45] grid grid-cols-[214px_minmax(0,1fr)] overflow-visible border-b border-brand-line bg-[#fbfcff]/95 shadow-[0_10px_28px_rgba(15,23,42,0.045)] backdrop-blur max-[860px]:grid-cols-1">
      <aside className="row-span-2 flex min-h-[84px] items-center gap-3 border-r border-[#e6ebf3] px-5 max-[860px]:row-span-1 max-[860px]:min-h-[60px] max-[860px]:border-r-0 max-[860px]:border-b">
        <img
          alt="赤狐管家"
          className="h-12 w-[172px] object-contain object-left"
          src={remoteAsset("assets/chihu-logo-horizontal.png")}
        />
      </aside>

      <section className="flex min-h-[46px] min-w-0 items-center border-b border-[#edf1f6]">
        <nav className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-5" aria-label="主路由">
          {topRoutes.map((item) => {
            const active = activeTopRoute.route === item.route;
            const locked = item.subRoutes.some((feature) => feature.accessTier === "paid") && licenseStatus?.paidAccessGranted !== true;
            return (
              <a
                className={cn(
                  "app-no-drag relative inline-flex min-h-[46px] shrink-0 items-center gap-1 px-4 pt-3 text-[15px] font-semibold no-underline transition-colors hover:text-brand-navy",
                  active ? "text-brand-navy" : "text-[#111827]"
                )}
                href={"#" + item.href}
                key={item.label}
              >
                <span>{item.label}</span>
                {locked ? <Lock className="size-[13px] shrink-0 text-[#98a2b3]" strokeWidth={2} aria-label="需开通完整版" /> : null}
                {active ? <span className="absolute inset-x-4 bottom-0 h-[2px] rounded-full bg-brand-fox" /> : null}
              </a>
            );
          })}
        </nav>

        <div className="app-no-drag flex shrink-0 items-center gap-2.5 px-4 text-[13px] text-[#475467] max-[860px]:gap-1 max-[860px]:px-2">
          <div className="contents max-[860px]:hidden">
            <ProfileMenuV2 workspace={workspace} licenseStatus={licenseStatus} onOpenLicenseDialog={onOpenLicenseDialog} />
            <button className="inline-flex h-7 items-center gap-1.5 px-2 text-[12px] font-bold text-[#a45b00] transition-colors hover:text-[#8a4b00]" type="button" onClick={onOpenLicenseDialog}>
              <Crown className="size-[14px]" strokeWidth={2} />
              <span>{licenseStatus?.paidAccessGranted === true ? "卡密续费" : "开通完整版"}</span>
            </button>
            <span className="h-5 w-px bg-[#e5ebf2]" />
          </div>
          <button className="grid size-7 place-items-center rounded-md text-[#667085] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="最小化" onClick={() => void minimizeMainWindow()}>
            <Minus className="size-[15px]" strokeWidth={2} />
          </button>
          <button className="grid size-7 place-items-center rounded-md text-[#667085] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="最大化" onClick={() => void toggleMaximizeMainWindow()}>
            <Maximize2 className="size-[15px]" strokeWidth={2} />
          </button>
          <button className="grid size-7 place-items-center rounded-md text-[#667085] transition-colors hover:bg-[#fff1f0] hover:text-[#d92d20]" type="button" aria-label="关闭" onClick={() => void closeMainWindow()}>
            <X className="size-[15px]" strokeWidth={2} />
          </button>
        </div>
      </section>

      <section className="flex min-h-[38px] min-w-0 items-center">
        <nav className="scrollbar-none flex min-w-0 flex-1 items-center gap-3 overflow-x-auto px-5" aria-label="子路由">
          {secondaryRoutes.map((item) => {
            const active = subActive === item.route;
            const Icon = item.navigation.icon;
            const locked = item.accessTier === "paid" && licenseStatus?.paidAccessGranted !== true;
            return (
              <a
                className={cn(
                  "app-no-drag inline-flex h-6 shrink-0 items-center gap-1.5 px-2 text-[13px] font-medium no-underline transition-colors hover:text-brand-navy",
                  active ? "text-brand-navy" : "text-[#475467]"
                )}
                href={"#" + item.route}
                key={item.navigation.label}
              >
                <Icon className="size-[16px]" strokeWidth={2} />
                <span>{item.navigation.label}</span>
                {locked ? <Lock className="size-[12px] shrink-0 text-[#98a2b3]" strokeWidth={2} aria-label="需开通完整版" /> : null}
              </a>
            );
          })}
        </nav>

      </section>
    </header>
  );
}
