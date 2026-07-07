import * as Dialog from "@radix-ui/react-dialog";
import type { BusinessModule } from "../types";
import { StatusPill } from "./StatusPill";

export function ModulePage({ module }: { module: BusinessModule }) {
  return (
    <section className="min-h-0 rounded-xl border border-[#dbe5f2] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.03)]" data-business-slot="ready">
      <div className="mb-6 flex min-w-0 items-start justify-between gap-4 max-[760px]:flex-col">
        <div>
          <span className="mb-1.5 inline-flex text-xs font-bold text-brand-fox">业务模块</span>
          <h1 className="m-0 text-[26px] font-bold leading-tight tracking-[0] text-brand-navy">{module.label}</h1>
          <p className="m-0 mt-1 text-[15px] leading-relaxed text-[#526a91]">{module.summary}</p>
        </div>
        <StatusPill status={module.status} />
      </div>

      <div className="grid grid-cols-3 gap-3 max-[760px]:grid-cols-1">
        {module.metrics.map(([label, value]) => (
          <article key={label} className="grid min-h-[94px] content-center gap-2 rounded-lg border border-[#dbe5f2] bg-[#f8fbff] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            <span className="text-[13px] font-medium text-[#5b6f92]">{label}</span>
            <strong className="text-[26px] font-bold leading-none text-[#073b7a]">{value}</strong>
          </article>
        ))}
      </div>

      <div className="my-5 flex flex-wrap gap-3">
        {module.actions.map((action, index) => (
          <Dialog.Root key={action}>
            <Dialog.Trigger asChild>
              <button
                className={[
                  "h-9 rounded-md border px-4 text-[14px] font-semibold shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-colors",
                  index === 0 ? "border-brand-fox bg-brand-fox text-white hover:bg-brand-foxHover" : "border-[#dbe5f2] bg-white text-[#1d2939] hover:bg-brand-foxSoft"
                ].join(" ")}
                type="button"
              >
                {action}
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 bg-slate-950/20" />
              <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[#dbe5f2] bg-white p-5 shadow-xl">
                <Dialog.Title className="m-0 text-lg font-bold text-[#073b7a]">{action}</Dialog.Title>
                <Dialog.Description className="mt-2 leading-relaxed text-[#526a91]">
                  这里是 {module.label} 的操作槽位。接入真实业务后，这里会替换为表单、任务确认或详情面板。
                </Dialog.Description>
                <Dialog.Close className="mt-4 h-9 rounded-md bg-brand-fox px-4 text-sm font-semibold text-white hover:bg-brand-foxHover" type="button">
                  知道了
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        ))}
      </div>

      <div className="grid min-h-[110px] content-center gap-1.5 rounded-lg border border-dashed border-[#bdd2ef] bg-[#fbfdff] px-[18px] py-4">
        <strong className="text-[15px] font-bold text-[#101828]">业务接口待接入</strong>
        <p className="m-0 text-[14px] leading-relaxed text-[#526a91]">当前页面先固定路由、导航、状态和操作槽位。下一步可从店铺管理开始接真实数据。</p>
      </div>
    </section>
  );
}
