import {
  BarChart3,
  Building2,
  CircleDollarSign,
  Crown,
  Maximize2,
  Megaphone,
  Minus,
  ShieldAlert,
  ShoppingBag,
  Trash2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkspaceState } from "../types";
import { cn, isActiveRoute } from "../lib/utils";
import { closeMainWindow, minimizeMainWindow, toggleMaximizeMainWindow } from "../bridge/client";

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
  { label: "商机提报", route: "/opportunities", Icon: Megaphone }
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

export function ShellHeader({ route, workspace }: { route: string; workspace: WorkspaceState }) {
  const activeTopRoute = topRoutes.find((item) => isActiveRoute(route, item.route)) || topRoutes[0];
  const secondaryRoutes = activeTopRoute.subRoutes;
  const subActive = activeSecondaryRoute(route, secondaryRoutes);

  return (
    <header className="app-drag-region grid grid-cols-[214px_minmax(0,1fr)] border-b border-brand-line bg-[#fbfcff]/95 shadow-[0_10px_28px_rgba(15,23,42,0.045)] backdrop-blur max-[860px]:grid-cols-1">
      <aside className="row-span-2 flex min-h-[84px] items-center gap-3 border-r border-[#e6ebf3] px-5 max-[860px]:row-span-1 max-[860px]:min-h-[60px] max-[860px]:border-r-0 max-[860px]:border-b">
        <img
          alt="赤狐管家"
          className="h-12 w-[172px] object-contain object-left"
          src="/new-remote-web/assets/chihu-logo-horizontal.png"
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
          <button className="inline-flex h-8 items-center gap-2 px-2 font-medium text-[#101828]" type="button">
            <span className="grid size-5 place-items-center rounded-full bg-brand-navy text-[12px] font-bold text-white">h</span>
            <span>{workspace.operator}</span>
          </button>
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
