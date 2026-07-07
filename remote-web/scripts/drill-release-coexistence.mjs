import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const remoteRoot = resolve(__dirname, "..");
const repoRoot = resolve(remoteRoot, "..");
const artifactsDir = join(remoteRoot, "artifacts");
const packagesDir = join(artifactsDir, "release-packages");
const packageIndexPath = join(packagesDir, "index.json");
const jsonOutputPath = join(artifactsDir, "release-coexistence-drill.json");
const mdOutputPath = join(artifactsDir, "release-coexistence-drill.md");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function safePackageName(value) {
  return String(value || "previous-local-drill").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertInside(child, parent, label) {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  const separator = process.platform === "win32" ? "\\" : "/";
  assert(
    resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${separator}`),
    `${label} must stay inside ${resolvedParent}: ${resolvedChild}`
  );
}

function parseArgs(argv) {
  const args = {
    previousId: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--previous-id") {
      args.previousId = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--previous-id=")) {
      args.previousId = value.slice("--previous-id=".length);
    }
  }
  return args;
}

function countFiles(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) count += countFiles(fullPath);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function replacePackagePath(value, oldPackageId, newPackageId) {
  return typeof value === "string" ? value.split(oldPackageId).join(newPackageId) : value;
}

function remapPackageManifest(manifest, previousPackageId, currentPackageId, generatedAt) {
  const output = JSON.parse(JSON.stringify(manifest));
  output.packageId = previousPackageId;
  output.generatedAt = generatedAt;
  output.packageRoot = replacePackagePath(output.packageRoot, currentPackageId, previousPackageId);
  output.deployRoot = replacePackagePath(output.deployRoot, currentPackageId, previousPackageId);
  output.coexistence = {
    packageRoot: rel(packagesDir),
    policy: "Local coexistence drill copy. Production must still keep real prior CDN assets until rollback TTL expires.",
    minimumRetainedPackages: 2,
    retainedPackageCount: 2,
    previousPackageCount: 0,
    status: "previous-local-drill",
    previousPackages: []
  };
  output.localDrill = {
    type: "release-package-coexistence",
    sourcePackageId: currentPackageId,
    generatedAt,
    productionEvidence: false,
    note: "This is a local rollback/coexistence drill package copied from the current deploy root."
  };

  if (output.hashedAssets && Array.isArray(output.hashedAssets.assets)) {
    output.hashedAssets.assets = output.hashedAssets.assets.map((asset) => ({
      ...asset,
      deployPath: replacePackagePath(asset.deployPath, currentPackageId, previousPackageId)
    }));
  }
  if (Array.isArray(output.artifacts)) {
    output.artifacts = output.artifacts.map((artifact) => ({
      ...artifact,
      deployPath: replacePackagePath(artifact.deployPath, currentPackageId, previousPackageId)
    }));
  }
  if (output.evidence) {
    output.evidence = Object.fromEntries(Object.entries(output.evidence).map(([key, value]) => [
      key,
      replacePackagePath(value, currentPackageId, previousPackageId)
    ]));
  }

  return output;
}

function updateCurrentManifest(manifest, previousMeta) {
  const output = JSON.parse(JSON.stringify(manifest));
  const previousPackages = [
    previousMeta,
    ...((output.coexistence && Array.isArray(output.coexistence.previousPackages)) ? output.coexistence.previousPackages : [])
      .filter((item) => item.packageId !== previousMeta.packageId)
  ];
  output.coexistence = {
    ...(output.coexistence || {}),
    packageRoot: rel(packagesDir),
    policy: "Keep prior release package directories and CDN assets until rollback TTL expires.",
    minimumRetainedPackages: 2,
    retainedPackageCount: previousPackages.length + 1,
    previousPackageCount: previousPackages.length,
    status: "ready-local-drill",
    previousPackages
  };
  output.localDrill = {
    type: "release-package-coexistence",
    previousPackageId: previousMeta.packageId,
    generatedAt: new Date().toISOString(),
    productionEvidence: false,
    note: "Local package coexistence is exercised; production still requires real prior CDN asset retention."
  };
  return output;
}

function renderMarkdown(report) {
  return [
    "# Remote Web Release Coexistence Drill",
    "",
    `- status: ${report.status}`,
    `- generatedAt: ${report.generatedAt}`,
    `- currentPackageId: ${report.current.packageId}`,
    `- previousPackageId: ${report.previous.packageId}`,
    `- packageCount: ${report.summary.packageCount}`,
    `- currentDeployFiles: ${report.current.deployFileCount}`,
    `- previousDeployFiles: ${report.previous.deployFileCount}`,
    "",
    "## Scope",
    "",
    "This is a local package coexistence and rollback drill. It proves the release package index can retain current and previous deploy roots locally. It does not prove production CDN retention.",
    "",
    "## Evidence",
    "",
    `- packageIndex: ${report.outputs.packageIndex}`,
    `- currentManifest: ${report.current.manifest}`,
    `- previousManifest: ${report.previous.manifest}`,
    `- json: ${report.outputs.json}`
  ].join("\n");
}

mkdirSync(packagesDir, { recursive: true });

if (!existsSync(packageIndexPath)) {
  throw new Error("release package index is missing; run node remote-web/scripts/package-release.mjs first");
}

const args = parseArgs(process.argv.slice(2));
const index = readJson(packageIndexPath);
const current = index.current || {};
const currentPackageId = current.packageId;
assert(currentPackageId, "package index current.packageId is missing");

const currentPackageDir = resolve(repoRoot, current.path || join(packagesDir, currentPackageId));
assertInside(currentPackageDir, packagesDir, "current package directory");
assert(existsSync(currentPackageDir), `current package directory does not exist: ${currentPackageDir}`);

const currentManifestPath = join(currentPackageDir, "package-manifest.json");
assert(existsSync(currentManifestPath), "current package manifest is missing");

const currentManifest = readJson(currentManifestPath);
const previousPackageId = safePackageName(args.previousId || `${currentPackageId}.previous-local-drill`);
const previousPackageDir = join(packagesDir, previousPackageId);
assertInside(previousPackageDir, packagesDir, "previous package directory");
assert(previousPackageDir !== currentPackageDir, "previous package directory must differ from current package directory");

if (existsSync(previousPackageDir)) {
  assertInside(previousPackageDir, packagesDir, "previous package directory");
  rmSync(previousPackageDir, { recursive: true, force: true });
}

cpSync(currentPackageDir, previousPackageDir, { recursive: true });

const generatedAt = new Date(Date.now() - 1000).toISOString();
const previousManifestPath = join(previousPackageDir, "package-manifest.json");
const previousManifest = remapPackageManifest(currentManifest, previousPackageId, currentPackageId, generatedAt);
writeJson(previousManifestPath, previousManifest);

const previousReportPath = join(previousPackageDir, "package-report.md");
writeFileSync(previousReportPath, [
  "# Remote Web Release Package Previous Local Drill",
  "",
  `- packageId: ${previousPackageId}`,
  `- sourcePackageId: ${currentPackageId}`,
  `- generatedAt: ${generatedAt}`,
  "- productionEvidence: false",
  "- note: local package coexistence drill copy"
].join("\n"), "utf8");

const previousMeta = {
  packageId: previousPackageId,
  releaseId: previousManifest.releaseId || current.releaseId || currentPackageId,
  path: rel(previousPackageDir),
  generatedAt,
  artifactCount: previousManifest.artifactCount || 0,
  hashedAssetCount: previousManifest.hashedAssets && previousManifest.hashedAssets.generatedCount || 0,
  totalBytes: previousManifest.totalBytes || 0,
  current: false,
  localDrill: true
};

const currentManifestUpdated = updateCurrentManifest(currentManifest, {
  packageId: previousMeta.packageId,
  releaseId: previousMeta.releaseId,
  path: previousMeta.path,
  generatedAt: previousMeta.generatedAt,
  localDrill: true
});
writeJson(currentManifestPath, currentManifestUpdated);

const currentMeta = {
  packageId: currentPackageId,
  releaseId: currentManifestUpdated.releaseId || current.releaseId || currentPackageId,
  path: rel(currentPackageDir),
  generatedAt: new Date().toISOString(),
  artifactCount: currentManifestUpdated.artifactCount || 0,
  hashedAssetCount: currentManifestUpdated.hashedAssets && currentManifestUpdated.hashedAssets.generatedCount || 0,
  totalBytes: currentManifestUpdated.totalBytes || 0,
  current: true
};

const otherPackages = Array.isArray(index.packages)
  ? index.packages.filter((item) => item.packageId !== currentPackageId && item.packageId !== previousPackageId)
  : [];
const packages = [...otherPackages, previousMeta, currentMeta]
  .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));
const updatedAt = new Date().toISOString();
writeJson(packageIndexPath, {
  ...index,
  updatedAt,
  current: {
    packageId: currentPackageId,
    releaseId: currentMeta.releaseId,
    path: rel(currentPackageDir)
  },
  packages
});

const currentDeployDir = join(currentPackageDir, "deploy");
const previousDeployDir = join(previousPackageDir, "deploy");
const report = {
  schemaVersion: 1,
  generatedAt: updatedAt,
  status: "ok",
  scope: "remote-web-release-coexistence-drill",
  summary: {
    packageCount: packages.length,
    minimumRetainedPackages: index.retainPolicy && index.retainPolicy.minimumRetainedPackages || 2,
    localDrillPackageCount: packages.filter((item) => item.localDrill).length,
    productionEvidence: false
  },
  current: {
    packageId: currentPackageId,
    path: rel(currentPackageDir),
    manifest: rel(currentManifestPath),
    deployRoot: rel(currentDeployDir),
    deployFileCount: existsSync(currentDeployDir) ? countFiles(currentDeployDir) : 0,
    packageBytes: statSync(currentManifestPath).size
  },
  previous: {
    packageId: previousPackageId,
    path: rel(previousPackageDir),
    manifest: rel(previousManifestPath),
    deployRoot: rel(previousDeployDir),
    deployFileCount: existsSync(previousDeployDir) ? countFiles(previousDeployDir) : 0,
    localDrill: true,
    productionEvidence: false
  },
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath),
    packageIndex: rel(packageIndexPath)
  },
  redaction: {
    cookieValuesIncluded: false,
    tokenValuesIncluded: false,
    responseBodiesIncluded: false
  }
};

writeJson(jsonOutputPath, report);
writeFileSync(mdOutputPath, renderMarkdown(report), "utf8");

console.log("RELEASE_COHABITATION_DRILL_OK".replace("COHABITATION", "COEXISTENCE"));
console.log(JSON.stringify({
  status: report.status,
  packageCount: report.summary.packageCount,
  currentPackageId: report.current.packageId,
  previousPackageId: report.previous.packageId,
  currentDeployFileCount: report.current.deployFileCount,
  previousDeployFileCount: report.previous.deployFileCount,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));
