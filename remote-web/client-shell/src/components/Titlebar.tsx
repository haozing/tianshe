import { ShellIcons } from "./Icon";
import { remoteAsset } from "../lib/assets";

export function Titlebar() {
  return (
    <header className="flex h-[60px] items-center gap-3 border-b border-shell-line bg-white/95 px-5">
      <img className="size-8 rounded-[9px] object-contain shadow-[0_8px_18px_rgba(255,80,32,0.18)]" src={remoteAsset("assets/chihu-app-icon.png")} alt="赤狐管家" />
      <strong className="text-[15px]">赤狐管家</strong>
      <div className="ml-auto flex gap-2.5 text-slate-600" aria-hidden="true">
        <button className="grid size-8 place-items-center rounded-md hover:bg-brand-foxSoft hover:text-brand-navy" type="button">
          <ShellIcons.Minus className="size-4" />
        </button>
        <button className="grid size-8 place-items-center rounded-md hover:bg-brand-foxSoft hover:text-brand-navy" type="button">
          <ShellIcons.Maximize2 className="size-4" />
        </button>
        <button className="grid size-8 place-items-center rounded-md hover:bg-brand-foxSoft hover:text-brand-navy" type="button">
          <ShellIcons.X className="size-4" />
        </button>
      </div>
    </header>
  );
}
