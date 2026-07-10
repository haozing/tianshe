import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  BarChart3,
  Building2,
  ChevronRight,
  CheckCircle2,
  CircleDollarSign,
  Crown,
  CreditCard,
  Download,
  FileClock,
  LogOut,
  Mail,
  Maximize2,
  Megaphone,
  Minus,
  Loader2,
  RefreshCcw,
  Settings,
  ShieldAlert,
  ShoppingBag,
  Target,
  Trash2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkspaceState } from "../types";
import { cn, isActiveRoute } from "../lib/utils";
import { remoteAsset } from "../lib/assets";
import { closeMainWindow, getDesktopVersionData, minimizeMainWindow, startDesktopUpdate, toggleMaximizeMainWindow } from "../bridge/client";
import type { NativeUpdateVersionData } from "../native/types";

type SecondaryRoute = {
  label: string;
  route: string;
  Icon: LucideIcon;
};

type TopRoute = {
  label: string;
  route: string;
  href: string;
  subRoutes: SecondaryRoute[];
};

const storeSubRoutes: SecondaryRoute[] = [
  { label: "店铺管理", route: "/stores", Icon: Building2 },
  { label: "经营数据", route: "/stores/business-data", Icon: BarChart3 },
  { label: "资金数据", route: "/stores/funds", Icon: CircleDollarSign }
];

const warningSubRoutes: SecondaryRoute[] = [
  { label: "违规管理", route: "/warnings", Icon: ShieldAlert }
];

const opportunitySubRoutes: SecondaryRoute[] = [
  { label: "商机提报", route: "/opportunities", Icon: Megaphone },
  { label: "商品预匹配提报", route: "/opportunities/product-prematch", Icon: Target }
];

const productSubRoutes: SecondaryRoute[] = [
  { label: "清理滞销", route: "/products/slow-moving", Icon: ShoppingBag },
  { label: "批量删除", route: "/products/bulk-delete", Icon: Trash2 }
];

const topRoutes: TopRoute[] = [
  { label: "店铺管理", route: "/stores", href: "/stores", subRoutes: storeSubRoutes },
  { label: "预警/违规", route: "/warnings", href: "/warnings", subRoutes: warningSubRoutes },
  { label: "商机中心", route: "/opportunities", href: "/opportunities", subRoutes: opportunitySubRoutes },
  { label: "商品管理", route: "/products", href: "/products/slow-moving", subRoutes: productSubRoutes }
];

