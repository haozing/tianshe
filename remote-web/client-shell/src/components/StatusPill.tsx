import { cn } from "../lib/utils";

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ok" || status === "ready" || status === "壳已就绪"
      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
      : status === "missing" || status === "error"
        ? "bg-red-50 text-red-600 ring-1 ring-red-100"
        : status === "优先接入"
          ? "bg-orange-50 text-orange-700 ring-1 ring-orange-100"
          : "bg-slate-100 text-slate-600 ring-1 ring-slate-200";

  return (
    <span className={cn("inline-flex h-7 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-bold", tone)}>
      {status}
    </span>
  );
}
