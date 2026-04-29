#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'sbom.cdx.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageNameFromLockPath(lockPath, pkg) {
  if (pkg.name) return pkg.name;
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath;
}

function main() {
  const lock = readJson(LOCK_PATH);
  const pkg = readJson(PACKAGE_PATH);
  const components = [];

  for (const [lockPath, item] of Object.entries(lock.packages || {})) {
    if (!lockPath || !item || !item.version) continue;
    const name = packageNameFromLockPath(lockPath, item);
    const component = {
      type: 'library',
      'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${item.version}`,
      name,
      version: item.version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${item.version}`,
    };
    if (item.license) {
      component.licenses = [{ license: { id: item.license } }];
    }
    if (item.resolved) {
      component.externalReferences = [{ type: 'distribution', url: item.resolved }];
    }
    components.push(component);
  }

  components.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
  );

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: pkg.name,
        version: pkg.version,
      },
    },
    components,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  process.stdout.write(`[sbom] wrote ${path.relative(ROOT, OUTPUT_PATH)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[sbom] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
