import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const packagesDir = join(artifactsDir, "release-packages");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");
const releaseCheckPath = join(artifactsDir, "release-check.json");
const packageIndexPath = join(packagesDir, "index.json");
const includeOptional = process.argv.includes("--include-optional");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function isHashBuiltArtifact(artifact) {
  return artifact && artifact.cache === "immutable-after-hash-build";
}

function hashedDeployPath(artifactPath, hashValue) {
  const normalizedPath = artifactPath.replace(/\\/g, "/");
  const slashIndex = normalizedPath.lastIndexOf("/");
  const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex + 1) : "";
  const filename = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";
  return `${directory}${stem}.${hashValue.slice(0, 12)}${extension}`;
}

function safePackageName(value) {
  return String(value || "release").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertRelativeSafe(artifactPath) {
  assert(typeof artifactPath === "string" && artifactPath.trim(), "artifact path must be a non-empty string");
  assert(!artifactPath.includes(".."), `artifact path must not escape release root: ${artifactPath}`);
  assert(!/^[a-z]+:\/\//i.test(artifactPath), `artifact path must be relative: ${artifactPath}`);
}

function assertInside(child, parent, label) {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  assert(
    resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${process.platform === "win32" ? "\\" : "/"}`),
    `${label} must stay inside ${resolvedParent}: ${resolvedChild}`
  );
}

function runReleaseGate() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "check-release.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(result.status === 0, "check-release.mjs failed; refusing to package release");
}

function listExistingPackages(currentPackageId) {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageId = entry.name;
      const manifest = join(packagesDir, packageId, "package-manifest.json");
      if (!existsSync(manifest)) {
        return {
          packageId,
          releaseId: packageId,
          path: rel(join(packagesDir, packageId)),
          generatedAt: "",
          artifactCount: 0,
          totalBytes: 0,
          current: packageId === currentPackageId
        };
      }
      const data = readJson(manifest);
      return {
        packageId,
        releaseId: data.releaseId || packageId,
        path: rel(join(packagesDir, packageId)),
        generatedAt: data.generatedAt || "",
        artifactCount: data.artifactCount || 0,
        hashedAssetCount: data.hashedAssets && data.hashedAssets.generatedCount || 0,
        totalBytes: data.totalBytes || 0,
        current: packageId === currentPackageId
      };
    })
    .sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
}

function buildMarkdown(report) {
  const artifactRows = report.artifacts.map((artifact) => (
    `| ${artifact.path} | ${artifact.deployArtifactPath} | ${artifact.type} | ${artifact.cache} | ${artifact.size} | ${artifact.sha256.slice(0, 12)} |`
  ));
  const hashedRows = report.hashedAssets.assets.map((asset) => (
    `| ${asset.sourcePath} | ${asset.hashedPath} | ${asset.shortHash} | ${asset.size} |`
  ));
  const omittedRows = report.omittedArtifacts.map((artifact) => (
    `| ${artifact.path} | ${artifact.type} | ${artifact.reason} |`
  ));

  return [
    "# Remote Web Release Package",
    "",
    `- releaseId: ${report.releaseId}`,
    `- generatedAt: ${report.generatedAt}`,
    `- deployRoot: ${report.deployRoot}`,
    `- artifactCount: ${report.artifactCount}`,
    `- hashedAssetCount: ${report.hashedAssets.generatedCount}/${report.hashedAssets.immutableArtifactCount}`,
    `- totalBytes: ${report.totalBytes}`,
    `- coexistenceStatus: ${report.coexistence.status}`,
    "",
    "## Required Deploy Artifacts",
    "",
    "| Source Path | Deploy Path | Type | Cache | Bytes | SHA256 |",
    "|---|---|---|---|---:|---|",
    ...artifactRows,
    "",
    "## Content Hash Assets",
    "",
    hashedRows.length ? "| Source Path | Hashed Deploy Path | Hash | Bytes |\n|---|---|---|---:|\n" + hashedRows.join("\n") : "None.",
    "",
    "## Optional Artifacts",
    "",
    omittedRows.length ? "| Path | Type | Reason |\n|---|---|---|\n" + omittedRows.join("\n") : "None.",
    "",
    "## Coexistence",
    "",
    `- packageRoot: ${report.coexistence.packageRoot}`,
    `- retainedPackages: ${report.coexistence.retainedPackageCount}`,
    `- minimumRetainedPackages: ${report.coexistence.minimumRetainedPackages}`,
    `- policy: ${report.coexistence.policy}`,
    "",
    "## Evidence",
    "",
    `- releaseCheck: ${report.evidence.releaseCheck}`,
    `- packageManifest: ${report.evidence.packageManifest}`,
    `- packageIndex: ${report.evidence.packageIndex}`
  ].join("\n");
}

mkdirSync(artifactsDir, { recursive: true });
mkdirSync(packagesDir, { recursive: true });

runReleaseGate();

const manifest = readJson(manifestPath);
const releaseCheck = readJson(releaseCheckPath);
const releaseId = manifest.releaseId;
const packageId = safePackageName(releaseId);
const packageDir = join(packagesDir, packageId);
const deployDir = join(packageDir, "deploy");
const evidenceDir = join(packageDir, "evidence");

assert(manifest.schemaVersion === 1, "release manifest schemaVersion must be 1");
assert(releaseCheck.ok === true, "release-check.json must be ok");
assert(releaseCheck.releaseId === releaseId, "release manifest and release-check releaseId mismatch");
assertInside(packageDir, packagesDir, "package directory");

if (existsSync(packageDir)) {
  assertInside(packageDir, packagesDir, "package directory");
  rmSync(packageDir, { recursive: true, force: true });
}

mkdirSync(deployDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const releaseCheckByPath = new Map((releaseCheck.artifacts || []).map((artifact) => [artifact.path, artifact]));
const includedArtifacts = [];
const omittedArtifacts = [];
const hashedAssets = [];

for (const artifact of manifest.artifacts || []) {
  assertRelativeSafe(artifact.path);
  const required = artifact.required !== false;
  const source = join(root, artifact.path);
  const exists = existsSync(source) && statSync(source).isFile();
  if (!required && !includeOptional) {
    omittedArtifacts.push({
      path: artifact.path,
      type: artifact.type,
      reason: exists ? "optional-not-included" : "optional-missing"
    });
    continue;
  }
  if (!exists) {
    assert(!required, `required artifact is missing: ${artifact.path}`);
    omittedArtifacts.push({
      path: artifact.path,
      type: artifact.type,
      reason: "optional-missing"
    });
    continue;
  }

  const sourceSize = statSync(source).size;
  const sourceHash = sha256(source);
  const deployArtifactPath = isHashBuiltArtifact(artifact) ? hashedDeployPath(artifact.path, sourceHash) : artifact.path;
  assertRelativeSafe(deployArtifactPath);

  const destination = join(deployDir, deployArtifactPath);
  assertInside(destination, deployDir, "deploy artifact destination");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);

  const destinationSize = statSync(destination).size;
  const destinationHash = sha256(destination);
  const checked = releaseCheckByPath.get(artifact.path);

  assert(sourceSize === destinationSize, `copied size mismatch: ${artifact.path}`);
  assert(sourceHash === destinationHash, `copied sha256 mismatch: ${artifact.path}`);
  if (checked && checked.sha256) {
    assert(checked.sha256 === sourceHash, `release-check sha256 mismatch: ${artifact.path}`);
  }

  if (isHashBuiltArtifact(artifact)) {
    assert(deployArtifactPath !== artifact.path, `immutable asset must use content-hashed deploy path: ${artifact.path}`);
    hashedAssets.push({
      sourcePath: artifact.path,
      hashedPath: deployArtifactPath,
      deployPath: rel(destination),
      algorithm: "sha256",
      sha256: sourceHash,
      shortHash: sourceHash.slice(0, 12),
      cache: artifact.cache || "",
      type: artifact.type,
      size: sourceSize
    });
  }

  includedArtifacts.push({
    path: artifact.path,
    deployArtifactPath,
    type: artifact.type,
    cache: artifact.cache || "",
    required,
    immutableHashed: isHashBuiltArtifact(artifact),
    size: sourceSize,
    sha256: sourceHash,
    deployPath: rel(destination)
  });
}

copyFileSync(releaseCheckPath, join(evidenceDir, "release-check.json"));
copyFileSync(manifestPath, join(evidenceDir, "release-manifest.source.json"));

const existingPackages = listExistingPackages(packageId);
const previousPackages = existingPackages.filter((item) => item.packageId !== packageId);
const generatedAt = new Date().toISOString();
const totalBytes = includedArtifacts.reduce((sum, artifact) => sum + artifact.size, 0);
const immutableArtifactCount = includedArtifacts.filter((artifact) => artifact.cache === "immutable-after-hash-build").length;
const hashedAssetsReport = {
  strategy: "sha256-filename",
  generatedAt,
  immutableArtifactCount,
  generatedCount: hashedAssets.length,
  allImmutableArtifactsCovered: immutableArtifactCount === hashedAssets.length,
  assets: hashedAssets
};
const coexistence = {
  packageRoot: rel(packagesDir),
  policy: "Keep prior release package directories and CDN assets until rollback TTL expires.",
  minimumRetainedPackages: 2,
  retainedPackageCount: previousPackages.length + 1,
  previousPackageCount: previousPackages.length,
  status: previousPackages.length >= 1 ? "ready" : "single-package-local-run",
  previousPackages: previousPackages.map((item) => ({
    packageId: item.packageId,
    releaseId: item.releaseId,
    path: item.path,
    generatedAt: item.generatedAt
  }))
};

const report = {
  schemaVersion: 1,
  packageId,
  releaseId,
  generatedAt,
  buildTime: manifest.buildTime,
  deployRoot: rel(deployDir),
  packageRoot: rel(packageDir),
  artifactCount: includedArtifacts.length,
  totalBytes,
  includeOptional,
  cachePolicy: manifest.cachePolicy || {},
  hashedAssets: hashedAssetsReport,
  entry: releaseCheck.entry,
  chihuConfig: releaseCheck.chihuConfig,
  rollback: releaseCheck.rollback,
  coexistence,
  artifacts: includedArtifacts,
  omittedArtifacts,
  evidence: {
    releaseCheck: rel(join(evidenceDir, "release-check.json")),
    sourceManifest: rel(join(evidenceDir, "release-manifest.source.json")),
    packageManifest: rel(join(packageDir, "package-manifest.json")),
    packageReport: rel(join(packageDir, "package-report.md")),
    packageIndex: rel(packageIndexPath)
  }
};

writeJson(join(packageDir, "package-manifest.json"), report);
writeFileSync(join(packageDir, "package-report.md"), buildMarkdown(report), "utf8");

const indexedPackages = listExistingPackages(packageId).filter((item) => item.packageId !== packageId).concat([{
  packageId,
  releaseId,
  path: rel(packageDir),
  generatedAt,
  artifactCount: includedArtifacts.length,
  hashedAssetCount: hashedAssetsReport.generatedCount,
  totalBytes,
  current: true
}]).sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));

writeJson(packageIndexPath, {
  schemaVersion: 1,
  updatedAt: generatedAt,
  packageRoot: rel(packagesDir),
  retainPolicy: {
    minimumRetainedPackages: 2,
    note: "Do not delete prior deploy roots or CDN assets before rollback TTL expires."
  },
  current: {
    packageId,
    releaseId,
    path: rel(packageDir)
  },
  packages: indexedPackages
});

console.log("RELEASE_PACKAGE_OK");
console.log(JSON.stringify({
  releaseId,
  packageId,
  artifactCount: report.artifactCount,
  totalBytes: report.totalBytes,
  deployRoot: report.deployRoot,
  packageManifest: report.evidence.packageManifest,
  packageIndex: report.evidence.packageIndex,
  hashedAssetCount: report.hashedAssets.generatedCount,
  hashBuildStatus: report.hashedAssets.allImmutableArtifactsCovered ? "covered" : "incomplete",
  coexistenceStatus: report.coexistence.status
}, null, 2));
