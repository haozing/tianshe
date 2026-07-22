export function opportunityLiveLookupContext(productId: string) {
  return {
    productId,
    idNameCode: productId,
    keyword: "",
    page: "0",
    pageSize: "20",
    productStatus: "",
    checkStatus: "",
    draftStatus: "",
    isOnline: "",
    isOffline: "",
    offlineType: "",
    productTab: "all",
    needPayNoStockSkus: "false",
    commentPercent: "",
    orderField: "audit_time",
    sort: "desc"
  };
}
