import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { candidateKey, partitionToken } from "../src/domain/doudian/storeIdentity.ts";

const pageSource = await readFile(fileURLToPath(new URL("../src/components/StoreManagementPage.tsx", import.meta.url)), "utf8");
const appSource = await readFile(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
const headerSource = await readFile(fileURLToPath(new URL("../src/components/ShellHeader.tsx", import.meta.url)), "utf8");
const navigationLockSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/storeLoginNavigationLock.ts", import.meta.url)), "utf8");
const importSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/storeImport.ts", import.meta.url)), "utf8");
const bridgeSource = await readFile(fileURLToPath(new URL("../src/bridge/client.ts", import.meta.url)), "utf8");

test("store login uses discovery followed by an explicit selected-store login", () => {
  assert.match(pageSource, /fetchDoudianStores\(operationId, \{ mode: "discover" \}/);
  assert.match(pageSource, /mode: "login_selected",\s*sourceOperationId: storeLoginSelection\.sourceOperationId/);
  assert.match(pageSource, /repairShopIds: candidates\.map\(\(store\) => store\.shopId\)/);
  assert.match(pageSource, /repairShopNames: candidates\.map\(\(store\) => store\.shopName\)/);
  assert.match(pageSource, /登录已选店铺/);
  assert.match(pageSource, /aria-label="全选当前列表"/);
});

test("discovered stores appear as selected pending rows before details are updated", () => {
  assert.match(pageSource, /detail\.store\?\.phase === "discovered"/);
  assert.match(pageSource, /setRows\(\(current\) => \{[\s\S]*?next\.push\(mapStoreToRow\(candidate\)\)/);
  assert.match(pageSource, /setSelectedIds\(\(current\) => new Set\(current\)\.add\(candidate\.shopId\)\)/);
  assert.match(pageSource, /row\.pendingLogin \? [\s\S]*?>待登录</);
  assert.match(pageSource, /waitingRows = current\.filter\(\(row\) => row\.pendingLogin/);
});

test("discovered stores are selected in a modal and every login task locks page navigation until cancellation", () => {
  assert.match(pageSource, /function StoreLoginSelectionDialog\(/);
  assert.match(pageSource, /<Dialog\.Root open/);
  assert.match(pageSource, /selection\.candidates\.map\(\(store\) =>/);
  assert.match(pageSource, /const locked = operationBusy && activeTask === "fetchStores"/);
  assert.match(pageSource, /onCancel=\{\(\) => operationBusy && activeTask === "fetchStores" && activeOperationId \? void cancelActiveOperation\(\)/);
  assert.match(appSource, /if \(isStoreLoginNavigationLocked\(\) && nextRoute !== "\/stores"\)/);
  assert.match(headerSource, /aria-disabled=\{navigationBlocked && !active\}/);
  assert.match(navigationLockSource, /export function setStoreLoginNavigationLocked\(next: boolean\)/);
});

test("store login progress bar is absent", () => {
  assert.doesNotMatch(pageSource, /storeImportProgress/);
  assert.doesNotMatch(pageSource, /transition-\[width\][\s\S]*storeImportProgress\.progress/);
});

test("store management does not expose the result filter", () => {
  assert.doesNotMatch(pageSource, /type FailureFilter/);
  assert.doesNotMatch(pageSource, /label="结果"/);
  assert.doesNotMatch(pageSource, /全部结果|只看失败/);
});

test("store discovery preserves the master session and filters the selected stores", () => {
  assert.match(importSource, /preserveSourcePartition = candidates\.length > 0/);
  assert.match(importSource, /const sourceStores = filterRepairStores\(detectedStores, args\.repairShopIds, args\.repairShopNames\)/);
  assert.match(importSource, /if \(!preserveSourcePartition\) \{[\s\S]*?native\.cookies\.clear\(\{ partition \}\)/);
  assert.match(bridgeSource, /mode\?: "import" \| "discover" \| "login_selected" \| "discard_discovery"/);
});

test("name-only stores receive collision-resistant identities and remain retryable after failure", () => {
  const firstName = "甲乙丙专卖店";
  const secondName = "丁戊己专卖店";
  assert.equal(firstName.length, secondName.length);
  assert.notEqual(partitionToken(firstName), partitionToken(secondName));
  assert.notEqual(candidateKey({ shopName: firstName }), candidateKey({ shopName: secondName }));
  assert.equal(candidateKey({ shopId: "123", shopName: firstName }), "123");
  assert.match(importSource, /const pendingShopId = !text\(shop\.shopId\)[\s\S]*?candidateKey\(shop\)/);
  assert.match(importSource, /const failedRecord[\s\S]*?shopId: pendingShopId \|\| record\.shopId/);
});
