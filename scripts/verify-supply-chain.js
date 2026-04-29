#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const POLICY_PATH = path.join(__dirname, 'supply-chain-policy.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageNameFromLockPath(lockPath, pkg) {
  if (pkg.name) return pkg.name;
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath;
}

function isCopyleftLicense(license) {
  return /\b(AGPL|GPL|LGPL)\b/i.test(String(license || ''));
}

function main() {
  const lock = readJson(LOCK_PATH);
  const policy = readJson(POLICY_PATH);
  const allowedHosts = new Set(policy.allowedResolvedHosts || []);
  const allowedGitPackages = policy.allowedGitPackages || {};
  const allowedExactResolved = policy.allowedExactResolved || {};
  const reviewedCopyleftPackages = new Set(policy.reviewedCopyleftPackages || []);
  const errors = [];

  for (const [lockPath, pkg] of Object.entries(lock.packages || {})) {
    if (!lockPath || !pkg || !pkg.resolved) continue;

    const packageName = packageNameFromLockPath(lockPath, pkg);
    const resolved = String(pkg.resolved);

    if (!pkg.integrity) {
      errors.push(`${lockPath} is missing integrity metadata`);
    }

    if (allowedExactResolved[lockPath]) {
      if (resolved !== allowedExactResolved[lockPath]) {
        errors.push(`${lockPath} resolved URL changed: ${resolved}`);
      }
    } else if (allowedGitPackages[lockPath]) {
      if (resolved !== allowedGitPackages[lockPath]) {
        errors.push(`${lockPath} git source changed: ${resolved}`);
      }
    } else {
      let host = '';
      try {
        host = new URL(resolved).host;
      } catch {
        errors.push(`${lockPath} has an unparseable resolved source: ${resolved}`);
      }
      if (host && !allowedHosts.has(host)) {
        errors.push(`${lockPath} resolved host is not allowed: ${host}`);
      }
    }

    if (isCopyleftLicense(pkg.license) && !reviewedCopyleftPackages.has(packageName)) {
      errors.push(`${lockPath} uses unreviewed copyleft license: ${pkg.license}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`[supply-chain] ${errors.length} issue(s):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('[supply-chain] package-lock sources and licenses verified\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[supply-chain] ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
