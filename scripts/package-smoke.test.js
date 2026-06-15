const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs,
  verifyPackageLayout,
  REQUIRED_APP_ASAR_FILES,
} = require('./package-smoke.js');

const extractFile = vi.fn();
const asarApi = { extractFile };

function makePackageDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tianshe-package-smoke-test-'));
  const appDir = path.join(root, 'win-unpacked');
  const resourcesDir = path.join(appDir, 'resources');
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');

  fs.mkdirSync(unpackedRoot, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'tiansheai-open.exe'), '');
  fs.writeFileSync(path.join(resourcesDir, 'app.asar'), 'asar');

  const unpackedFiles = [
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
    'node_modules/koffi/build/koffi/win32_x64/koffi.node',
    'node_modules/hnswlib-node/build/Release/hnswlib.node',
    'node_modules/@gutenye/ocr-node/index.js',
    'node_modules/@duckdb/node-bindings-win32-x64/duckdb.node',
    'dist/core/ffi/isolated-worker.js',
    'dist/core/system-automation/cv/opencvjs-worker.js',
    'dist/main/duckdb/import-worker.js',
  ];

  for (const relativePath of unpackedFiles) {
    const fullPath = path.join(unpackedRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '');
  }

  return { root, appDir };
}

describe('package-smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractFile.mockImplementation((_asarPath, entryPath) => {
      if (!REQUIRED_APP_ASAR_FILES.includes(entryPath)) {
        throw new Error(`missing ${entryPath}`);
      }
      if (entryPath === 'dist/constants/http-api.js') {
        return Buffer.from('export const DEFAULT_HTTP_API_CONFIG = { enabled: false };');
      }
      return Buffer.from(`entry:${entryPath}`);
    });
  });

  it('parses CLI and environment overrides', () => {
    const options = parseArgs(
      ['--app-dir', 'C:\\pkg', '--exe-name=app.exe', '--launch', '--timeout-ms=1234'],
      {}
    );

    expect(options).toEqual(
      expect.objectContaining({
        appDir: 'C:\\pkg',
        exeName: 'app.exe',
        launch: true,
        timeoutMs: 1234,
      })
    );
  });

  it('verifies app.asar, unpacked workers, native modules, and default HTTP-off contract', () => {
    const { root, appDir } = makePackageDir();

    try {
      const layout = verifyPackageLayout({
        appDir,
        exeName: 'tiansheai-open.exe',
        asarApi,
      });

      expect(layout.exePath).toBe(path.join(appDir, 'tiansheai-open.exe'));
      expect(extractFile).toHaveBeenCalledWith(
        path.join(appDir, 'resources', 'app.asar'),
        'dist/constants/http-api.js'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when packaged HTTP defaults are not disabled', () => {
    const { root, appDir } = makePackageDir();
    extractFile.mockImplementation((_asarPath, entryPath) => {
      if (entryPath === 'dist/constants/http-api.js') {
        return Buffer.from('export const DEFAULT_HTTP_API_CONFIG = { enabled: true };');
      }
      return Buffer.from(`entry:${entryPath}`);
    });

    try {
      expect(() =>
        verifyPackageLayout({
          appDir,
          exeName: 'tiansheai-open.exe',
          asarApi,
        })
      ).toThrow(/enabled: false/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when an unpacked native module has no native artifact', () => {
    const { root, appDir } = makePackageDir();
    fs.rmSync(
      path.join(
        appDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'koffi',
        'build'
      ),
      { recursive: true, force: true }
    );

    try {
      expect(() =>
        verifyPackageLayout({
          appDir,
          exeName: 'tiansheai-open.exe',
          asarApi,
        })
      ).toThrow(/No native .node\/.dll artifact/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
