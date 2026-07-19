import { ChevronDown, PanelLeftClose, Search } from "lucide-react";
import { GroupedStoreSelectionList, type GroupedSelectableStore } from "../GroupedStoreSelectionList";

export interface MarketingSelectableStore extends GroupedSelectableStore {
  partition: string;
  tenantId?: string;
  storeGeneration?: number;
}

export function MarketingStoreSidebar({
  stores,
  selectedIds,
  search,
  collapsed,
  loading,
  onSearch,
  onToggleIds,
  onCollapsedChange
}: {
  stores: MarketingSelectableStore[];
  selectedIds: ReadonlySet<string>;
  search: string;
  collapsed: boolean;
  loading: boolean;
  onSearch: (value: string) => void;
  onToggleIds: (ids: string[]) => void;
  onCollapsedChange: (value: boolean) => void;
}) {
  const filtered = stores.filter((store) => !search || `${store.name} ${store.id} ${store.group}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <aside className="min-h-0 border-r border-[#e6ebf3] bg-white max-[860px]:border-r-0 max-[860px]:border-b">
      <button
        className="hidden h-11 w-full items-center justify-between px-4 text-left text-[13px] font-semibold text-[#344054] max-[860px]:flex"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onCollapsedChange(!collapsed)}
      >
        <span>店铺选择 · 已选 {selectedIds.size}</span>
        <ChevronDown className={`size-4 transition-transform ${collapsed ? "" : "rotate-180"}`} />
      </button>
      <div className={`${collapsed ? "max-[860px]:hidden" : ""} flex h-full min-h-0 flex-col max-[860px]:h-[360px]`}>
        <div className="flex h-12 items-center justify-between border-b border-[#edf1f6] px-3">
          <div>
            <strong className="block text-[13px] text-[#1d2939]">店铺选择</strong>
            <span className="text-[11px] text-[#98a2b3]">在线 {stores.filter((store) => store.status === "online").length} · 已选 {selectedIds.size}</span>
          </div>
          <button className="grid size-7 place-items-center rounded-md text-[#667085] hover:bg-[#f6f8fc] max-[860px]:hidden" type="button" title="收起店铺栏" onClick={() => onCollapsedChange(true)}>
            <PanelLeftClose className="size-4" />
          </button>
        </div>
        <label className="relative m-3 block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#98a2b3]" />
          <input className="h-8 w-full rounded-md border border-[#dbe3ee] pl-8 pr-2 text-[12px] outline-none focus:border-[#ff5020]" value={search} placeholder="搜索店铺或 ID" onChange={(event) => onSearch(event.target.value)} />
        </label>
        <div className="min-h-0 flex-1 overflow-auto border-t border-[#edf1f6]">
          {loading ? <div className="px-4 py-8 text-center text-[12px] text-[#98a2b3]">正在读取店铺...</div> : filtered.length ? (
            <GroupedStoreSelectionList stores={filtered} selectedIds={selectedIds} onToggleIds={onToggleIds} />
          ) : <div className="px-4 py-8 text-center text-[12px] text-[#98a2b3]">暂无匹配店铺</div>}
        </div>
      </div>
    </aside>
  );
}
