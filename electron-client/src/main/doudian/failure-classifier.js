function classifyStoreFailure(errorOrMessage, fallbackReason = "unknown", adapter, options = {}) {
  const safeError = options.safeError || ((error) => (error && error.message ? error.message : String(error || "")));
  const adapterStrategies = options.adapterStrategies || ((nextAdapter) => nextAdapter?.strategies || {});
  const raw = typeof errorOrMessage === "string" ? errorOrMessage : safeError(errorOrMessage);
  const text = String(raw || "").toLowerCase();
  let reason = fallbackReason || "unknown";
  let category = "unknown";
  let title = "未知失败";
  const rules = adapterStrategies(adapter).failureRules || [];

  for (const rule of rules) {
    const matched = (rule.patterns || []).some((pattern) => {
      try {
        return new RegExp(String(pattern), "i").test(text);
      } catch {
        return text.includes(String(pattern || "").toLowerCase());
      }
    });
    if (!matched) continue;
    reason = rule.reason || reason;
    category = rule.category || category;
    title = rule.title || title;
    break;
  }

  return {
    reason,
    category,
    title,
    message: raw || title
  };
}

function buildStoreFailure(shop, errorOrMessage, extra = {}, adapter, options = {}) {
  const classified = classifyStoreFailure(errorOrMessage, extra.reason, adapter, options);
  return {
    shopId: String(shop?.shopId || ""),
    shopName: String(shop?.shopName || ""),
    message: classified.message,
    reason: classified.reason,
    category: classified.category,
    diagnostic: extra.diagnostic || null,
    index: extra.index,
    total: extra.total
  };
}

module.exports = { buildStoreFailure, classifyStoreFailure };
