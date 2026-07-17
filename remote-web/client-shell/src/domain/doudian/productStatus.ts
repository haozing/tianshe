import type { DoudianBulkDeleteProductStatus } from "../../types";

/**
 * The product list API exposes both numeric lifecycle codes and display labels.
 * Keep this mapping shared with the mutation safety layer so preview and execute
 * never disagree about whether a product is selling or recyclable.
 */
export function normalizeDoudianProductStatus(value: unknown): DoudianBulkDeleteProductStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (["2", "recycle", "recycled"].includes(raw) || raw.includes("recycle") || raw.includes("回收")) return "recycle";
  if (
    ["1", "offline", "off_sale", "offsale"].includes(raw) ||
    raw.includes("offline") ||
    raw.includes("下架")
  ) return "offline";
  if (
    ["0", "selling", "onsale", "on_sale"].includes(raw) ||
    raw.includes("selling") ||
    raw.includes("售卖") ||
    raw.includes("在售") ||
    raw.includes("上架")
  ) return "selling";
  if (
    raw.includes("审核驳回") ||
    raw.includes("审核拒绝") ||
    raw.includes("rejected") ||
    raw.includes("reject") ||
    raw.includes("audit_failed")
  ) return "rejected";
  return "unknown";
}
