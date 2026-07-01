#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'generated', 'v4-governance-snapshot.json');
const RELEASE_GATE_PATH = path.join(ROOT, 'docs', 'evidence', 'v4-release-gate', 'latest.json');

function readJson(relativePath, absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    return {
      ok: false,
      path: relativePath,
      error: `Missing ${relativePath}. Run npm run v4:snapshots && npm run test:site-adapter-canary -- --suite all && npm run v4:release-gate.`,
    };
  }
  try {
    return {
      ok: true,
      path: relativePath,
      data: JSON.parse(fs.readFileSync(absolutePath, 'utf8')),
    };
  } catch (error) {
    return {
      ok: false,
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function statusLine(label, value) {
  return `- ${label}: ${value == null || value === '' ? 'unknown' : value}`;
}

function buildStatusSummary() {
  const snapshot = readJson(
    'docs/generated/v4-governance-snapshot.json',
    SNAPSHOT_PATH
  );
  const releaseGate = readJson(
    'docs/evidence/v4-release-gate/latest.json',
    RELEASE_GATE_PATH
  );
  if (!snapshot.ok || !releaseGate.ok) {
    return [
      '# v4 Status Summary',
      '',
      snapshot.ok ? '' : statusLine(snapshot.path, snapshot.error),
      releaseGate.ok ? '' : statusLine(releaseGate.path, releaseGate.error),
    ]
      .filter(Boolean)
      .join('\n');
  }

  const gates = releaseGate.data.gates || {};
  const governance = gates.governanceSnapshot || {};
  return [
    '# v4 Status Summary',
    '',
    statusLine('releaseGate.status', releaseGate.data.status),
    statusLine('releaseGate.blocking', (releaseGate.data.blocking || []).join(', ') || 'none'),
    statusLine('governance.status', governance.status),
    statusLine('publicCapabilities', governance.publicCapabilityTotal),
    statusLine('siteCapabilities', (governance.siteCapabilities || []).length),
    statusLine('siteAdapterRegistry', snapshot.data.siteAdapterRegistry?.total),
    statusLine('realCanary.status', gates.realCanary?.status),
    statusLine('siteAdapterCanary.status', gates.siteAdapterCanary?.status),
    statusLine('adapterRelease.status', gates.adapterRelease?.status),
    statusLine('procedureRelease.status', gates.procedureRelease?.status),
    statusLine('sideEffectPolicy.status', governance.sideEffectPolicy?.status),
    statusLine('datasetProvenancePolicy.status', governance.datasetProvenancePolicy?.status),
    statusLine('runtimeMaturityPolicy.status', governance.runtimeMaturityPolicy?.status),
    statusLine('publicSurfacePolicy.status', governance.publicSurfacePolicy?.status),
    '',
    'Sources:',
    `- ${snapshot.path}`,
    `- ${releaseGate.path}`,
    '- docs/evidence/site-adapter-canary/latest.json',
    '- docs/zg.v4-implementation-gap-analysis.zh-CN.md',
  ].join('\n');
}

function main() {
  process.stdout.write(`${buildStatusSummary()}\n`);
}

module.exports = {
  buildStatusSummary,
};

if (require.main === module) {
  main();
}
