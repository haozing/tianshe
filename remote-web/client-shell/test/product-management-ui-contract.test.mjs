import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/components/ProductManagementPage.tsx", import.meta.url), "utf8");

test("product management uses the requested query and preview layout", () => {
  for (const label of ["商品标题 / ID", "商品选择", "商品价格", "销量区间", "运费模板", "创建时间", "商品预览"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /grid-rows-\[184px_minmax\(0,1fr\)\]/);
  assert.match(source, /获取商品/);
  assert.match(source, /导出清单/);
  assert.match(source, /fetchDoudianFreightTemplates/);
  assert.match(source, /aria-label="刷新运费模板"/);
  assert.match(source, /whitespace-nowrap[\s\S]*获取商品/);
});

test("selecting products opens a centered four-action dialog without typed confirmation", () => {
  assert.match(source, /if \(current\.size === 0\) setActionDialogOpen\(true\)/);
  assert.match(source, /fixed inset-0[\s\S]*place-items-center/);
  assert.match(source, /选择执行动作/);
  for (const action of ["online", "offline", "recycle", "delete"]) {
    assert.match(source, new RegExp(`value: "${action}"`));
  }
  for (const label of ["上架", "下架", "移入回收站", "彻底删除"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /confirmText: "确认执行"/);
  assert.doesNotMatch(source, /确认删除/);
  assert.doesNotMatch(source, /confirmInput/);
});

test("complete delete explains the recycle-bin transition", () => {
  assert.match(source, /非回收站商品会先移入回收站，再从回收站永久删除/);
});
