import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/GroupedStoreSelectionList.tsx", import.meta.url)), "utf8");

test("shared grouped store lists can expand and collapse each group", () => {
  assert.match(source, /const \[collapsedGroups, setCollapsedGroups\]/);
  assert.match(source, /aria-expanded=\{!collapsed\}/);
  assert.match(source, /onClick=\{\(\) => toggleGroup\(group\.name\)\}/);
  assert.match(source, /!collapsed \? <div className="divide-y divide-\[#edf1f6\]">/);
  assert.match(source, /ChevronRight/);
  assert.match(source, /ChevronDown/);
});

test("group selection remains separate from group collapse", () => {
  assert.match(source, /aria-label=\{`\$\{allSelected \? "取消选择" : "选择"\}分组 \$\{group\.name\}`\}/);
  assert.match(source, /onClick=\{\(\) => onToggleIds\(ids\)\}/);
  assert.match(source, /STORAGE_KEY_STORE_GROUPS_COLLAPSED/);
});
