import type { MarketingItemFailure } from "./types";

function csvCell(value: unknown) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function marketingFailuresCsv(items: MarketingItemFailure[]) {
  const header = ["店铺 ID", "商品/活动类型", "对象 ID", "阶段", "原因码", "说明"];
  return `\uFEFF${[header, ...items.map((item) => [item.shopId, item.itemType, item.itemId, item.stage, item.reasonCode, item.message])].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export function downloadMarketingFailures(items: MarketingItemFailure[], filename = "marketing-failures.csv") {
  if (typeof document === "undefined") return false;
  const blob = new Blob([marketingFailuresCsv(items)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
