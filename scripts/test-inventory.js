#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_RULES_PATH = path.join(__dirname, 'test-inventory-rules.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'qa-results', 'test-inventory.json');
const TEST_FILE_PATTERN = /\.(test|spec)\.(cjs|js|mjs|ts|tsx)$/;
const SKIPPED_DIRS = new Set([
  '.codex-tmp',
  '.git',
  '.tmp',
  '.tmp-test-userdata-run',
  '.vscode',
  'artifacts',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'qa-results',
  'release',
  'release-build',
]);

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    root: env.TIANSHE_TEST_INVENTORY_ROOT || ROOT,
    rulesPath: env.TIANSHE_TEST_INVENTORY_RULES || DEFAULT_RULES_PATH,
    outputPath: env.TIANSHE_TEST_INVENTORY_OUTPUT || DEFAULT_OUTPUT_PATH,
    write: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[++index];
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--rules') {
      options.rulesPath = argv[++index];
    } else if (arg.startsWith('--rules=')) {
      options.rulesPath = arg.slice('--rules='.length);
    } else if (arg === '--output') {
      options.outputPath = argv[++index];
    } else if (arg.startsWith('--output=')) {
      options.outputPath = arg.slice('--output='.length);
    } else if (arg === '--no-write') {
      options.write = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function walkTestFiles(root, relativeDir = '') {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = normalizePath(path.posix.join(normalizePath(relativeDir), entry.name));
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...walkTestFiles(root, relativePath));
      }
      continue;
    }
    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }

  source += '$';
  return new RegExp(source);
}

function compileRules(rulesConfig) {
  return (rulesConfig.rules || []).map((rule) => ({
    ...rule,
    matcher: globToRegExp(rule.pattern),
  }));
}

function parseHeaderTags(root, relativePath, tagPrefix) {
  const fullPath = path.join(root, relativePath);
  const source = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).slice(0, 20).join('\n');
  const tagLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes(tagPrefix));

  if (!tagLine) return {};

  const tagStart = tagLine.indexOf(tagPrefix);
  const body = tagLine.slice(tagStart + tagPrefix.length).replace(/\*\/\s*$/, '').trim();
  const metadata = {};
  for (const token of body.split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1).replace(/^["']|["']$/g, '');
    metadata[key] = value;
  }
  return metadata;
}

function mergeClassification(target, source) {
  for (const key of ['area', 'layer', 'runtime']) {
    if (typeof source[key] === 'string' && source[key].trim()) {
      target[key] = source[key].trim();
    }
  }

  if (Array.isArray(source.tags)) {
    target.tags = Array.from(new Set([...(target.tags || []), ...source.tags])).sort();
  } else if (typeof source.tags === 'string' && source.tags.trim()) {
    const tags = source.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    target.tags = Array.from(new Set([...(target.tags || []), ...tags])).sort();
  }
}

function validateClassification(file, classification, rulesConfig) {
  const errors = [];
  const requiredFields = rulesConfig.requiredFields || ['area', 'layer', 'runtime'];

  for (const field of requiredFields) {
    if (!classification[field]) {
      errors.push(`${file} is missing test inventory field: ${field}`);
    }
  }

  const allowed = rulesConfig.allowed || {};
  for (const field of ['area', 'layer', 'runtime']) {
    const values = allowed[`${field}s`];
    if (Array.isArray(values) && classification[field] && !values.includes(classification[field])) {
      errors.push(
        `${file} has unsupported ${field} "${classification[field]}"; expected one of ${values.join(
          ', '
        )}`
      );
    }
  }

  return errors;
}

function classifyTestFile(root, relativePath, rulesConfig, compiledRules) {
  const classification = { path: relativePath, tags: [] };
  const matchedRules = [];

  for (const rule of compiledRules) {
    if (!rule.matcher.test(relativePath)) continue;
    matchedRules.push(rule.pattern);
    mergeClassification(classification, rule);
  }

  const headerTags = parseHeaderTags(root, relativePath, rulesConfig.tagPrefix || '@tianshe-test');
  mergeClassification(classification, headerTags);

  classification.source = headerTags.area || headerTags.layer || headerTags.runtime ? 'header' : 'rules';
  classification.rules = matchedRules;

  if (!classification.tags.length) {
    delete classification.tags;
  }

  return classification;
}

function summarizeInventory(entries) {
  const summary = {
    total: entries.length,
    byArea: {},
    byLayer: {},
    byRuntime: {},
  };

  for (const entry of entries) {
    summary.byArea[entry.area] = (summary.byArea[entry.area] || 0) + 1;
    summary.byLayer[entry.layer] = (summary.byLayer[entry.layer] || 0) + 1;
    summary.byRuntime[entry.runtime] = (summary.byRuntime[entry.runtime] || 0) + 1;
  }

  return summary;
}

function buildTestInventory(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const rulesPath = path.resolve(options.rulesPath || DEFAULT_RULES_PATH);
  const rulesConfig = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const compiledRules = compileRules(rulesConfig);
  const files = walkTestFiles(root);
  const entries = files.map((file) => classifyTestFile(root, file, rulesConfig, compiledRules));
  const errors = entries.flatMap((entry) => validateClassification(entry.path, entry, rulesConfig));
  const inventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ruleFile: normalizePath(path.relative(root, rulesPath)),
    summary: summarizeInventory(entries),
    tests: entries,
  };

  return { inventory, errors };
}

function writeInventory(outputPath, inventory) {
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs();
  const { inventory, errors } = buildTestInventory(options);

  if (errors.length > 0) {
    process.stderr.write(`[test-inventory] ${errors.length} issue(s):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  if (options.write) {
    writeInventory(options.outputPath, inventory);
  }

  process.stdout.write(
    `[test-inventory] classified ${inventory.summary.total} test file(s) across ${Object.keys(
      inventory.summary.byArea
    ).length} area(s)\n`
  );
  if (options.write) {
    process.stdout.write(
      `[test-inventory] wrote ${normalizePath(path.relative(options.root, options.outputPath))}\n`
    );
  }
}

module.exports = {
  DEFAULT_OUTPUT_PATH,
  DEFAULT_RULES_PATH,
  TEST_FILE_PATTERN,
  buildTestInventory,
  classifyTestFile,
  compileRules,
  globToRegExp,
  normalizePath,
  parseArgs,
  walkTestFiles,
  writeInventory,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[test-inventory] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
