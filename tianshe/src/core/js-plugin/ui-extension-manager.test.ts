import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UIExtensionManager } from './ui-extension-manager';

describe('UIExtensionManager', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('injects a page-local logger shim for custom page scripts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'airpa-ui-page-'));
    writeFileSync(join(tempDir, 'index.html'), '<html><body><h1>Page</h1></body></html>');

    const duckdb = {
      executeSQLWithParams: vi.fn().mockResolvedValue([
        {
          plugin_id: 'plugin-a',
          page_id: 'page-1',
          source_type: 'local',
          source_path: 'index.html',
        },
      ]),
    };
    const manager = new UIExtensionManager({
      duckdb: duckdb as any,
      viewManager: {} as any,
    });

    const html = await manager.renderCustomPage('plugin-a', 'page-1', tempDir);

    expect(html).toContain('const pageLogger = {');
    expect(html).toContain('pageLogger.info');
    expect(html).toContain('plugin-page-ready');
    expect(html).not.toContain('logger.info(');
  });
});
