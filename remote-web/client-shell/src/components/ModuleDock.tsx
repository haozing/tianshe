import * as Tooltip from "@radix-ui/react-tooltip";
import { primaryModules, secondaryModules } from "../data/modules";
import { isActiveRoute } from "../lib/utils";
import type { WorkspaceState } from "../types";
import { ModuleIcon, ShellIcons } from "./Icon";

interface ModuleDockProps {
  route: string;
  workspace: WorkspaceState;
}

export function ModuleDock({ route, workspace }: ModuleDockProps) {
  return (
    <Tooltip.Provider delayDuration={250}>
      <footer className="grid grid-cols-[84px_minmax(0,1fr)_172px] items-end gap-[18px] px-[26px] pb-[26px] max-[1050px]:grid-cols-[76px_minmax(0,1fr)] max-[760px]:grid-cols-1 max-[760px]:px-3 max-[760px]:pb-[18px]">
        <a
          className="grid h-[68px] w-[70px] place-items-center content-center gap-1 rounded-lg bg-gradient-to-b from-[#ff6a3a] to-brand-fox text-[13px] font-extrabold text-white no-underline shadow-dock max-[760px]:h-12 max-[760px]:w-full max-[760px]:grid-flow-col"
          href="#/stores"
        >
          <ShellIcons.Store className="size-[22px]" />
          <span>店铺列表</span>
        </a>

        <div className="grid min-w-0 gap-2">
          <nav className="mx-auto grid w-[min(690px,100%)] grid-cols-4 items-center bg-white/90 max-[760px]:w-full max-[760px]:grid-cols-1 max-[760px]:overflow-hidden max-[760px]:rounded-lg max-[760px]:border max-[760px]:border-shell-line" aria-label="主模块">
            {primaryModules.map((item) => (
              <Tooltip.Root key={item.id}>
                <Tooltip.Trigger asChild>
                  <a
                    className={[
                      "inline-flex min-h-[42px] min-w-0 items-center justify-center gap-2 whitespace-nowrap px-2.5 text-[13px] font-extrabold text-[#193354] no-underline hover:text-brand-fox max-[760px]:justify-start max-[760px]:px-3.5",
                      isActiveRoute(route, item.route) ? "text-brand-fox" : ""
                    ].join(" ")}
                    href={"#" + item.route}
                  >
                    <ModuleIcon name={item.icon} />
                    <span>{item.label}</span>
                  </a>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow" sideOffset={6}>
                    {item.summary}
                    <Tooltip.Arrow className="fill-slate-900" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </nav>

          <nav className="grid min-h-12 grid-cols-7 items-center overflow-hidden rounded-lg border border-shell-line bg-white/90 max-[1050px]:grid-cols-3 max-[760px]:grid-cols-1" aria-label="业务功能">
            {secondaryModules.map((item) => (
              <a
                key={item.id}
                className={[
                  "inline-flex min-h-[42px] min-w-0 items-center justify-center gap-2 whitespace-nowrap px-2.5 text-[13px] font-extrabold text-[#193354] no-underline hover:bg-brand-fox hover:text-white max-[760px]:justify-start max-[760px]:px-3.5",
                  isActiveRoute(route, item.route) ? "bg-brand-fox text-white" : ""
                ].join(" ")}
                href={"#" + item.route}
              >
                <ModuleIcon name={item.icon} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
        </div>

        <aside className="grid gap-2 self-end max-[1050px]:col-span-full max-[1050px]:grid-cols-[repeat(2,minmax(0,172px))] max-[1050px]:justify-end max-[760px]:grid-cols-1">
          <button
            className="flex min-h-[31px] min-w-0 items-center gap-2 rounded-full border border-shell-line bg-white/95 px-3 text-xs text-[#304461]"
            type="button"
          >
            <ShellIcons.User className="size-4 text-brand-navy" />
            <span>{workspace.operator}</span>
          </button>
          <button className="min-h-[31px] whitespace-nowrap rounded-full border border-[#ffdca8] bg-white/95 px-3 text-xs font-extrabold text-[#a45b00]" type="button">
            点击购买
          </button>
        </aside>
      </footer>
    </Tooltip.Provider>
  );
}
