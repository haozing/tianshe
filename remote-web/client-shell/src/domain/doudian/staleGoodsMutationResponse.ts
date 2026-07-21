export interface StaleGoodsMutationTransportResponse {
  ok: boolean;
  data: unknown;
  error?: string;
}

export interface StaleGoodsMutationItemResult {
  productId: string;
  code: string;
  ok: boolean;
  message: string;
  present: boolean;
}

export interface StaleGoodsMutationValidation {
  ok: boolean;
  topLevelCode: string;
  topLevelMessage: string;
  responseItemCount: number;
  responseItemShape: string;
  items: StaleGoodsMutationItemResult[];
  failures: StaleGoodsMutationItemResult[];
  message: string;
}

export interface StaleGoodsMutationValidationOptions {
  planKey: string;
  responseContract: string;
  productIds: string[];
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function getPathValue(root: unknown, path: string): unknown {
  if (!path) return root;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

function firstPathValue(root: unknown, paths: string[]) {
  for (const path of paths) {
    const value = getPathValue(root, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function responseMessage(response: StaleGoodsMutationTransportResponse) {
  return text(firstPathValue(response.data, ["msg", "message", "status_msg", "statusMessage"]) || response.error);
}

function responseItems(data: unknown) {
  if (Array.isArray(data)) return { items: data, shape: "array" };
  const candidates: Array<[string, unknown]> = [
    ["data", getPathValue(data, "data")],
    ["data.list", getPathValue(data, "data.list")],
    ["data.items", getPathValue(data, "data.items")],
    ["list", getPathValue(data, "list")],
    ["items", getPathValue(data, "items")],
    ["result", getPathValue(data, "result")]
  ];
  const match = candidates.find(([, value]) => Array.isArray(value));
  return match ? { items: match[1] as unknown[], shape: match[0] } : { items: [], shape: "missing" };
}

function mutationItemProductId(item: unknown) {
  return text(firstPathValue(item, ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "id"]));
}

function mutationItemCode(item: unknown) {
  const code = firstPathValue(item, ["code", "status_code", "statusCode", "errno"]);
  return code === undefined ? "" : String(code);
}

function mutationItemMessage(item: unknown, fallback: string) {
  return text(firstPathValue(item, ["msg", "message", "error", "errMsg"])) || fallback;
}

export function validateStaleGoodsMutationResponse(
  response: StaleGoodsMutationTransportResponse,
  options: StaleGoodsMutationValidationOptions
): StaleGoodsMutationValidation {
  const rawCode = firstPathValue(response.data, ["code", "st", "status_code", "statusCode", "errno"]);
  const topLevelCode = rawCode === undefined ? "" : String(rawCode);
  const topLevelMessage = responseMessage(response);
  const topLevelOk = response.ok === true && topLevelCode === "0";
  if (!topLevelOk) {
    const message = topLevelMessage || (response.ok ? "platform response missing success code" : response.error || "platform request failed");
    const items = options.productIds.map((productId) => ({ productId, code: topLevelCode, ok: false, message, present: false }));
    return {
      ok: false,
      topLevelCode,
      topLevelMessage,
      responseItemCount: 0,
      responseItemShape: "not-validated",
      items,
      failures: items,
      message
    };
  }

  const requiresPerProduct = options.responseContract === "per-product-code"
    || options.planKey === "staleGoodsBatchOffline"
    || options.planKey === "staleGoodsBatchDelete";
  if (!requiresPerProduct) {
    const items = options.productIds.map((productId) => ({ productId, code: topLevelCode, ok: true, message: topLevelMessage, present: true }));
    return {
      ok: true,
      topLevelCode,
      topLevelMessage,
      responseItemCount: 0,
      responseItemShape: "top-level",
      items,
      failures: [],
      message: topLevelMessage
    };
  }

  const parsed = responseItems(response.data);
  const rawItems = parsed.items;
  const hasProductIds = rawItems.some((item) => Boolean(mutationItemProductId(item)));
  const byProductId = new Map<string, unknown>();
  for (const item of rawItems) {
    const productId = mutationItemProductId(item);
    if (productId) byProductId.set(productId, item);
  }
  const fallbackMessage = topLevelMessage || "platform returned a failed product result";
  const items = options.productIds.map((productId, index) => {
    const rawItem = hasProductIds ? byProductId.get(productId) : rawItems[index];
    const present = rawItem !== undefined;
    const code = present ? mutationItemCode(rawItem) : "";
    const ok = present && code === "0";
    return {
      productId,
      code,
      ok,
      message: present ? mutationItemMessage(rawItem, fallbackMessage) : "platform response missing this product result",
      present
    };
  });
  const failures = items.filter((item) => !item.ok);
  const message = failures[0]?.message || topLevelMessage || `platform acknowledged ${items.length} products`;
  return {
    ok: failures.length === 0 && items.length === options.productIds.length,
    topLevelCode,
    topLevelMessage,
    responseItemCount: rawItems.length,
    responseItemShape: parsed.shape,
    items,
    failures,
    message
  };
}
