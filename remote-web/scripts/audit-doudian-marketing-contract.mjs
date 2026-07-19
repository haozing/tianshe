import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const remoteRoot = join(repoRoot, "remote-web");
const shellRoot = join(remoteRoot, "client-shell", "src");
const adapterPath = join(remoteRoot, "new-remote-web", "config", "doudian-adapter.marketing-pilot.json");
const fallbackAdapterPath = join(remoteRoot, "client-shell", "public", "config", "doudian-adapter.marketing-pilot.json");
const configPath = join(remoteRoot, "client-shell", "public", "config", "chihu-config.json");
const workerPath = join(repoRoot, "electron-client", "src", "main", "database", "worker.js");
const nativeTypesPath = join(shellRoot, "nativeData", "types.ts");
const repositoryPath = join(shellRoot, "domain", "doudian", "repository.ts");
const outputPath = join(remoteRoot, "artifacts", "doudian-marketing-contract-audit.json");
const files = {
  app: join(shellRoot, "App.tsx"),
  routes: join(shellRoot, "featureRoutes.tsx"),
  contract: join(shellRoot, "bridge", "marketingContract.ts"),
  access: join(shellRoot, "domain", "doudian", "marketing", "access.ts"),
  safety: join(shellRoot, "domain", "doudian", "requestPlanSafety.ts"),
  task: join(shellRoot, "domain", "doudian", "marketing", "task.ts"),
  taskClient: join(shellRoot, "domain", "doudian", "taskClient.ts"),
  marketingTypes: join(shellRoot, "domain", "doudian", "marketing", "types.ts"),
  marketingScheduler: join(shellRoot, "domain", "doudian", "marketing", "scheduler.ts"),
  marketingPreflight: join(shellRoot, "domain", "doudian", "marketing", "preflight.ts"),
  marketingReconciliation: join(shellRoot, "domain", "doudian", "marketing", "reconciliationPolicy.ts"),
  marketingSnapshot: join(shellRoot, "domain", "doudian", "marketing", "snapshot.ts"),
  fixtures: join(remoteRoot, "scripts", "audit-doudian-marketing-fixtures.mjs"),
  pages: [
    join(shellRoot, "components", "marketing", "LimitedTimePage.tsx"),
    join(shellRoot, "components", "marketing", "NewUserBonusPage.tsx"),
    join(shellRoot, "components", "marketing", "GeneralCouponPage.tsx")
  ]
};

const text = (filePath) => existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
function collectText(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) collectText(fullPath, output);
    else if (/\.(js|ts|tsx|mjs|json)$/i.test(entry.name)) output.push(text(fullPath));
  }
  return output;
}
const adapter = JSON.parse(readFileSync(existsSync(adapterPath) ? adapterPath : fallbackAdapterPath, "utf8"));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const source = Object.fromEntries(Object.entries(files).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, text(value)]));
source.pages = files.pages.map(text);
const electronSource = collectText(join(repoRoot, "electron-client", "src")).join("\n");
const mutationTimeoutStart = source.taskClient.indexOf("if (isDoudianMutationTask(task))");
const mutationTimeoutBlock = source.taskClient.slice(mutationTimeoutStart, source.taskClient.indexOf("const failed =", mutationTimeoutStart));

