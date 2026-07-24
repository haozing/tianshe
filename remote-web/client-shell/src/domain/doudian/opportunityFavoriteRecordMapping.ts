import type { DoudianOpportunityFavoriteRecord, DoudianOpportunityFavoriteTag, DoudianStoreSummary } from "../../types";

const DEFAULT_PAGE_SIZE = 24;
const DEFAULT_MAX_PAGES = 100;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(min, Math.min(max, Math.floor(next))) : fallback;
}

function normalizeTags(value: unknown, idKeys: string[], nameKeys: string[]): DoudianOpportunityFavoriteTag[] {
  if (!Array.isArray(value)) return [];
  const tags = new Map<string, DoudianOpportunityFavoriteTag>();
  for (const item of value) {
    const record = objectRecord(item);
    const id = text(idKeys.map((key) => record[key]).find((entry) => entry !== undefined));
    const name = text(nameKeys.map((key) => record[key]).find((entry) => entry !== undefined));
    if (id || name) tags.set(`${id}:${name}`, { id: id || name, name: name || id });
  }
  return [...tags.values()];
}

function categoryPathOf(detail: Record<string, unknown>) {
  const path = detail.category_path || detail.categoryPath;
  if (Array.isArray(path)) {
    return path.map((item) => {
      if (typeof item === "string" || typeof item === "number") return text(item);
      const record = objectRecord(item);
      return text(record.cate_name || record.cateName || record.name || record.label);
    }).filter(Boolean);
  }
  return [detail.first_name, detail.second_name, detail.third_name, detail.fourth_name].map(text).filter(Boolean);
}

export function normalizeOpportunityFavoriteRecord(store: DoudianStoreSummary, value: unknown): DoudianOpportunityFavoriteRecord | null {
  const raw = objectRecord(value);
  const task = objectRecord(raw.auto_submit_task || raw.autoSubmitTask);
  const dim = objectRecord(raw.clue_dim_detail || raw.clueDimDetail);
  const detail = objectRecord(dim.clue_detail || dim.clueDetail || raw.clue_infos || raw.clueInfos || raw.clue_detail || raw.clueDetail);
  const clueId = text(task.clue_id || task.clueId || detail.clue_id || detail.clueId || raw.clue_id || raw.clueId);
  const taskId = text(task.auto_submit_task_id || task.autoSubmitTaskId || raw.auto_submit_task_id || raw.autoSubmitTaskId);
  if (!clueId && !taskId) return null;
  const categoryPath = categoryPathOf(detail);
  const pictures = detail.pic_url_list || detail.picUrlList;
  return {
    tenantId: store.tenantId,
    shopId: store.shopId,
    shopName: store.shopName,
    storeGeneration: store.storeGeneration,
    taskId: taskId || clueId,
    clueId: clueId || taskId,
    clueName: text(detail.name || detail.clue_name || detail.clueName || raw.name) || clueId || taskId,
    categoryId: text(detail.category_id || detail.categoryId || detail.third_cid || detail.thirdCid || detail.cate_id || detail.cateId) || undefined,
    categoryName: categoryPath.join(" > ") || text(detail.category_name || detail.categoryName || detail.cate_name || detail.cateName),
    categoryPath,
    labels: normalizeTags(detail.clue_label_list || detail.clueLabelList, ["label_id", "labelId", "id"], ["label_name", "labelName", "name"]),
    benefits: normalizeTags(detail.profit_info_list || detail.profitInfoList, ["profit_id", "profitId", "id"], ["profit_name", "profitName", "name"]),
    taskStatus: numberValue(task.status || raw.task_status || raw.taskStatus),
    clueStatus: numberValue(task.clue_status || task.clueStatus || detail.clue_status || detail.clueStatus),
    beginTime: numberValue(task.begin_time || task.beginTime) || undefined,
    endTime: numberValue(task.end_time || task.endTime) || undefined,
    submittedProductCount: numberValue(task.submit_prod_num || task.submitProdNum),
    priceMin: numberValue(detail.price_min || detail.priceMin) || undefined,
    priceMax: numberValue(detail.price_max || detail.priceMax) || undefined,
    pictureUrl: Array.isArray(pictures) ? text(pictures[0]) || undefined : text(pictures) || undefined
  };
}

export function buildOpportunityFavoriteRecordsBody(current: number, pageSize: number, taskStatus = 1) {
  return {
    page: {
      page_size: boundedInteger(pageSize, DEFAULT_PAGE_SIZE, 1, 100),
      current: boundedInteger(current, 1, 1, DEFAULT_MAX_PAGES)
    },
    task_status: boundedInteger(taskStatus, 1, 0, 99)
  };
}
