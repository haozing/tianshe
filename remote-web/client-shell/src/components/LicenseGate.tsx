import { useEffect, useMemo, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  Loader2,
  MonitorSmartphone,
  RefreshCcw,
  ShieldCheck,
  X
} from "lucide-react";
import { startDesktopUpdate } from "../bridge/client";
import type { LicenseStatus } from "../bridge/license";
import { cn } from "../lib/utils";
import { remoteAsset } from "../lib/assets";

const DESKTOP_SETUP_DOWNLOAD_URL = "http://chihu.facaishe.cn/desktop/win/chihu-guanjia-2.2.0-freemium-v2-setup.exe";
const DESKTOP_SETUP_FILE_NAME = "chihu-guanjia-2.2.0-freemium-v2-setup.exe";

type ClientUpdatePhase = "idle" | "checking" | "downloading" | "downloaded" | "error";

function isClientUpdateRequired(status: LicenseStatus) {
  return status.reason === "LICENSE_BRIDGE_UNAVAILABLE";
}

function clampPercent(value: number | null) {
  if (value == null) return null;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function updateProgressFromDetail(detail: unknown) {
  if (typeof detail === "number") return detail;
  if (detail && typeof detail === "object" && "percent" in detail) {
    return Number((detail as { percent?: unknown }).percent);
  }
  return 0;
}

function openSetupDownloadLink() {
  const link = document.createElement("a");
  link.href = DESKTOP_SETUP_DOWNLOAD_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function downloadClientInstaller(onProgress: (percent: number | null) => void) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", DESKTOP_SETUP_DOWNLOAD_URL, true);
    xhr.responseType = "blob";
    xhr.onprogress = (event) => {
      if (!event.lengthComputable || !event.total) {
        onProgress(null);
        return;
      }
      onProgress((event.loaded / event.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        rejectPromise(new Error(`HTTP ${xhr.status}`));
        return;
      }
      const blob = xhr.response as Blob;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = DESKTOP_SETUP_FILE_NAME;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      resolvePromise();
    };
    xhr.onerror = () => rejectPromise(new Error("download failed"));
    xhr.send();
  });
}

function formatExpireAt(value?: string | null) {
  if (!value) return "未开通";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRemaining(seconds?: number) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 天";
  const days = Math.ceil(value / 86400);
  return `${days} 天`;
}

function statusCopy(status: LicenseStatus) {
  if (status.bypass) return "开发授权已开启";
  if (status.verificationPending) return "完整版授权待刷新";
  if (status.status === "pending") return "正在检查授权";
  if (isClientUpdateRequired(status)) return "客户端需要更新";
  if (!status.configured) return "授权服务暂不可用";
  if (status.licensed) return "设备授权有效";
  if (status.authStatus === "expired" || status.status === "expired") return "授权已到期";
  if (status.status === "redeem_error") return "卡密兑换失败";
  if (status.status === "error") return "授权校验失败";
  return "授权未开通";
}

function detailCopy(status: LicenseStatus) {
  if (status.verificationPending) return "卡密已兑换成功，正在刷新设备授权状态。当前进程可继续使用完整版。";
  if (status.status === "pending") return "正在联网检查当前设备的完整版授权。免费功能可直接使用。";
  if (isClientUpdateRequired(status)) return "当前客户端版本过低，请更新后继续使用。";
  if (!status.configured) return "授权服务暂时无法连接，请稍后重试或联系客服。";
  if (status.licensed) return status.isPermanent ? "当前设备为永久授权。" : `授权到期：${formatExpireAt(status.expireAt)}`;
  return status.message || "请输入一张未使用过的卡密，为当前设备开通或续费 30 天。";
}

