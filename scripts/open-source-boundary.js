#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'open-source-manifest.json');

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinUrlPath(...parts) {
  return parts.join('/');
}

function readTextFileIfSupported(root, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const textExtensions = new Set([
    '.cjs',
    '.css',
    '.html',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.ts',
    '.tsx',
    '.txt',
    '.yml',
  ]);
  if (!textExtensions.has(extension)) return null;
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function readPackageJson(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function isOpenPackageRepo(root = ROOT) {
  return readPackageJson(root).name === '@tianshe/client-open';
}

function walk(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [normalizePath(relativePath)];
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const child = normalizePath(path.posix.join(normalizePath(relativePath), entry.name));
    if (entry.isDirectory()) {
      files.push(...walk(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function isUnder(candidate, parent) {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedParent = normalizePath(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
}

function collectManifestFiles(manifest) {
  const excluded = (manifest.exclude || []).map(normalizePath);
  const selected = new Set();

  for (const entry of manifest.include || []) {
    for (const file of walk(normalizePath(entry))) {
      if (!excluded.some((exclude) => isUnder(file, exclude))) {
        selected.add(file);
      }
    }
  }

  return Array.from(selected).sort();
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command !== process.execPath,
  });
  if (result.error) {
    return { ok: false, stdout: '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function collectGitTrackedAndUnignoredFiles() {
  const result = runCapture('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!result.ok) {
    return null;
  }
  return result.stdout
    .split('\0')
    .map(normalizePath)
    .filter(Boolean)
    .sort();
}

function shouldSkipActualWalk(relativePath) {
  const normalized = normalizePath(relativePath);
  const ignored = [
    '.codex-tmp',
    '.git',
    '.tmp',
    '.tmp-test-userdata-run',
    '.vscode',
    'artifacts',
    'chrome',
    'coverage',
    'data',
    'dist',
    'firefox',
    'node_modules',
    'qa-results',
    'release',
    'release-build',
  ];
  return ignored.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function collectActualRepoFiles() {
  const gitFiles = collectGitTrackedAndUnignoredFiles();
  if (gitFiles) {
    return gitFiles;
  }

  const files = [];
  const walkDir = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = normalizePath(path.posix.join(prefix, entry.name));
      if (shouldSkipActualWalk(relativePath)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  walkDir(ROOT);
  return files.sort();
}

function collectNpmPackFiles() {
  const result = runCapture('npm', ['pack', '--dry-run', '--json']);
  if (!result.ok) {
    throw new Error(
      `npm pack --dry-run failed:\n${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm pack --dry-run returned non-JSON output:\n${result.stdout.slice(0, 500)}`);
  }

  const packageInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(packageInfo?.files) ? packageInfo.files : [];
  return files
    .map((entry) => normalizePath(String(entry.path || '')))
    .filter(Boolean)
    .sort();
}

function verify(manifest, files) {
  const errors = [];
  const fileSet = new Set(files);

  for (const requiredFile of manifest.requiredFiles || []) {
    const normalized = normalizePath(requiredFile);
    if (!fileSet.has(normalized)) {
      errors.push(`required file is missing from open manifest: ${normalized}`);
    }
  }

  for (const file of files) {
    if ((manifest.forbiddenFiles || []).map(normalizePath).includes(file)) {
      errors.push(`forbidden file selected for open repo: ${file}`);
    }
    for (const forbiddenPrefix of manifest.forbiddenPrefixes || []) {
      if (file.startsWith(normalizePath(forbiddenPrefix).replace(/\/?$/, '/'))) {
        errors.push(`forbidden path selected for open repo: ${file}`);
      }
    }
  }

  if (isOpenPackageRepo()) {
    const packageJson = readPackageJson();
    for (const scriptName of manifest.requiredPackageScripts || []) {
      if (!packageJson.scripts || typeof packageJson.scripts[scriptName] !== 'string') {
        errors.push(`package.json missing required script: ${scriptName}`);
      }
    }
    if (String(packageJson.main || '').startsWith('dist/')) {
      errors.push('package.json main points at dist/ and makes npm pack include build output implicitly');
    }
  }

  return errors;
}

function isAllowedOpenStub(manifest, file) {
  const normalized = normalizePath(file);
  return new Set((manifest.allowedOpenStubFiles || []).map(normalizePath)).has(normalized);
}

function verifyActualFileSet(manifest, files, label) {
  const errors = [];
  const repoForbiddenPrefixes = [
    'server/',
    'src/edition/cloud/',
    'src/main/browser-extension-cloud/',
    'src/main/cloud-catalog/',
    'src/main/cloud-snapshot/',
    'src/main/plugin-market/',
    'src/main/ipc-handlers/cloud-sync/',
  ];
  const repoForbiddenFiles = [
    'src/main/ipc-handlers/browser-extension-cloud-handler.ts',
    'src/main/ipc-handlers/cloud-auth-handler.ts',
    'src/main/ipc-handlers/cloud-sync-handler.ts',
    'src/main/ipc-handlers/plugin-market-handler.ts',
  ];
  const forbiddenLiteralPatterns = [
    {
      name: 'legacy private sync API',
      pattern: new RegExp(escapeRegExp(joinUrlPath('', 'api', 'v1', 'airpa', 'sync', 'v1')), 'g'),
    },
    {
      name: 'private Airpa API prefix',
      pattern: new RegExp(escapeRegExp(joinUrlPath('', 'api', 'v1', 'airpa')), 'g'),
    },
    {
      name: 'Tianshe cloud API implementation path',
      pattern: new RegExp(
        escapeRegExp(joinUrlPath('', 'api', 'v1', 'tianshe', 'cloud')),
        'g'
      ),
    },
    {
      name: 'Aidian test host',
      pattern: new RegExp(escapeRegExp(['aidian', 'qidu', 'site'].join('.')), 'g'),
    },
    {
      name: 'private server source path',
      pattern: new RegExp(escapeRegExp(['server', ['go', 'admin'].join('-')].join('/')), 'g'),
    },
  ];

  for (const file of files) {
    const normalized = normalizePath(file.replace(/^package\//, ''));
    if (!isAllowedOpenStub(manifest, normalized)) {
      if (repoForbiddenFiles.includes(normalized)) {
        errors.push(`${label} contains forbidden private file: ${normalized}`);
      }
      for (const forbiddenPrefix of repoForbiddenPrefixes) {
        if (normalized.startsWith(forbiddenPrefix)) {
          errors.push(`${label} contains forbidden private path: ${normalized}`);
        }
      }
    }
  }

  for (const file of files) {
    const normalized = normalizePath(file.replace(/^package\//, ''));
    let text;
    try {
      text = readTextFileIfSupported(ROOT, normalized);
    } catch {
      text = null;
    }
    if (text === null) continue;
    for (const { name, pattern } of forbiddenLiteralPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        errors.push(`${label} ${normalized} contains forbidden marker: ${name}`);
      }
    }
  }

  if (label === 'npm package') {
    for (const file of files) {
      const normalized = normalizePath(file.replace(/^package\//, ''));
      if (normalized.startsWith('dist/')) {
        errors.push(`npm package contains build output: ${normalized}`);
      }
    }
  }

  return Array.from(new Set(errors)).sort();
}

function ensureInsideReleaseBuild(target) {
  const resolved = path.resolve(ROOT, target);
  const releaseRoot = path.resolve(ROOT, 'release-build');
  if (resolved !== releaseRoot && !resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error(`Refusing to export outside release-build: ${resolved}`);
  }
  return resolved;
}

function copyFiles(files, target) {
  const outputDir = ensureInsideReleaseBuild(target);
  fs.rmSync(outputDir, { recursive: true, force: true });
  for (const file of files) {
    const sourcePath = path.join(ROOT, file);
    const targetPath = path.join(outputDir, file);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  fs.writeFileSync(
    path.join(outputDir, 'OPEN_SOURCE_EXPORT.md'),
    [
      '# Tianshe Client Open Export',
      '',
      'This directory was generated from `scripts/open-source-manifest.json`.',
      'Run `npm ci`, `npm run typecheck`, `npm run test:open:full`, and `npm run build:open` before publishing.',
      '',
    ].join('\n'),
    'utf8'
  );
  applyOpenSourceOverlay(outputDir);
  scrubOpenSourceLiterals(outputDir);
  assertNoForbiddenLiterals(outputDir);
  return outputDir;
}

function writeText(root, relativePath, content) {
  const targetPath = path.join(root, normalizePath(relativePath));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${content.trim()}\n`, 'utf8');
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, JSON.stringify(value, null, 2));
}

function applyOpenSourceOverlay(outputDir) {
  const packagePath = path.join(outputDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.name = '@tianshe/client-open';
  packageJson.description = 'Open-source Tianshe client edition';
  packageJson.private = false;
  packageJson.engines = {
    node: '>=22',
  };
  packageJson.main = 'index.js';
  packageJson.repository = {
    type: 'git',
    url: 'https://github.com/tianshe-ai/tianshe-client-open.git',
  };
  packageJson.bugs = {
    url: 'https://github.com/tianshe-ai/tianshe-client-open/issues',
  };
  packageJson.homepage = 'https://github.com/tianshe-ai/tianshe-client-open#readme';
  packageJson.files = [
    'assets',
    'build',
    'docs',
    'examples',
    'index.js',
    'scripts',
    'src',
    'electron-builder.yml',
    'eslint.config.mjs',
    'postcss.config.js',
    'tailwind.config.js',
    'tsconfig.json',
    'tsconfig.main.json',
    'vite.config.ts',
    'vitest.config.ts',
    'README.md',
    'LICENSE',
  ];
  packageJson.scripts = {
    predev: 'node scripts/clean-main-dist.js && npm run build:main',
    dev: 'npm run dev:open',
    'dev:open': 'node scripts/run-with-edition.js open npm run dev:base',
    'dev:base': 'node scripts/run-dev-base.js',
    'dev:renderer': 'vite',
    'dev:main': 'tsc -p tsconfig.main.json --watch --preserveWatchOutput',
    'dev:electron':
      'wait-on -l http://127.0.0.1:5273 dist/main/index.js && node scripts/launch-electron.js --expose-gc .',
    build: 'npm run build:renderer && npm run build:main',
    'build:open': 'node scripts/build-edition.js open',
    'build:renderer': 'vite build',
    'build:main': 'node scripts/build-main-with-stamp.js',
    'package:open': 'npm run package:open:portable',
    'package:open:dir': 'npm run build:open && node scripts/package-electron.js --dir --publish never',
    'package:open:portable':
      'npm run build:open && node scripts/package-electron.js --win portable --x64 --publish never',
    'package:open:win':
      'npm run build:open && node scripts/package-electron.js --win --x64 --publish never',
    test: 'npm run test:open',
    'test:open': 'node scripts/test-edition.js open',
    'test:open:full': 'node scripts/test-edition.js open --full',
    typecheck: 'tsc --noEmit',
    lint: 'eslint .',
    'format:check': 'prettier --check "src/**/*.{ts,tsx,json}"',
    'verify:open-source-boundary': 'node scripts/open-source-boundary.js',
    'verify:ci':
      'npm run typecheck && npm run lint && npm run test:open:full && npm run verify:open-source-boundary && npm run build:open',
  };
  writeJson(outputDir, 'package.json', packageJson);

  writeText(
    outputDir,
    'index.js',
    `
const fs = require('node:fs');
const path = require('node:path');

const mainEntry = path.join(__dirname, 'dist', 'main', 'index.js');

if (!fs.existsSync(mainEntry)) {
  throw new Error(
    [
      'Missing Electron main build at dist/main/index.js.',
      'Run \`npm run build:main\` or \`npm run build:open\` before launching Electron from the repository root.',
    ].join(' ')
  );
}

require(mainEntry);
`
  );

  const packageLockPath = path.join(outputDir, 'package-lock.json');
  if (fs.existsSync(packageLockPath)) {
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    packageLock.name = packageJson.name;
    if (packageLock.packages?.['']) {
      packageLock.packages[''].name = packageJson.name;
      packageLock.packages[''].version = packageJson.version;
    }
    writeJson(outputDir, 'package-lock.json', packageLock);
  }

  const manifestPath = path.join(outputDir, 'scripts/open-source-manifest.json');
  const exportManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  exportManifest.include = Array.from(
    new Set([
      ...(exportManifest.include || []),
      'docs/plugin-helpers-reference.md',
      'examples/minimal-plugin',
    ])
  );
  exportManifest.requiredPackageScripts = [
    'dev:open',
    'build:open',
    'package:open:portable',
    'test:open',
    'test:open:full',
    'verify:open-source-boundary',
    'verify:ci',
  ];
  exportManifest.allowedOpenStubFiles = [
    'src/constants/cloud.ts',
    'src/core/js-plugin/namespaces/cloud.ts',
    'src/core/js-plugin/namespaces/custom-field.ts',
    'src/main/cloud-auth/service.ts',
    'src/main/cloud-sync/context.ts',
    'src/main/sync/sync-engine-service.ts',
    'src/main/sync/sync-legacy-cloud-mapping-migrator.ts',
    'src/renderer/src/components/AccountCenter/CloudProfileImportDialog.tsx',
    'src/renderer/src/components/ActivityBar/CloudAuthDialog.tsx',
    'src/renderer/src/components/PluginMarket/CloudPluginCatalogPanel.tsx',
    'src/renderer/src/components/SettingsPage/CloudSnapshotPanel.tsx',
  ];
  writeJson(outputDir, 'scripts/open-source-manifest.json', exportManifest);

  writeText(
    outputDir,
    '.github/workflows/ci.yml',
    `
name: Open CI

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  verify:
    name: typecheck, lint, test, build
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Full open edition tests
        run: npm run test:open:full

      - name: Open source boundary
        run: npm run verify:open-source-boundary

      - name: Open build
        run: npm run build:open
`
  );

  writeText(
    outputDir,
    '.gitignore',
    `
# Dependencies
node_modules/

# Build outputs
dist/
release/
release-build/

# Native module build artifacts
src/native/*/build/
src/native/*/prebuilds/

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Runtime data
data/
.browser-profiles/
.tmp-test-userdata-run/
artifacts/
qa-results/

# DuckDB database files
*.duckdb
*.duckdb.wal
*.duckdb.tmp

# Test coverage
coverage/
.nyc_output/

# Temporary files
*.tmp
*.temp
.codex-tmp/
.tmp/
.cache/
tmp/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
desktop.ini

# Environment
.env
.env.local
.env.*.local

# Electron builder cache
.electron-builder-cache/

# Debug
*.tsbuildinfo
.eslintcache

# Large local runtimes and models
chrome/
firefox/
*.gguf
`
  );

  writeText(
    outputDir,
    'README.md',
    `
# Tianshe Client Open

Tianshe Client Open is the open-source desktop client foundation for local data management, browser automation, and JavaScript plugin development.

This repository is the upstream client core. Cloud login, cloud snapshot, cloud catalog, and private server integrations are intentionally stubbed or absent in the open edition.

## Requirements

- Node.js 22 or newer
- npm
- Windows x64 for packaged desktop builds

macOS and Linux source development may work where Electron and native dependencies are available, but packaging and native runtime bundles are currently validated for Windows x64.

## Install

\`\`\`bash
npm ci
\`\`\`

## Development

\`\`\`bash
npm run dev:open
\`\`\`

To launch Electron directly from the repository root, build the app first:

\`\`\`bash
npm run build:open
npx electron .
\`\`\`

## Verification

\`\`\`bash
npm run typecheck
npm run test:open:full
npm run build:open
\`\`\`

## Standalone Package

\`\`\`bash
npm run package:open:portable
\`\`\`

The portable Windows x64 build is written to \`release-build/\`.
For a faster unpacked packaging smoke test, run \`npm run package:open:dir\`.
Open packages use the \`tiansheai-open\` executable and \`com.tiansheai.client.open\` app id so they can coexist with private/cloud packages.

## Runtime Data

The open edition uses independent runtime identity and user data. Development launches through \`scripts/launch-electron.js\` default to an open package user data directory, such as \`%APPDATA%\\@tianshe\\client-open\` on Windows; packaged builds use the open app identity from \`electron-builder.yml\`.

For development launches through \`scripts/launch-electron.js\`, set \`TIANSHEAI_USER_DATA_DIR\` to override the user data directory.

## Repository Boundary

The open edition may contain a small allowlist of cloud stub files so shared UI and type contracts can compile. Those stubs must not contain real cloud endpoints, private server paths, auth flows, snapshot/catalog implementations, or deployment hostnames. Run this check before publishing:

\`\`\`bash
npm run verify:open-source-boundary
\`\`\`

The generic sync gateway in \`src/main/sync/sync-gateway.ts\` is an open protocol contract, not a private cloud implementation. Its ownership and limits are documented in \`docs/open-sync-contract.md\`.

## CI

Pull requests and main branch pushes run the generated Open CI workflow:

\`\`\`bash
npm run typecheck
npm run lint
npm run test:open:full
npm run verify:open-source-boundary
npm run build:open
\`\`\`

## Release Discipline

Open releases use SemVer and must be consumed by private cloud editions through a fixed version, tag, or tarball. Core client fixes land here first.

## Plugin Development

Plugin examples live in \`examples/\`. Runtime helper APIs live under \`src/core/js-plugin/\`.

## License

MIT
`
  );

  writeText(
    outputDir,
    'docs/README.md',
    `
# Tianshe Client Open Docs

This directory is the documentation entrypoint for the open-source client.

Useful starting points:

- \`README.md\` for install, development, and verification commands
- \`docs/open-sync-contract.md\` for the open sync gateway boundary
- \`docs/plugin-helpers-reference.md\` for the open plugin helper namespace surface
- \`examples/minimal-plugin\` for a small local plugin example
- \`src/core/js-plugin\` for runtime helper implementations
- \`src/types/js-plugin.d.ts\` for plugin-facing types

Cloud and private server integrations are not part of this edition.

Packaged desktop builds are currently validated for Windows x64. Open packages use the \`tiansheai-open\` executable and \`com.tiansheai.client.open\` app id so runtime data, shortcuts, and installer identity stay separate from private/cloud packages.
`
  );

  writeText(
    outputDir,
    'docs/plugin-helpers-reference.md',
    `
# Plugin Helpers Reference

This document is the open-edition reference index for \`PluginHelpers\`.

Each heading below maps to one public \`helpers.*\` namespace exposed by
\`src/core/js-plugin/helpers.ts\`. Cloud-related namespaces are present only as
open compatibility stubs unless explicitly documented otherwise.

## helpers.account

Local account records bound to browser profiles.

## helpers.advanced

Privileged Electron helpers. This namespace is lazily initialized and requires
explicit plugin permissions for real use.

## helpers.button

Dataset button field registration and management helpers.

## helpers.cloud

Open-edition compatibility stub. It reports a logged-out session and rejects
cloud auth setup.

## helpers.customField

Open-edition compatibility stub for cloud custom fields. Cloud-backed custom
field operations are unavailable in this edition.

## helpers.cv

OpenCV-backed image processing helpers.

## helpers.database

Local dataset query, import, export, schema, and record mutation helpers.

## helpers.ffi

Native FFI library loading, callback, and struct helpers.

## helpers.image

Perceptual hash and SSIM image comparison helpers.

## helpers.imageSearch

Local image feature extraction, template indexing, and similarity search.

## helpers.network

HTTP request and webhook helpers for plugins.

## helpers.ocr

OCR recognition, text search, preprocessing, and OCR worker pool helpers.

## helpers.onnx

ONNX model loading, inference, tensor, embedding, and image preprocessing
helpers.

## helpers.openai

OpenAI-compatible chat, streaming, embedding, file, batch, speech, image, and
moderation helpers.

## helpers.plugin

Plugin metadata, manifest, storage path, config, and data table introspection.

## helpers.profile

Browser profile management, fingerprint helpers, runtime descriptors, and
browser lease/launch helpers.

## helpers.raw

Raw Electron/WebContents access surface.

## helpers.savedSite

Saved site CRUD and platform initialization helpers.

## helpers.scheduler

Scheduled task creation, pause/resume, trigger, history, and disposal helpers.

## helpers.storage

Plugin configuration and plugin-scoped persistent data helpers.

## helpers.taskQueue

Plugin task queue creation, active queue listing, cancellation, and cleanup.

## helpers.ui

Renderer-facing UI helpers, including notification toast forwarding and current
dataset context.

## helpers.utils

Common utility helpers such as IDs, sleeps, chunking, validation, cloning, and
date formatting.

## helpers.vectorIndex

Local HNSW vector index creation, mutation, search, persistence, and rebuild
helpers.

## helpers.webhook

Plugin webhook registration, event emission, and cleanup helpers.

## helpers.window

Plugin modal window helpers.
`
  );

  writeText(
    outputDir,
    'docs/open-source-boundary.md',
    `
# Open Source Boundary

The open client is a source package for the local desktop core. It may include small cloud stub files only where shared imports require them.

Allowed stubs are recorded in \`scripts/open-source-manifest.json\` under \`allowedOpenStubFiles\`. These files must stay inert: no real cloud API paths, no private server imports, no deployment hostnames, and no token/session implementation beyond logged-out compatibility.

\`npm run verify:open-source-boundary\` validates three surfaces:

- the manifest-selected export file set
- the actual git-tracked/unignored repository file set
- the \`npm pack --dry-run\` file set

Open npm packages are source packages. Build output under \`dist/\` must not be included implicitly or explicitly.
`
  );

  writeText(
    outputDir,
    'docs/release-and-team-rules.md',
    `
# Release And Team Rules

## Versioning

- The open client publishes SemVer versions as \`@tianshe/client-open@X.Y.Z\`.
- Private cloud repositories must depend on an exact open version, git tag, or release tarball. Do not use floating ranges such as \`^1.0.0\` for production cloud releases.
- Canary builds use prerelease versions such as \`1.1.0-canary.1\` and must not be promoted without a passing Open CI run.

## Release Flow

1. Merge core client changes into the open repository.
2. Run Open CI: typecheck, lint, \`test:open:full\`, boundary verification, and \`build:open\`.
3. Publish or tag the open version.
4. Update the private repository to the exact open version.
5. Run private cloud CI before publishing the cloud edition.

## Bug Fix Rules

- Core desktop, local data, browser automation, and plugin runtime bugs are fixed in open first.
- Cloud auth, cloud snapshot, cloud catalog, private-admin integration, and private ACL bugs stay in private.
- Do not patch generated private workspaces or vendored open output directly. Change the source repo and regenerate.
`
  );

  writeText(
    outputDir,
    'examples/minimal-plugin/README.md',
    `
# Minimal Plugin Example

This example shows the smallest local JavaScript plugin shape for Tianshe Client Open.

Files:

- \`manifest.json\`: plugin metadata
- \`index.js\`: runtime entry

Use it as a starting point for local data and browser automation plugins.
`
  );

  writeText(
    outputDir,
    'examples/minimal-plugin/manifest.json',
    `
{
  "id": "minimal-plugin",
  "name": "Minimal Plugin",
  "version": "1.0.0",
  "description": "A minimal local plugin example for Tianshe Client Open.",
  "main": "index.js",
  "permissions": ["database", "ui"]
}
`
  );

  writeText(
    outputDir,
    'examples/minimal-plugin/index.js',
    `
module.exports = {
  async activate(context) {
    context.helpers.ui.info('Minimal plugin activated');
  },
};
`
  );

  writeText(
    outputDir,
    'src/edition/index.ts',
    `
import { normalizeTiansheEditionName, resolveTiansheEditionName } from './selection';
import type { TiansheEdition } from './types';
import { openEdition } from './open';

export type { TiansheEdition } from './types';
export {
  getTiansheEditionPublicInfo,
  normalizeTiansheEditionName,
  resolveTiansheEditionName,
} from './selection';

export function resolveTiansheEdition(rawName?: unknown): TiansheEdition {
  const name =
    rawName === undefined ? resolveTiansheEditionName() : normalizeTiansheEditionName(rawName);
  if (name !== 'open') {
    return openEdition;
  }
  return openEdition;
}
`
  );

  writeText(
    outputDir,
    'src/edition/selection.ts',
    `
export type TiansheEditionName = 'open' | 'cloud';

export interface TiansheEditionCapabilities {
  cloudAuth: boolean;
  cloudSnapshot: boolean;
  cloudCatalog: boolean;
}

export interface TiansheEditionPublicInfo {
  name: TiansheEditionName;
  capabilities: TiansheEditionCapabilities;
}

const DEFAULT_EDITION: TiansheEditionName = 'open';

export function normalizeTiansheEditionName(_raw: unknown): TiansheEditionName {
  return DEFAULT_EDITION;
}

export function resolveTiansheEditionName(): TiansheEditionName {
  return DEFAULT_EDITION;
}

export function getTiansheEditionPublicInfo(
  name: TiansheEditionName = resolveTiansheEditionName()
): TiansheEditionPublicInfo {
  const normalizedName = normalizeTiansheEditionName(name);
  return {
    name: normalizedName,
    capabilities: {
      cloudAuth: false,
      cloudSnapshot: false,
      cloudCatalog: false,
    },
  };
}
`
  );

  writeText(
    outputDir,
    'src/edition/edition-boundary.test.ts',
    `
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTiansheEditionPublicInfo, normalizeTiansheEditionName } from './selection';

const IMPORT_PATTERN = /^\\s*import(?:[\\s\\S]*?\\sfrom\\s+)?['"]([^'"]+)['"]/gm;
const RUNTIME_IMPORT_PATTERN = /^\\s*import\\s+(?!type\\b)(?:[\\s\\S]*?\\sfrom\\s+)?['"]([^'"]+)['"]/gm;

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return Array.from(source.matchAll(IMPORT_PATTERN)).map((match) => match[1].replace(/\\\\/g, '/'));
}

function extractRuntimeImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return Array.from(source.matchAll(RUNTIME_IMPORT_PATTERN)).map((match) =>
    match[1].replace(/\\\\/g, '/'),
  );
}

function source(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

describe('open/cloud edition boundary', () => {
  it('always resolves public edition input to the open edition', () => {
    expect(normalizeTiansheEditionName(undefined)).toBe('open');
    expect(normalizeTiansheEditionName('')).toBe('open');
    expect(normalizeTiansheEditionName('unexpected')).toBe('open');
    expect(normalizeTiansheEditionName('cloud')).toBe('open');
    expect(getTiansheEditionPublicInfo('cloud')).toEqual({
      name: 'open',
      capabilities: {
        cloudAuth: false,
        cloudSnapshot: false,
        cloudCatalog: false,
      },
    });
    expect(getTiansheEditionPublicInfo('open')).toEqual({
      name: 'open',
      capabilities: {
        cloudAuth: false,
        cloudSnapshot: false,
        cloudCatalog: false,
      },
    });
  });

  it('open edition provider does not import cloud, private, or server implementation modules', () => {
    const files = collectTsFiles('src/edition/open');
    const violations: string[] = [];

    for (const file of files) {
      for (const specifier of extractImports(file)) {
        if (
          specifier.includes('/cloud') ||
          specifier.includes('cloud-') ||
          specifier.includes('/plugin-market') ||
          specifier.includes('/browser-extension-cloud') ||
          specifier.includes('/server') ||
          specifier.includes('/private')
        ) {
          violations.push(\`\${relative(process.cwd(), file)} -> \${specifier}\`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('main entry registers cloud capabilities only through edition providers', () => {
    const imports = extractImports('src/main/index.ts');
    const forbidden = new Set([
      './ipc-handlers/cloud-auth-handler',
      './ipc-handlers/cloud-sync-handler',
      './ipc-handlers/browser-extension-cloud-handler',
      './ipc-handlers/plugin-market-handler',
      './cloud-sync/context',
      './plugin-market/service',
      './browser-extension-cloud/service',
    ]);

    expect(imports.filter((specifier) => forbidden.has(specifier))).toEqual([]);
    expect(source('src/main/index.ts')).toContain('resolveTiansheEdition');
    expect(source('src/main/index.ts')).toContain('tiansheEdition.cloudSnapshot.registerMainHandlers');
    expect(source('src/main/index.ts')).toContain('tiansheEdition.cloudCatalog.registerMainHandlers');
  });

  it('preload always exposes edition info and strips cloud APIs for open edition', () => {
    const preload = source('src/preload/index.ts');

    expect(preload).toContain("import type { TiansheEditionName, TiansheEditionPublicInfo } from '../edition/types';");
    expect(preload).toContain('const resolveTiansheEditionPublicInfo = (): TiansheEditionPublicInfo => {');
    expect(preload).toContain("process.env.TIANSHE_EDITION || process.env.AIRPA_EDITION || ''");
    expect(preload).not.toContain("name: 'open' as const");
    expect(preload).toContain('edition: tiansheEdition');
    expect(preload).toContain("if (tiansheEdition.name === 'open')");
    expect(preload).toContain('delete exposed.cloudAuth');
    expect(preload).toContain('delete exposed.cloudSnapshot');
    expect(preload).toContain('delete exposed.cloudPlugin');
    expect(preload).toContain('delete exposed.cloudBrowserExtension');
    expect(preload).toContain('delete extensionPackages.downloadCloudCatalogPackages');
  });

  it('preload runtime imports stay sandbox-compatible', () => {
    expect(extractRuntimeImports('src/preload/index.ts')).toEqual(['electron']);
  });
});
`
  );

  writeText(
    outputDir,
    'src/constants/cloud.ts',
    `
export const DEFAULT_CLOUD_BASE_URL = '';
export const CLOUD_WORKBENCH_URL = '';
export const CLOUD_WORKBENCH_VIEW_ID = 'pool:workbench:open';
export const CLOUD_WORKBENCH_PARTITION = 'persist:workbench:open';
export const CLOUD_AUTH_COOKIE_NAME = 'Admin-Token';
export const CLOUD_AUTH_EVENT_CHANNEL = 'cloud-auth:session-changed';

export function isLegacyCloudBaseUrl(_baseUrl: string): boolean {
  return false;
}

export function rewriteLegacyCloudBaseUrl(baseUrl: string): string {
  return baseUrl;
}
`
  );

  writeText(
    outputDir,
    'src/main/cloud-auth/service.ts',
    `
import Store from 'electron-store';
import type {
  CloudAuthChangeReason,
  CloudAuthPublicSession,
  CloudAuthSessionChangedEvent,
  CloudAuthStoreSchema,
  PersistedCloudAuthSession,
} from '../../types/cloud-sync';

interface CloudAuthLoginParams {
  username: string;
  password: string;
  captchaCode?: string;
  captchaUuid?: string;
}

type CloudAuthResetHandler = (event: CloudAuthSessionChangedEvent) => void | Promise<void>;

const store = new Store<CloudAuthStoreSchema<PersistedCloudAuthSession>>({
  name: 'cloud-auth-open',
});
const resetHandlers = new Set<CloudAuthResetHandler>();

function publicLoggedOutSession(): CloudAuthPublicSession {
  return {
    loggedIn: false,
    authRevision: 0,
  };
}

async function notifyReset(reason: CloudAuthChangeReason): Promise<CloudAuthPublicSession> {
  store.delete('session');
  const session = publicLoggedOutSession();
  const event: CloudAuthSessionChangedEvent = { session, reason };
  for (const handler of resetHandlers) {
    await handler(event);
  }
  return session;
}

export function getCloudAuthService() {
  return {
    getStore: getCloudAuthStore,
    registerResetHandler: registerCloudAuthResetHandler,
    getPersistedSession: getPersistedCloudAuthSession,
    getPublicSession: getPublicCloudAuthSession,
    fetchCaptcha: fetchCloudCaptcha,
    login: loginToCloud,
    logout: logoutFromCloud,
    invalidateSession: invalidateCloudAuthSession,
    commitSession: commitCloudAuthSession,
    isExpired: isCloudAuthSessionExpired,
  };
}

export function getCloudAuthStore(): Store<CloudAuthStoreSchema<PersistedCloudAuthSession>> {
  return store;
}

export function getPersistedCloudAuthSession(): PersistedCloudAuthSession | undefined {
  return undefined;
}

export async function getPublicCloudAuthSession(): Promise<CloudAuthPublicSession> {
  return publicLoggedOutSession();
}

export async function fetchCloudCaptcha(): Promise<{ uuid: string; imageBase64: string }> {
  throw new Error('Cloud auth is not available in the open-source edition');
}

export async function loginToCloud(_params: CloudAuthLoginParams): Promise<CloudAuthPublicSession> {
  throw new Error('Cloud auth is not available in the open-source edition');
}

export async function logoutFromCloud(): Promise<void> {
  await notifyReset('logout');
}

export async function invalidateCloudAuthSession(
  reason: CloudAuthChangeReason
): Promise<CloudAuthPublicSession> {
  return notifyReset(reason);
}

export async function commitCloudAuthSession(
  _session: Omit<PersistedCloudAuthSession, 'authSessionId' | 'authRevision' | 'updatedAt'>,
  reason: CloudAuthChangeReason
): Promise<CloudAuthPublicSession> {
  return notifyReset(reason);
}

export function isCloudAuthSessionExpired(_session?: PersistedCloudAuthSession | null): boolean {
  return false;
}

export function registerCloudAuthResetHandler(handler: CloudAuthResetHandler): () => void {
  resetHandlers.add(handler);
  return () => {
    resetHandlers.delete(handler);
  };
}
`
  );

  writeText(
    outputDir,
    'src/main/cloud-sync/context.ts',
    `
export function getCurrentCloudSyncScopeKey(): string {
  return 'company:0';
}

export function getCurrentCloudMappingScopeKey(): string {
  return getCurrentCloudSyncScopeKey();
}

export function setCurrentAccountBundleDirty(_dirty: boolean): void {}
`
  );

  writeText(
    outputDir,
    'src/main/sync/sync-legacy-cloud-mapping-migrator.ts',
    `
export interface SyncLegacyCloudMappingMigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

export interface SyncLegacyCloudMappingMigrationRunInfo
  extends SyncLegacyCloudMappingMigrationResult {
  startedAt: string;
  finishedAt?: string;
}

export async function migrateLegacyCloudMappings(): Promise<SyncLegacyCloudMappingMigrationResult> {
  return { migrated: 0, skipped: 0, errors: [] };
}

export function getLegacyCloudMappingMigrationStatus(): SyncLegacyCloudMappingMigrationRunInfo | null {
  return null;
}
`
  );

  writeText(
    outputDir,
    'src/main/sync/sync-engine-service.ts',
    `
import type {
  SyncArtifactDownloadUrlRequest,
  SyncArtifactDownloadUrlResponse,
  SyncArtifactUploadUrlRequest,
  SyncArtifactUploadUrlResponse,
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../types/sync-contract';

export interface SyncEngineOptions {}

export interface SyncEngineErrorRecord {
  at: number;
  source: string;
  code: string;
  message: string;
}

export interface SyncEngineErrorSummary {
  count: number;
  last?: SyncEngineErrorRecord;
}

export interface SyncEngineStatus {
  isRunning: boolean;
  autoSyncEnabled: boolean;
  errorSummary: SyncEngineErrorSummary;
}

export interface SyncEngineAutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface SyncGatewayClient {
  setToken(token?: string): void;
  setBaseUrl(baseUrl: string): void;
  handshake(request: SyncHandshakeRequest): Promise<SyncHandshakeResponse>;
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(request: SyncPullRequest): Promise<SyncPullResponse>;
  artifactUploadUrl?: (
    request: SyncArtifactUploadUrlRequest
  ) => Promise<SyncArtifactUploadUrlResponse>;
  artifactDownloadUrl?: (
    request: SyncArtifactDownloadUrlRequest
  ) => Promise<SyncArtifactDownloadUrlResponse>;
  uploadArtifactFile?: (
    uploadUrl: string,
    fileName: string,
    bytes: Uint8Array | ArrayBuffer
  ) => Promise<Record<string, unknown>>;
  downloadArtifactFile?: (downloadUrl: string) => Promise<Uint8Array>;
}

const DISABLED_ERROR = 'SyncEngine is not available in the open-source edition';

export class SyncEngineService {
  constructor(..._args: unknown[]) {}

  getStatus(): SyncEngineStatus {
    return {
      isRunning: false,
      autoSyncEnabled: false,
      errorSummary: { count: 0 },
    };
  }

  getAutoSyncConfig(): SyncEngineAutoSyncConfig {
    return { enabled: false, intervalMinutes: 0 };
  }

  setAutoSyncConfig(_config: Partial<SyncEngineAutoSyncConfig>): SyncEngineAutoSyncConfig {
    return this.getAutoSyncConfig();
  }

  async pushOnce(_limit?: number): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  async pullOnce(_pageSize?: number): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  async runOnce(): Promise<never> {
    throw new Error(DISABLED_ERROR);
  }

  startAutoSync(): void {}
  stopAutoSync(): void {}
  async shutdown(): Promise<void> {}
}
`
  );

  writeText(
    outputDir,
    'src/core/js-plugin/namespaces/cloud.ts',
    `
export interface CloudAuthConfig {
  baseUrl?: string;
  token?: string;
}

export interface CloudSessionUser {
  userId?: number;
  userName?: string;
  name?: string;
}

export interface CloudSessionInfo {
  loggedIn: boolean;
  baseUrl?: string;
  user?: CloudSessionUser;
}

export class CloudNamespace {
  constructor(private readonly pluginId: string) {}

  getSession(): CloudSessionInfo {
    void this.pluginId;
    return { loggedIn: false };
  }

  setAuth(_config: CloudAuthConfig): never {
    throw new Error('Cloud namespace is not available in the open-source edition');
  }

  clearAuth(): void {}
}
`
  );

  writeText(
    outputDir,
    'src/core/js-plugin/namespaces/custom-field.ts',
    `
export type CustomFieldStatus = 'ENABLED' | 'DISABLED';
export type CustomFieldIndexRebuildMode = 'none' | 'sync' | 'async';

export class CustomFieldNamespace {
  constructor(private readonly pluginId: string) {}

  private unavailable(): never {
    void this.pluginId;
    throw new Error('Cloud custom fields are not available in the open-source edition');
  }

  async queryRows(): Promise<never> {
    return this.unavailable();
  }

  async upsertRow(): Promise<never> {
    return this.unavailable();
  }

  async deleteRows(): Promise<never> {
    return this.unavailable();
  }
}
`
  );

  writeText(
    outputDir,
    'src/renderer/src/components/ActivityBar/CloudAuthDialog.tsx',
    `
interface CloudAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CloudAuthDialog(_props: CloudAuthDialogProps) {
  return null;
}
`
  );

  writeText(
    outputDir,
    'src/renderer/src/components/SettingsPage/CloudSnapshotPanel.tsx',
    `
export function CloudSnapshotPanel() {
  return null;
}
`
  );

  writeText(
    outputDir,
    'src/renderer/src/components/PluginMarket/CloudPluginCatalogPanel.tsx',
    `
export function CloudPluginCatalogPanel() {
  return null;
}
`
  );

  writeText(
    outputDir,
    'src/renderer/src/components/AccountCenter/CloudProfileImportDialog.tsx',
    `
export function CloudProfileImportDialog(_props: Record<string, unknown>) {
  return null;
}
`
  );
}

function listExportTextFiles(root) {
  const files = [];
  const textExtensions = new Set([
    '.cjs',
    '.css',
    '.html',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.ts',
    '.tsx',
    '.txt',
    '.yml',
  ]);

  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walkDir(fullPath);
        continue;
      }
      if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  };

  walkDir(root);
  return files;
}

function scrubOpenSourceLiterals(outputDir) {
  const exampleInvalidHost = ['example', 'invalid'].join('.');
  const exampleTestHost = ['example', 'test'].join('.');
  for (const filePath of listExportTextFiles(outputDir)) {
    const original = fs.readFileSync(filePath, 'utf8');
    const next = original
      .replaceAll(`http://${exampleInvalidHost}`, `http://${exampleTestHost}`)
      .replaceAll(`https://${exampleInvalidHost}`, `https://${exampleTestHost}`)
      .replaceAll(exampleInvalidHost, exampleTestHost)
      .replaceAll('server/private-admin', 'server/private-admin')
      .replaceAll('private-admin', 'private-admin')
      .replaceAll('private-admin', 'private-admin')
      .replaceAll('pool:workbench:open', 'pool:workbench:open');
    if (next !== original) {
      fs.writeFileSync(filePath, next, 'utf8');
    }
  }
}

function assertNoForbiddenLiterals(outputDir) {
  const forbidden = [
    ['example', 'invalid'].join('.'),
    `go${'-'}admin`,
    `go${'admin'}`,
    `server/${'go'}-admin`,
  ];
  const violations = [];
  for (const filePath of listExportTextFiles(outputDir)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbidden) {
      if (source.includes(marker)) {
        violations.push(`${path.relative(outputDir, filePath).replace(/\\/g, '/')} -> ${marker}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Open-source export still contains forbidden private marker(s):\n${violations
        .map((item) => `- ${item}`)
        .join('\n')}`
    );
  }
}

function main() {
  const manifest = readManifest();
  const files = collectManifestFiles(manifest);
  const errors = verify(manifest, files);
  if (isOpenPackageRepo()) {
    errors.push(...verifyActualFileSet(manifest, collectActualRepoFiles(), 'open repo'));
    errors.push(...verifyActualFileSet(manifest, collectNpmPackFiles(), 'npm package'));
  }
  if (errors.length > 0) {
    process.stderr.write(`[open-source-boundary] ${errors.length} issue(s):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  const exportIndex = process.argv.indexOf('--export');
  if (exportIndex >= 0) {
    const target = process.argv[exportIndex + 1] || path.join('release-build', manifest.name);
    const outputDir = copyFiles(files, target);
    const result = spawnSync(process.execPath, ['scripts/open-source-boundary.js'], {
      cwd: outputDir,
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      process.exit(result.status || 1);
    }
    process.stdout.write(
      `[open-source-boundary] exported ${files.length} files to ${path.relative(ROOT, outputDir)}\n`
    );
    return;
  }

  if (process.argv.includes('--list')) {
    for (const file of files) process.stdout.write(`${file}\n`);
  }
  process.stdout.write(`[open-source-boundary] verified ${files.length} open-source file(s)\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[open-source-boundary] ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
