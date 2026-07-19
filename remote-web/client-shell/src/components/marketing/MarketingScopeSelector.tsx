export function MarketingScopeSelector({ value, labels, onChange }: { value: string; labels: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <div className="inline-grid h-8 grid-flow-col rounded-md border border-[#dbe3ee] bg-[#f8fafc] p-0.5">
      {labels.map((item) => (
        <button key={item.value} className={`min-w-[92px] rounded px-3 text-[12px] font-semibold ${value === item.value ? "bg-white text-[#073b7a] shadow-sm" : "text-[#667085]"}`} type="button" onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
