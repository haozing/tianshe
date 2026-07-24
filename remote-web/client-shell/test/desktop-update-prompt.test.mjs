import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellHeaderUrl = new URL("../src/components/ShellHeader.tsx", import.meta.url);

test("automatic desktop update checks open the update dialog when a newer version exists", async () => {
  const source = await readFile(shellHeaderUrl, "utf8");
  const availableBranch = source.match(/else if \(hasDesktopUpdate\(data\)\) \{([\s\S]*?)\n\s*\} else \{/);

  assert.ok(availableBranch);
  assert.match(availableBranch[1], /setUpdateState\("available"\)/);
  assert.match(availableBranch[1], /setVersionDialogOpen\(true\)/);
});
