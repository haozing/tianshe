import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const outputPath = join(repoRoot, "remote-web", "artifacts", "doudian-local-leakage-audit.json");
const adapterPath = join(repoRoot, "remote-web", "new-remote-web", "config", "doudian-adapter.json");

const scannedRoots = [
  join(repoRoot, "electron-client", "src")
];

const ignoredPathFragments = [
  "/smoke/",
  "\\smoke\\",
  // Stage 13 removes this legacy service. Stage 12 audits that no other
  // Electron surface leaks Doudian rules while the old service is still present.
  "/src/main/doudian/",
  "\\src\\main\\doudian\\"
];

const allowedFieldNamePatterns = [
  /"selectors\.headerShopName"/,
  /adapter\.selectors\?\.headerShopName/,
  /probeResult\?\.headerShopName/,
  /probeResult\.headerShopName/,
  /\bheaderShopName:/,
  /\badapter\.blockedSchemes\b/,
  /\bblockedSchemes\b/,
  /\bblockedKeywords\b/,
  /\bchooseEntriesUrl\b/,
  /\bheaderShopName\b/,
  /\broleItem\b/,
  /\broleStatus\b/,
  /\broleName\b/,
  /\bshopList\b/,
  /\bcurrentShop\b/,
  /\bbusinessCoreIndex\b/,
  /\bbusinessHomepage\b/,
  /\bbusinessWarnTicket\b/,
  /\bbusinessSmartActivity(?:Coupon|DirectDiscount|NewUserBonus)\b/,
  /\bbusinessCreditScoreBase\b/,
  /\bbusinessCreditScoreLevel\b/,
  /\bbusinessData\b/,
  /\bshopuserInfo\b/i,
  /\bgetShopUserInfo\b/,
  /\brequestPlanSteps\b/,
  /\bscriptKeys\b/
];

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function collectFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectFiles(fullPath, files);
    } else if (/\.(js|mjs|cjs|ts|tsx|json)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalizedNeedle(value) {
  return String(value || "").trim();
}

function uniqueNeedles(values) {
  return Array.from(new Set(values.map(normalizedNeedle)))
    .filter((value) => value.length >= 4)
    .filter((value) => !/^[a-zA-Z0-9_]+$/.test(value) || value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

function adapterNeedles(adapter) {
  const alwaysScan = [
    ...(adapter.blockedSchemes || [])
  ];
  const explicit = [
    adapter.origin,
    adapter.loginUrl,
    adapter.homeUrl,
    adapter.chooseEntriesUrl,
    adapter.cookieDomain,
    ...(Object.values(adapter.endpoints || {})),
    ...(adapter.cookieHintNames || []),
    ...(adapter.blockedKeywords || []),
    ...(adapter.blockedSchemes || []),
    ...(adapter.sign?.candidates || []),
    adapter.sign?.candidateKeyPattern,
    ...(adapter.sign?.enablePathList || []),
    ...(adapter.selectors?.headerShopName || []),
    adapter.selectors?.roleItem,
    adapter.selectors?.roleItemStrict,
    adapter.selectors?.roleStatus,
    adapter.selectors?.roleName,
    adapter.selectors?.roleNameStrict,
    adapter.selectors?.retryButton,
    ...(adapter.strategies?.homePageReadyPathHints || [])
  ];

  const derived = [];
  for (const value of explicit) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      derived.push(url.hostname, url.pathname);
    } catch {}
  }

  return Array.from(new Set([
    ...uniqueNeedles([...explicit, ...derived]),
    ...alwaysScan.map(normalizedNeedle).filter((value) => value.length >= 5 && value !== "video")
  ])).sort((a, b) => b.length - a.length);
}

function isAllowedFieldName(line, needle) {
  if (allowedFieldNamePatterns.some((pattern) => pattern.test(line))) {
    return true;
  }
  if (needle.includes("/") || needle.includes(".") || needle.includes(":") || needle.includes("[") || needle.includes("*")) {
    return false;
  }
  return false;
}

function scanFile(filePath, needles) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (ignoredPathFragments.some((fragment) => normalizedPath.includes(fragment.replace(/\\/g, "/")))) return [];
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const issues = [];

  lines.forEach((line, index) => {
    for (const needle of needles) {
      if (!line.includes(needle)) continue;
      if (isAllowedFieldName(line, needle)) continue;
      issues.push({
        file: rel(filePath),
        line: index + 1,
        needle,
        text: line.trim().slice(0, 220)
      });
    }
  });

  return issues;
}

const adapter = readJson(adapterPath);
const needles = adapterNeedles(adapter);
const files = scannedRoots.flatMap((root) => collectFiles(root));
const issues = files.flatMap((file) => scanFile(file, needles));
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  status: issues.length ? "fail" : "ok",
  adapterPath: rel(adapterPath),
  scannedRoots: scannedRoots.map(rel),
  needleCount: needles.length,
  fileCount: files.length,
  issueCount: issues.length,
  issues
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

console.log(report.status === "ok" ? "DOUDIAN_LOCAL_LEAKAGE_AUDIT_OK" : "DOUDIAN_LOCAL_LEAKAGE_AUDIT_FAIL");
console.log(JSON.stringify({
  status: report.status,
  issueCount: report.issueCount,
  outputPath: rel(outputPath)
}, null, 2));

if (issues.length) process.exit(1);
