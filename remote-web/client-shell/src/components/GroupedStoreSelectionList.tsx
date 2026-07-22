import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { STORAGE_KEY_STORE_GROUPS_COLLAPSED, storageGet, storageSet } from "../bridge/storage";
import { groupStoresByName } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type { DoudianStoreStatus } from "../types";

export interface GroupedSelectableStore {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

interface GroupedStoreSelectionListProps<T extends GroupedSelectableStore> {
  stores: readonly T[];
  selectedIds: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
}

const statusCopy: Record<DoudianStoreStatus, { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn(
      "grid size-4 shrink-0 place-items-center rounded border",
      checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent"
    )}>
      {mixed ? <span className="h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function StatusTag({ status }: { status: DoudianStoreStatus }) {
  const copy = statusCopy[status] || statusCopy.unknown;
  return <span className={cn("rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold", copy.className)}>{copy.label}</span>;
}

export function GroupedStoreSelectionList<T extends GroupedSelectableStore>({ stores, selectedIds, onToggleIds }: GroupedStoreSelectionListProps<T>) {
  const groups = useMemo(() => groupStoresByName(stores), [stores]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(storageGet<string[]>(STORAGE_KEY_STORE_GROUPS_COLLAPSED, [])));

  function toggleGroup(groupName: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      storageSet(STORAGE_KEY_STORE_GROUPS_COLLAPSED, [...next]);
      return next;
    });
  }

  return (
    <div className="divide-y divide-[#e4eaf3]">
      {groups.map((group) => {
        const ids = group.stores.map((store) => store.id);
        const selectedCount = ids.filter((id) => selectedIds.has(id)).length;
        const allSelected = ids.length > 0 && selectedCount === ids.length;
        const someSelected = selectedCount > 0 && !allSelected;
        const collapsed = collapsedGroups.has(group.name);
        return (
          <section key={group.name}>
            <div className="sticky top-0 z-10 flex h-8 items-center justify-between gap-2 border-b border-[#edf1f6] bg-[#f8fafc] px-3">
              <button className="grid size-5 shrink-0 place-items-center" type="button" aria-label={`${allSelected ? "取消选择" : "选择"}分组 ${group.name}`} title={`${allSelected ? "取消选择" : "选择"}该分组`} onClick={() => onToggleIds(ids)}>
                <CheckboxBox checked={allSelected} mixed={someSelected} />
              </button>
              <button className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-semibold text-[#344054]" type="button" aria-expanded={!collapsed} title={`${collapsed ? "展开" : "收起"} ${group.name}`} onClick={() => toggleGroup(group.name)}>
                {collapsed ? <ChevronRight className="size-[14px] shrink-0 text-[#667085]" strokeWidth={2.2} /> : <ChevronDown className="size-[14px] shrink-0 text-[#667085]" strokeWidth={2.2} />}
                <span className="truncate" title={group.name}>{group.name}</span>
              </button>
              <span className="shrink-0 text-[11px] text-[#98a2b3]">{selectedCount}/{ids.length}</span>
            </div>
            {!collapsed ? <div className="divide-y divide-[#edf1f6]">
              {group.stores.map((store) => (
                <button
                  className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#f8fbff]", selectedIds.has(store.id) ? "bg-[#fffaf7]" : "bg-white")}
                  key={store.id}
                  type="button"
                  onClick={() => onToggleIds([store.id])}
                >
                  <span className="pt-1"><CheckboxBox checked={selectedIds.has(store.id)} /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-semibold text-[#1d2939]" title={store.name}>{store.name}</span>
                    <span className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-[#667085]">
                      <span className="truncate">ID: {store.id}</span>
                      <StatusTag status={store.status} />
                    </span>
                  </span>
                </button>
              ))}
            </div> : null}
          </section>
        );
      })}
    </div>
  );
}