function activeSecondaryRoute(route: string, routes: SecondaryRoute[]) {
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
  currentVersion: "2.1.7-phase2",
  updatedAt: "2026-07-10T00:00:00+08:00",
  summary: "本次补齐更新说明、检查更新、启动静默检测和手动下载安装能力。",
  releases: [
    {
      version: "2.1.7-phase2",
      date: "2026-07-10",
      sections: [
        {
          title: "新增",
          items: [
            "新增更新说明弹窗。",
            "新增桌面本体版本检查。",
            "启动后静默检测一次本体版本，检测到更新后可手动下载并安装。"
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

function ProfileMenu({ workspace }: { workspace: WorkspaceState }) {
  const userName = workspace.operator || "hhhhh123";
  const avatarText = userName.trim().slice(0, 1).toLowerCase() || "h";
  const phone = workspace.phone || "18906311658";
  const points = workspace.points || "0.1";

  const menuItems = [
    { label: "卡密兑换", Icon: CreditCard, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} /> },
    { label: "消耗日志", Icon: FileClock, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} /> },
    { label: "更新说明", Icon: Mail, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} /> },
    { label: "检查更新", Icon: RefreshCcw, suffix: <span className="ml-auto text-[12px] text-[#98a2b3]">暂无版本更新</span> }
  ];

  return (
    <div className="group relative">
      <button className="inline-flex h-8 items-center gap-2 px-2 font-medium text-[#101828]" type="button">
        <span className="grid size-5 place-items-center rounded-full bg-brand-navy text-[12px] font-bold text-white">{avatarText}</span>
        <span>{userName}</span>
      </button>

      <div className="pointer-events-none absolute right-0 top-[30px] z-50 w-[250px] translate-y-1 opacity-0 transition duration-150 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
        <div className="mt-2 overflow-hidden rounded-md border border-[#e4eaf3] bg-white text-[#344054] shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
          <div className="px-5 pb-3 pt-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-[#3d43e9] text-[17px] font-semibold text-white">{avatarText}</span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold leading-5 text-[#1d2939]">{userName}</div>
                <div className="mt-1 truncate text-[12px] text-[#98a2b3]">手机号： {phone}</div>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-center">
              <div className="min-w-[92px] text-center">
                <div className="text-[19px] font-bold leading-6 text-[#3346e8]">{points}</div>
                <div className="mt-1 text-[12px] text-[#344054]">积分</div>
              </div>
            </div>
          </div>

          <div className="px-3 pb-2">
            {menuItems.map((item, index) => {
              const Icon = item.Icon;
              return (
                <div key={item.label}>
                  {index === 2 ? <div className="my-1 h-px bg-[#edf1f6]" /> : null}
                  <button className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-[#475467] transition-colors hover:bg-[#f6f8fc] hover:text-brand-navy" type="button">
                    <Icon className="size-[16px] shrink-0 text-[#52627a]" strokeWidth={1.9} />
                    <span>{item.label}</span>
                    <span className="ml-auto inline-flex items-center">{item.suffix}</span>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="grid h-11 grid-cols-[1fr_1px_1fr] items-center border-t border-[#edf1f6]">
            <button className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#3346e8] transition-colors hover:bg-[#f6f8fc]" type="button">
              <Settings className="size-[15px]" strokeWidth={1.9} />
              <span>设置</span>
            </button>
            <span className="h-4 bg-[#d8dee8]" />
            <button className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#f04438] transition-colors hover:bg-[#fff1f0]" type="button">
              <LogOut className="size-[15px]" strokeWidth={1.9} />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileMenuV2({ workspace }: { workspace: WorkspaceState }) {
  const userName = workspace.operator || "hhhhh123";
  const avatarText = userName.trim().slice(0, 1).toLowerCase() || "h";
  const phone = workspace.phone || "18906311658";
  const points = workspace.points || "0.1";
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<UpdateNotesDocument>(fallbackUpdateNotes);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle");
  const [versionData, setVersionData] = useState<NativeUpdateVersionData | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState(0);

  async function checkForUpdate(manual: boolean, isCancelled: boolean | (() => boolean) = false) {
    const cancelled = () => typeof isCancelled === "function" ? isCancelled() : isCancelled;
    if (isUpdateBusy(updateState)) return;
    setUpdateState("checking");
    setDownloadProgress(0);
    setUpdateMessage(manual ? "正在连接更新源，请稍候。" : "");

    try {
      const data = await getDesktopVersionData();
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
      const result = await startDesktopUpdate({ autoDownload: true, quitAndInstall: true }) as { ok?: boolean; skipped?: boolean; reason?: string; message?: string };
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
    { key: "license", label: "卡密兑换", Icon: CreditCard, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} /> },
    { key: "logs", label: "消费日志", Icon: FileClock, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} /> },
    { key: "notes", label: "更新说明", Icon: Mail, suffix: <ChevronRight className="size-[15px] text-[#b7c0cd]" strokeWidth={1.8} />, onClick: () => setNotesOpen(true) },
    { key: "update", label: "检查更新", Icon: RefreshCcw, suffix: versionSuffix, onClick: () => void checkForUpdate(true), disabled: isUpdateBusy(updateState) }
  ];

  return (
    <>
      <div className="group relative">
        <button className="inline-flex h-8 items-center gap-2 px-2 font-medium text-[#101828]" type="button">
          <span className="grid size-5 place-items-center rounded-full bg-brand-navy text-[12px] font-bold text-white">{avatarText}</span>
          <span>{userName}</span>
        </button>

        <div className="pointer-events-none absolute right-0 top-[30px] z-50 w-[250px] translate-y-1 opacity-0 transition duration-150 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
          <div className="mt-2 overflow-hidden rounded-md border border-[#e4eaf3] bg-white text-[#344054] shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
            <div className="px-5 pb-3 pt-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-[#3d43e9] text-[17px] font-semibold text-white">{avatarText}</span>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold leading-5 text-[#1d2939]">{userName}</div>
                  <div className="mt-1 truncate text-[12px] text-[#98a2b3]">手机号： {phone}</div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-center">
                <div className="min-w-[92px] text-center">
                  <div className="text-[19px] font-bold leading-6 text-[#3346e8]">{points}</div>
                  <div className="mt-1 text-[12px] text-[#344054]">积分</div>
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
              <button className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#3346e8] transition-colors hover:bg-[#f6f8fc]" type="button">
                <Settings className="size-[15px]" strokeWidth={1.9} />
                <span>设置</span>
              </button>
              <span className="h-4 bg-[#d8dee8]" />
              <button className="inline-flex h-full items-center justify-center gap-1.5 text-[13px] font-medium text-[#f04438] transition-colors hover:bg-[#fff1f0]" type="button">
                <LogOut className="size-[15px]" strokeWidth={1.9} />
                <span>退出登录</span>
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
    </>
  );
}

export function ShellHeader({ route, workspace }: { route: string; workspace: WorkspaceState }) {
  const activeTopRoute = topRoutes.find((item) => isActiveRoute(route, item.route)) || topRoutes[0];
  const secondaryRoutes = activeTopRoute.subRoutes;
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
                {active ? <span className="absolute inset-x-4 bottom-0 h-[2px] rounded-full bg-brand-fox" /> : null}
              </a>
            );
          })}
        </nav>

        <div className="app-no-drag flex shrink-0 items-center gap-2.5 px-4 text-[13px] text-[#475467]">
          <ProfileMenuV2 workspace={workspace} />
          <button className="inline-flex h-7 items-center gap-1.5 px-2 text-[12px] font-bold text-[#a45b00] transition-colors hover:text-[#8a4b00]" type="button">
            <Crown className="size-[14px]" strokeWidth={2} />
            <span>点击购买</span>
          </button>
          <span className="h-5 w-px bg-[#e5ebf2]" />
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
            const Icon = item.Icon;
            return (
              <a
                className={cn(
                  "app-no-drag inline-flex h-6 shrink-0 items-center gap-1.5 px-2 text-[13px] font-medium no-underline transition-colors hover:text-brand-navy",
                  active ? "text-brand-navy" : "text-[#475467]"
                )}
                href={"#" + item.route}
                key={item.label}
              >
                <Icon className="size-[16px]" strokeWidth={2} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

      </section>
    </header>
  );
}
