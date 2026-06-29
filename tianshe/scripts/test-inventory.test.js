const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildTestInventory,
  globToRegExp,
  parseArgs,
  writeInventory,
} = require('./test-inventory.js');

function makeRepo(files, rules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshe-test-inventory-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
  const rulesPath = path.join(root, 'rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8');
  return { root, rulesPath };
}

const baseRules = {
  schemaVersion: 1,
  tagPrefix: '@tianshe-test',
  requiredFields: ['area', 'layer', 'runtime'],
  allowed: {
    areas: ['browser', 'native', 'tooling'],
    layers: ['canary', 'unit'],
    runtimes: ['node', 'real-browser'],
  },
  rules: [
    { pattern: '**/*.test.ts', layer: 'unit', runtime: 'node' },
    { pattern: 'src/core/browser/**/*.test.ts', area: 'browser' },
    { pattern: 'scripts/**/*.test.js', area: 'tooling', layer: 'unit', runtime: 'node' },
  ],
};

describe('test-inventory', () => {
  it('parses CLI options and environment defaults', () => {
    const options = parseArgs(['--root=repo', '--rules', 'rules.json', '--output', 'out.json'], {});

    expect(options).toEqual(
      expect.objectContaining({
        root: 'repo',
        rulesPath: 'rules.json',
        outputPath: 'out.json',
        write: true,
      })
    );

    expect(parseArgs(['--no-write'], {}).write).toBe(false);
  });

  it('matches recursive glob patterns', () => {
    expect(globToRegExp('src/**/*.test.ts').test('src/core/foo.test.ts')).toBe(true);
    expect(globToRegExp('src/**/*.test.ts').test('src/core/deep/foo.test.ts')).toBe(true);
    expect(globToRegExp('scripts/*.test.js').test('scripts/tool.test.js')).toBe(true);
    expect(globToRegExp('scripts/*.test.js').test('scripts/deep/tool.test.js')).toBe(false);
  });

  it('classifies tests from rules and lets file header tags override them', () => {
    const { root, rulesPath } = makeRepo(
      {
        'src/core/browser/pool.test.ts': 'describe("pool", () => {});',
        'src/core/native/ffi.test.ts':
          '/* @tianshe-test area=native layer=canary runtime=real-browser tags=ffi,crash */\n',
        'scripts/tool.test.js': 'describe("tool", () => {});',
      },
      baseRules
    );

    try {
      const { inventory, errors } = buildTestInventory({ root, rulesPath });

      expect(errors).toEqual([]);
      expect(inventory.summary).toEqual({
        total: 3,
        byArea: { browser: 1, native: 1, tooling: 1 },
        byLayer: { canary: 1, unit: 2 },
        byRuntime: { node: 2, 'real-browser': 1 },
      });
      expect(inventory.tests.find((entry) => entry.area === 'native')).toEqual(
        expect.objectContaining({
          layer: 'canary',
          runtime: 'real-browser',
          source: 'header',
          tags: ['crash', 'ffi'],
        })
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a test file has no explicit area', () => {
    const { root, rulesPath } = makeRepo(
      {
        'src/unknown/new-feature.test.ts': 'describe("new", () => {});',
      },
      baseRules
    );

    try {
      const { errors } = buildTestInventory({ root, rulesPath });

      expect(errors).toEqual([
        'src/unknown/new-feature.test.ts is missing test inventory field: area',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a machine-readable inventory', () => {
    const { root, rulesPath } = makeRepo(
      {
        'scripts/tool.test.js': 'describe("tool", () => {});',
      },
      baseRules
    );
    const outputPath = path.join(root, 'qa-results', 'test-inventory.json');

    try {
      const { inventory, errors } = buildTestInventory({ root, rulesPath });
      expect(errors).toEqual([]);

      writeInventory(outputPath, inventory);

      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(written.tests).toHaveLength(1);
      expect(written.tests[0].path).toBe('scripts/tool.test.js');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
