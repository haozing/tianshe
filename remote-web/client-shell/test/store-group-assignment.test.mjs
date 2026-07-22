import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/StoreManagementPage.tsx", import.meta.url)), "utf8");

test("setting a store group uses existing group options", () => {
  assert.match(source, /<span>选择已有分组<\/span>[\s\S]*?<select/);
  assert.match(source, /请选择已有分组/);
  assert.match(source, /groupOptions\.map\(\(option\) => <option/);
  assert.match(source, /const assignableGroupOptions = useMemo\([\s\S]*?\["未分组", \.\.\.groupOptions\.filter/);
  assert.doesNotMatch(source, /operation === "updateGroup"[\s\S]{0,500}<input/);
});

test("assigning a group does not render a result module above the table", () => {
  assert.doesNotMatch(source, /RunDetailsSummary|设置分组结果/);
  assert.match(source, /showOperationResult\("success", `已更新 \$\{result\.updated \|\| 0\} 家店铺分组。`\)/);
});
