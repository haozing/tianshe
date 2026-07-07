import { quickTasks } from "../data/modules";

const statusCards = [
  { label: "已接入店铺", value: "0", detail: "等待获取", href: "#/stores" },
  { label: "需重新登录", value: "0", detail: "登录态待检测", href: "#/stores" },
  { label: "待处理异常", value: "0", detail: "经营巡检待接入", href: "#/warnings" },
  { label: "最近同步", value: "10:24", detail: "本地状态", href: "#/system/diagnostics" }
];

const taskRoutes = ["#/stores", "#/warnings", "#/products/slow-moving"];

export function HomePage() {
  return (
    <>
      <section className="grid min-h-[214px] gap-5 rounded-lg border border-brand-line bg-white px-6 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] max-[760px]:px-4" data-business-slot="ready">
        <div className="flex min-w-0 items-center justify-between gap-5 max-[760px]:items-start max-[760px]:flex-col">
          <div className="flex min-w-0 items-center gap-4">
            <img
              alt="赤狐管家"
              className="size-[68px] shrink-0 rounded-lg object-contain shadow-[0_10px_24px_rgba(255,80,32,0.14)]"
              src="/new-remote-web/assets/chihu-logo-mark.png"
            />
            <div className="min-w-0">
              <span className="mb-1 inline-flex text-xs font-bold text-brand-fox">赤狐工作台</span>
              <h1 className="m-0 text-[26px] font-extrabold leading-tight tracking-[0] text-brand-navy max-[760px]:text-[22px]">欢迎使用赤狐管家</h1>
              <p className="m-0 mt-2 max-w-[640px] text-[14px] leading-6 text-brand-muted">
                看店铺、盯风险、管推广，把多店经营收进一个工作台。
              </p>
            </div>
          </div>
          <a
            className="inline-flex h-9 shrink-0 items-center rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white no-underline shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover"
            href="#/stores"
          >
            获取店铺
          </a>
        </div>
        <div className="grid grid-cols-4 gap-3 max-[960px]:grid-cols-2 max-[560px]:grid-cols-1">
          {statusCards.map((item, index) => (
            <a
              className="min-w-0 rounded-lg border border-brand-line bg-[#fbfcff] px-4 py-3 no-underline transition-colors hover:border-brand-fox hover:bg-brand-foxSoft"
              href={item.href}
              key={item.label}
            >
              <span className="block text-[12px] font-semibold text-brand-muted">{item.label}</span>
              <strong className={index === 0 ? "mt-1 block text-[24px] leading-none text-brand-fox" : "mt-1 block text-[24px] leading-none text-brand-navy"}>{item.value}</strong>
              <span className="mt-2 block text-[12px] text-brand-muted">{item.detail}</span>
            </a>
          ))}
        </div>
      </section>
      <section className="mt-3.5 grid grid-cols-3 gap-3 max-[760px]:grid-cols-1">
        {quickTasks.map((task, index) => (
          <a key={task.title} className="min-w-0 rounded-lg border border-brand-line bg-white p-3.5 no-underline shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-colors hover:border-brand-fox hover:bg-brand-foxSoft" href={taskRoutes[index] || "#/stores"}>
            <span className="mb-1.5 inline-flex text-xs font-extrabold text-brand-fox">{task.tag}</span>
            <strong className="mb-1 block">{task.title}</strong>
            <p className="m-0 leading-relaxed text-shell-muted">{task.description}</p>
          </a>
        ))}
      </section>
    </>
  );
}
