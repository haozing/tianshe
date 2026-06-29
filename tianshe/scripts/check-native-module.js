/**
 * Post-install script to check native module dependencies
 * Verifies that selected native modules are properly installed.
 */

const fs = require('fs');
const path = require('path');

function readPackageJson() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function isDependency(pkg, name) {
  if (!pkg) return false;
  const sections = ['dependencies', 'optionalDependencies', 'devDependencies'];
  return sections.some((k) => pkg[k] && Object.prototype.hasOwnProperty.call(pkg[k], name));
}

const pkg = readPackageJson();

// Keep this list small and accurate: only check modules that are expected to be native.
const candidateNativeModules = [
  '@duckdb/node-api',
  '@gutenye/ocr-node',
  'sharp',
  'onnxruntime-node',
  'hnswlib-node',
  'koffi',
];

const nativeModules = candidateNativeModules.filter((name) => isDependency(pkg, name));

console.log('Checking native module dependencies...');

let allPresent = true;

if (!nativeModules.length) {
  console.log('No native modules configured for post-install check.');
  console.log('Post-install check complete.');
  process.exit(0);
}

for (const moduleName of nativeModules) {
  const modulePath = path.join(__dirname, '..', 'node_modules', ...moduleName.split('/'));

  if (fs.existsSync(modulePath)) {
    console.log(`✓ ${moduleName} - Found`);
  } else {
    console.warn(`⚠ ${moduleName} - Not found at ${modulePath}`);
    allPresent = false;
  }
}

if (allPresent) {
  console.log('All native modules are present.');
} else {
  console.warn('Some native modules may need to be rebuilt.');
  console.warn('If you encounter issues, try running: npm rebuild');
}

console.log('Post-install check complete.');