const checks = [
  {
    key: "marketingPagesDefaultOpen",
    ok: ["marketingMenu", "marketingLimitedTime", "marketingNewUserBonus", "marketingGeneralCoupon"].every((key) => config.features?.[key]?.enabled === true) && source.access.includes("marketingWriteActions"),
    source: relative(repoRoot, configPath)
  },
  {
    key: "conditionalMarketingCapability",
    ok: source.contract.includes("isValidMarketingContractConfig") && source.contract.includes("general_coupon") && source.contract.includes("mutation.retryOnHttpError") && source.contract.includes("precheckPlanKeys") && source.contract.includes("eligiblePaths") && source.contract.includes("completePaths"),
    source: relative(repoRoot, files.contract)
  },
  {
    key: "mutationSingleSendContract",
    ok: source.safety.includes("maxAttempts") && source.safety.includes("retryOnHttpError") && source.safety.includes("prepareRetryAttempts") && source.safety.includes("clampRequestTimeoutMs"),
    source: relative(repoRoot, files.safety)
  },
  {
    key: "unifiedRouteRegistry",
    ok: ["/marketing/limited-time", "/marketing/new-user-bonus", "/marketing/coupons"].every((route) => source.routes.includes(route)) && source.app.includes("resolveFeatureRoutes"),
    source: relative(repoRoot, files.routes)
  },
  {
    key: "marketingPagesUseReadTask",
    ok: source.task.includes("runMarketingReadRequest") && source.pages.every((page) => page.includes("MarketingWorkspacePage")),
    source: relative(repoRoot, files.task)
  },
  {
    key: "marketingDispatcherInputAndIdentityGate",
    ok: source.task.includes("assertMarketingTaskInput(args)") && source.task.includes("assertMutationStoreActive") && source.task.includes("hash(baseContext)"),
    source: relative(repoRoot, files.task)
  },
  {
    key: "mutationOwnerTimeoutKeepsRunnerAlive",
    ok: mutationTimeoutBlock.includes("markOperationReconciling") && mutationTimeoutBlock.includes("requestRunnerCancellation") && !mutationTimeoutBlock.includes("destroyRunnerWindow"),
    source: relative(repoRoot, files.taskClient)
  },
  {
    key: "phase2To4ActionModelAndScheduler",
    ok: source.marketingTypes.includes("remove_products") && source.marketingTypes.includes("tool_renew") && source.marketingScheduler.includes("runDueMarketingSchedules") && source.marketingScheduler.includes("leaseUntil") && source.marketingPreflight.includes("runMarketingPreflight") && source.marketingReconciliation.includes("not_found") && source.marketingReconciliation.includes("conflict") && source.marketingSnapshot.includes("marketingAdapterSnapshotHash"),
    source: relative(repoRoot, files.marketingTypes)
  },
  {
    key: "marketingFixtureGate",
    ok: source.fixtures.includes("DOUDIAN_MARKETING_FIXTURES_OK") && source.fixtures.includes("missingRealCases") && source.fixtures.includes("real-session-capture") && source.fixtures.includes("unsafe integer must be stored as a string") && source.fixtures.includes("MARKETING_REQUIRE_REAL_FIXTURES") && source.fixtures.includes("writeGateClosed"),
    source: relative(repoRoot, files.fixtures)
  },
  {
    key: "genericFeatureRecordStoreIsWired",
    ok: text(workerPath).includes("remote_feature_records_v1") && text(nativeTypesPath).includes("remote_feature_records_v1") && text(repositoryPath).includes("remote_feature_records_v1"),
    source: relative(repoRoot, workerPath)
  },
  {
    key: "prefixUpdatedQueryIsWired",
    ok: text(workerPath).includes("records.queryByPrefix") && text(repositoryPath).includes("repositoryQueryByPrefix") && text(nativeTypesPath).includes("queryByPrefix"),
    source: relative(repoRoot, repositoryPath)
  },
  {
    key: "electronHasNoMarketingBusinessEndpoints",
    ok: !electronSource.match(/marketing\/promotion\/v1|createLimitTimeActivity|createNewUserBonus|createCoupon/),
    source: "electron-client/src"
  },
  {
    key: "marketingMutationsRemainSingleSend",
    ok: Object.values(adapter.policies?.marketing?.features || {}).every((feature) => Object.values(feature.writeActions || {}).every((contract) => {
      const mutation = adapter.requestPlans?.[contract?.mutationPlanKey];
      const reconcile = adapter.requestPlans?.[contract?.reconcilePlanKey];
      const prechecks = Array.isArray(contract?.precheckPlanKeys) ? contract.precheckPlanKeys : [];
      const deferredValidation = contract?.deferredValidation === true && adapter.requestPlans?.[contract?.validationPlanKey]?.mutation !== true;
      return mutation?.mutation === true && mutation?.maxAttempts === 1 && mutation?.retryOnHttpError === false && mutation?.retryOnBusinessFailure === false && mutation?.prepareRetryAttempts === 0 &&
        reconcile?.mutation !== true && (prechecks.length > 0 || deferredValidation) && prechecks.every((planKey) => adapter.requestPlans?.[planKey]?.mutation !== true);
    })),
    source: existsSync(adapterPath) ? relative(repoRoot, adapterPath) : relative(repoRoot, fallbackAdapterPath)
  },
  {
    key: "marketingWritesAdvertiseCompleteContractMatrix",
    ok: config.features?.marketingWriteActions?.enabled === true &&
      Object.entries(adapter.capabilities?.marketing?.features || {}).length === 3 &&
      Object.entries(adapter.capabilities.marketing.features).every(([feature, capability]) => {
        const policyActions = Object.keys(adapter.policies?.marketing?.features?.[feature]?.writeActions || {}).sort();
        const advertisedActions = Array.isArray(capability.writeActions) ? [...capability.writeActions].sort() : [];
        return capability.read === true && JSON.stringify(advertisedActions) === JSON.stringify(policyActions);
      }) &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.entityId?.paths?.includes("campagin_id") &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.startTime?.paths?.includes("begin_time") &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.productCount?.paths?.includes("product_total") &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.platformError?.paths?.includes("reject_msg") &&
      adapter.responseMappings?.marketing?.limited_time?.preflight?.rejectedItemPaths?.some((path) => path.includes("campaign_check_res")) &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.status?.valueMap?.[3] === "已失效" &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.status?.valueMap?.[4] === "已结束" &&
      adapter.responseMappings?.marketing?.limited_time?.fields?.status?.valueMap?.[6] === "处理中" &&
      adapter.responseMappings?.marketing?.limited_time?.reconciliation?.completeByDefault === false,
    source: existsSync(adapterPath) ? relative(repoRoot, adapterPath) : relative(repoRoot, fallbackAdapterPath)
  }
];

const failed = checks.filter((check) => !check.ok);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  status: failed.length ? "fail" : "ok",
  checks,
  summary: { checkCount: checks.length, failedCount: failed.length }
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(report.status === "ok" ? "DOUDIAN_MARKETING_CONTRACT_OK" : "DOUDIAN_MARKETING_CONTRACT_FAIL");
console.log(JSON.stringify({ status: report.status, failedCount: failed.length, outputPath: relative(repoRoot, outputPath) }, null, 2));
if (failed.length) process.exit(1);
