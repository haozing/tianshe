# Site Capability Default Flow Golden Transcript

本文件固定默认 agent 路径的对话形态：先发现业务能力，再调用站点能力，最后用 dataset provenance 追溯写入证据；只有没有成熟匹配能力时才进入受限浏览器 fallback。

## Transcript

User: 请从 Books to Scrape 读取一本书的商品信息，并把结果写入数据集后告诉我来源。

Assistant: 我会先查询可用站点能力，优先走固定 Site Adapter 能力。

Tool: `site_capability_list`

Tool Result:

```json
{
  "capabilities": [
    {
      "name": "books_to_scrape.extract_product",
      "sideEffectLevel": "read-only",
      "requiredScopes": ["browser.read"]
    }
  ]
}
```

Assistant: 找到了 `books_to_scrape.extract_product`，我会用它读取结构化商品信息，并要求返回来源与运行证据。

Tool: `books_to_scrape.extract_product`

Tool Result:

```json
{
  "structuredContent": {
    "title": "A Light in the Attic",
    "price": "£51.77",
    "availability": "In stock",
    "sourceUrl": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
    "confidence": 0.98,
    "missingFields": [],
    "pageFingerprint": "books-product-fixture"
  },
  "artifactRefs": [
    "site_adapter_trace:books_to_scrape.extract_product"
  ]
}
```

Assistant: 商品信息已读取。接下来我会查询写入记录的 provenance，确认数据来源、adapter、runtime 和 trace。

Tool: `dataset_get_record_provenance`

Tool Result:

```json
{
  "datasetId": "books-products",
  "rowId": "row-a-light-in-the-attic",
  "source": {
    "adapterId": "books-to-scrape",
    "capabilityName": "books_to_scrape.extract_product",
    "sourceUrl": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
  },
  "runtime": {
    "runtimeId": "browser-runtime"
  },
  "trace": {
    "traceId": "trace-books-product",
    "artifactRefs": [
      "site_adapter_trace:books_to_scrape.extract_product"
    ]
  }
}
```

Assistant: 已完成。该记录来自 `books-to-scrape` adapter 的 `books_to_scrape.extract_product` 能力，来源 URL 和 trace 已进入 dataset provenance，可用于后续审计。