export function PaidFeatureGate({
  status,
  checking,
  redeeming,
  message,
  onRedeem,
  onRefresh
}: {
  status: LicenseStatus;
  checking: boolean;
  redeeming: boolean;
  message: string;
  onRedeem: (cardKey: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className="grid min-h-full place-items-center overflow-auto p-4">
      <div className="w-[min(700px,100%)] rounded-lg border border-[#dbe5f2] bg-white shadow-[0_16px_44px_rgba(15,23,42,0.08)]">
        <div className="border-b border-[#edf1f6] px-6 py-5 max-[640px]:px-4">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-[#ffdca8] bg-[#fff7e8] text-[#b54708]">
              <CreditCard className="size-5" strokeWidth={2.1} />
            </span>
            <div className="min-w-0">
              <h1 className="m-0 text-[21px] font-semibold text-[#101828]">开通完整版</h1>
              <p className="m-0 mt-2 text-[13px] leading-6 text-[#667085]">
                当前页面需要有效的设备授权。
              </p>
            </div>
          </div>
          <div className="mt-4">
            <LicenseFacts status={status} />
          </div>
        </div>
        <div className="px-6 py-5 max-[640px]:px-4">
          <div className="mb-3 text-[13px] font-medium text-[#475467]">{statusCopy(status)}</div>
          <LicenseRedeemForm
            status={status}
            busy={redeeming}
            checking={checking}
            message={message}
            onRedeem={onRedeem}
            onRefresh={onRefresh}
          />
          {status.contact ? <p className="m-0 mt-4 text-[12px] leading-5 text-[#667085]">客服：{status.contact}</p> : null}
        </div>
      </div>
    </section>
  );
}

function LicenseFacts({ status }: { status: LicenseStatus }) {
  const facts = isClientUpdateRequired(status) ? [
    { label: "当前状态", value: "需要更新", Icon: Download },
    { label: "授权检查", value: "更新后自动检测", Icon: ShieldCheck },
    { label: "后续操作", value: "安装新版客户端", Icon: MonitorSmartphone }
  ] : [
    { label: "设备编号", value: status.deviceNo || "同步中", Icon: MonitorSmartphone },
    { label: "授权到期", value: status.isPermanent ? "永久" : formatExpireAt(status.expireAt), Icon: Clock3 },
    { label: "剩余时间", value: status.isPermanent ? "永久" : formatRemaining(status.remainingSeconds), Icon: ShieldCheck }
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {facts.map((item) => {
        const Icon = item.Icon;
        return (
          <div className="rounded-lg border border-[#e5ebf2] bg-[#fbfcff] px-3 py-3" key={item.label}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[#667085]">
              <Icon className="size-[14px]" strokeWidth={2} />
              <span>{item.label}</span>
            </div>
            <div className="min-w-0 truncate text-[14px] font-semibold text-[#101828]">{item.value}</div>
          </div>
        );
      })}
    </div>
  );
}

function UpdateProgressBar({ phase, progress }: { phase: ClientUpdatePhase; progress: number | null }) {
  if (phase === "idle") return null;
  const percent = clampPercent(progress);
  const indeterminate = phase === "downloading" && percent == null;
  const label = phase === "checking"
    ? "正在检查新版客户端"
    : phase === "downloading"
      ? percent == null ? "正在下载新版客户端" : `正在下载新版客户端 ${Math.round(percent)}%`
      : phase === "downloaded"
        ? "下载完成"
        : "下载未完成";

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-[12px] font-medium text-[#344054]">
        <span>{label}</span>
        {percent != null && phase === "downloading" ? <span>{Math.round(percent)}%</span> : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#e6eefc]">
        <div
          className={cn(
            "h-full rounded-full bg-[#1d4ed8] transition-[width] duration-200",
            indeterminate ? "w-full animate-pulse" : ""
          )}
          style={indeterminate ? undefined : { width: `${phase === "downloaded" ? 100 : percent || 0}%` }}
        />
      </div>
    </div>
  );
}

function LicenseRedeemForm({
  status,
  busy,
  checking,
  message,
  onRedeem,
  onRefresh
}: {
  status: LicenseStatus;
  busy: boolean;
  checking: boolean;
  message: string;
  onRedeem: (cardKey: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [cardKey, setCardKey] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<ClientUpdatePhase>("idle");
  const [updateProgress, setUpdateProgress] = useState<number | null>(0);
  const [updateMessage, setUpdateMessage] = useState("");
  const needsClientUpdate = isClientUpdateRequired(status);
  const updateBusy = updating || updatePhase === "checking" || updatePhase === "downloading";
  const canSubmit = cardKey.trim().length > 0 && !busy && status.configured && !needsClientUpdate;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    await onRedeem(cardKey);
    setCardKey("");
  }

  async function downloadWithProgress(fallbackMessage?: string) {
    setUpdating(true);
    setUpdatePhase("downloading");
    setUpdateProgress(0);
    setUpdateMessage(fallbackMessage || "正在下载新版客户端，请保持当前页面打开。");
    try {
      await downloadClientInstaller(setUpdateProgress);
      setUpdateProgress(100);
      setUpdatePhase("downloaded");
      setUpdateMessage("安装包已下载，请运行安装包，安装完成后重新打开赤狐管家。");
    } catch {
      openSetupDownloadLink();
      setUpdatePhase("error");
      setUpdateProgress(0);
      setUpdateMessage("无法显示下载进度，已打开安装包下载链接。安装完成后重新打开赤狐管家。");
    } finally {
      setUpdating(false);
    }
  }

  async function updateClient() {
    if (updateBusy) return;
    setUpdating(true);
    setUpdatePhase("checking");
    setUpdateProgress(0);
    setUpdateMessage("正在检查新版客户端...");
    try {
      const result = await startDesktopUpdate({ autoDownload: true, quitAndInstall: true, channel: "latest" }) as { ok?: boolean; skipped?: boolean; reason?: string; message?: string };
      if (result?.ok || result?.skipped) {
        setUpdatePhase("downloading");
        setUpdateMessage(result?.skipped ? "已有更新任务正在进行，请稍候。" : "正在下载新版客户端，请不要关闭赤狐管家。");
        return;
      }
      await downloadWithProgress("正在下载新版安装包。");
    } catch {
      await downloadWithProgress("自动更新不可用，正在下载新版安装包。");
    } finally {
      setUpdating(false);
    }
  }

  useEffect(() => {
    if (!needsClientUpdate) return;

    const onProgress = (event: Event) => {
      const percent = clampPercent(updateProgressFromDetail((event as CustomEvent).detail));
      setUpdatePhase("downloading");
      setUpdateProgress(percent);
      setUpdateMessage("正在下载新版客户端，请不要关闭赤狐管家。");
    };
    const onDownloaded = () => {
      setUpdating(false);
      setUpdatePhase("downloaded");
      setUpdateProgress(100);
      setUpdateMessage("新版客户端下载完成，正在准备安装。安装后重新打开赤狐管家。");
    };
    const onUpdateError = (event: Event) => {
      setUpdating(false);
      setUpdatePhase("error");
      setUpdateProgress(0);
      const detail = (event as CustomEvent).detail;
      setUpdateMessage(typeof detail === "string" ? detail : "自动更新失败，请重新点击更新客户端。");
    };
    const onNotAvailable = () => {
      void downloadWithProgress("未检测到自动更新，正在直接下载新版安装包。");
    };

    window.addEventListener("chihu:download-progress", onProgress);
    window.addEventListener("chihu:update-downloaded", onDownloaded);
    window.addEventListener("chihu:update-error", onUpdateError);
    window.addEventListener("chihu:update-not-available", onNotAvailable);
    return () => {
      window.removeEventListener("chihu:download-progress", onProgress);
      window.removeEventListener("chihu:update-downloaded", onDownloaded);
      window.removeEventListener("chihu:update-error", onUpdateError);
      window.removeEventListener("chihu:update-not-available", onNotAvailable);
    };
  }, [needsClientUpdate]);

  if (needsClientUpdate) {
    return (
      <div className="grid gap-3">
        <div className="rounded-md border border-[#bfd7ff] bg-[#f3f7ff] px-3 py-3">
          <div className="mb-2 text-[13px] font-semibold text-[#1d2939]">请先更新客户端</div>
          <div className="text-[13px] leading-5 text-[#344054]">
            {updateMessage || "当前版本过低，更新后即可继续兑换卡密或使用已开通的授权。"}
          </div>
          <div className="mt-3">
            <UpdateProgressBar phase={updatePhase} progress={updateProgress} />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#1d4ed8] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[#1e40af] disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={updateBusy}
            onClick={() => void updateClient()}
          >
            {updateBusy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <Download className="size-[14px]" strokeWidth={2.2} />}
            {updateBusy ? "更新中" : "更新客户端"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <label className="grid gap-1.5">
        <span className="text-[13px] font-semibold text-[#344054]">卡密</span>
        <input
          className="h-10 rounded-md border border-[#d8e0ec] bg-white px-3 text-[14px] font-medium text-[#101828] outline-none transition-colors placeholder:text-[#98a2b3] focus:border-[#3346e8] focus:ring-2 focus:ring-[#3346e8]/12 disabled:cursor-not-allowed disabled:bg-[#f5f7fb]"
          value={cardKey}
          disabled={!status.configured || busy}
          placeholder="输入未兑换过的卡密"
          onChange={(event) => setCardKey(event.target.value)}
        />
      </label>

      {message || status.message ? (
        <div className={cn(
          "flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] leading-5",
          status.licensed ? "border-[#bff0cf] bg-[#f0fff5] text-[#087443]" : "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]"
        )}>
          {status.licensed ? <CheckCircle2 className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} /> : <AlertCircle className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} />}
          <span>{message || status.message}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-3">
        <button
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#344054] transition-colors hover:bg-[#f6f8fc] disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={checking || busy}
          onClick={() => void onRefresh()}
        >
          {checking ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <RefreshCcw className="size-[14px]" strokeWidth={2.2} />}
          刷新授权
        </button>
        <button
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white transition-colors hover:bg-brand-foxHover disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={!canSubmit}
        >
          {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <CreditCard className="size-[14px]" strokeWidth={2.2} />}
          兑换到当前设备
        </button>
      </div>
    </form>
  );
}

export function LicenseGateScreen({
  status,
  checking,
  redeeming,
  message,
  onRedeem,
  onRefresh
}: {
  status: LicenseStatus;
  checking: boolean;
  redeeming: boolean;
  message: string;
  onRedeem: (cardKey: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const Icon = status.licensed ? ShieldCheck : isClientUpdateRequired(status) ? Download : status.configured ? CreditCard : AlertCircle;

  return (
    <main className="grid min-h-screen grid-rows-[auto_minmax(0,1fr)] bg-[#f5f7fb] text-[#101828]">
      <header className="flex min-h-[68px] items-center justify-between border-b border-[#e6ebf3] bg-white px-6 max-[640px]:px-4">
        <img alt="赤狐管家" className="h-11 w-[158px] object-contain object-left" src={remoteAsset("assets/chihu-logo-horizontal.png")} />
        <span className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold",
          status.licensed ? "bg-[#f0fff5] text-[#087443]" : "bg-[#fff7e8] text-[#b54708]"
        )}>
          {checking ? <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} /> : <Icon className="size-[13px]" strokeWidth={2.2} />}
          {statusCopy(status)}
        </span>
      </header>

      <section className="grid min-h-0 place-items-center p-5 max-[640px]:place-items-start max-[640px]:p-3">
        <div className="w-[min(680px,100%)] rounded-lg border border-[#dbe5f2] bg-white shadow-[0_22px_60px_rgba(15,23,42,0.10)]">
          <div className="border-b border-[#edf1f6] px-6 py-5 max-[640px]:px-4">
            <div className="mb-4 flex items-start gap-3">
              <span className={cn(
                "grid size-11 shrink-0 place-items-center rounded-full border",
                status.licensed ? "border-[#bff0cf] bg-[#f0fff5] text-[#087443]" : "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]"
              )}>
                {checking ? <Loader2 className="size-5 animate-spin" strokeWidth={2.2} /> : <Icon className="size-5" strokeWidth={2.2} />}
              </span>
              <div className="min-w-0">
                <h1 className="m-0 text-[21px] font-semibold tracking-normal text-[#101828]">{statusCopy(status)}</h1>
                <p className="m-0 mt-2 text-[13px] leading-6 text-[#667085]">{detailCopy(status)}</p>
              </div>
            </div>
            <LicenseFacts status={status} />
          </div>

          <div className="px-6 py-5 max-[640px]:px-4">
            <LicenseRedeemForm
              status={status}
              busy={redeeming}
              checking={checking}
              message={message}
              onRedeem={onRedeem}
              onRefresh={onRefresh}
            />
            {status.contact ? (
              <p className="m-0 mt-4 text-[12px] leading-5 text-[#667085]">客服：{status.contact}</p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

export function LicenseRenewDialog({
  open,
  status,
  checking,
  redeeming,
  message,
  onOpenChange,
  onRedeem,
  onRefresh
}: {
  open: boolean;
  status: LicenseStatus;
  checking: boolean;
  redeeming: boolean;
  message: string;
  onOpenChange: (open: boolean) => void;
  onRedeem: (cardKey: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const title = useMemo(() => {
    if (isClientUpdateRequired(status)) return "更新客户端";
    return status.licensed ? "设备续费" : "设备授权";
  }, [status]);

  useEffect(() => {
    if (!open) return;
    void onRefresh();
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[#dbe5f2] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="flex items-start justify-between gap-4 border-b border-[#edf1f6] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[18px] font-semibold text-[#101828]">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-[#667085]">
                {isClientUpdateRequired(status)
                  ? "更新后即可继续兑换或使用授权。"
                  : status.deviceNo ? `当前设备：${status.deviceNo}` : "当前设备正在同步"}
              </Dialog.Description>
            </div>
            <Dialog.Close className="grid size-8 shrink-0 place-items-center rounded-md border border-[#dbe5f2] text-[#667085] hover:bg-[#f6f8fc]" type="button" aria-label="关闭设备授权">
              <X className="size-[15px]" strokeWidth={2} />
            </Dialog.Close>
          </div>
          <div className="grid gap-4 px-5 py-4">
            <LicenseFacts status={status} />
            <LicenseRedeemForm
              status={status}
              busy={redeeming}
              checking={checking}
              message={message}
              onRedeem={onRedeem}
              onRefresh={onRefresh}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
