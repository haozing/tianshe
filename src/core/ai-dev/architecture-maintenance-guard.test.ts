import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_SIZE_REPAIR_TARGETS,
  DIRECT_CONSOLE_CALL_BASELINE,
} from './architecture-baselines';

const HARD_SIZE_LIMIT = 900;
const SOURCE_ROOT = 'src';

const ARCHITECTURE_SIZE_NOTES: Record<string, string> = {
  'src/constants/fingerprint-defaults.ts':
    'Existing oversized static fingerprint defaults; split by data family when fingerprint presets are next touched.',
  'src/core/ai-dev/capabilities/browser-catalog.ts':
    'Existing oversized AI browser catalog; split by browser capability family during catalog modularization.',
  'src/core/ai-dev/capabilities/browser/handlers/action-verification.ts':
    'Existing oversized action verification handler; split by verification strategy during browser capability cleanup.',
  'src/core/ai-dev/capabilities/plugin-catalog.ts':
    'Existing oversized plugin catalog; split read/write/install capability groups during AI catalog cleanup.',
  'src/core/ai-dev/capabilities/profile-catalog.ts':
    'Existing oversized profile catalog; split profile lifecycle and runtime diagnostics during AI catalog cleanup.',
  'src/core/ai-dev/capabilities/session-catalog.ts':
    'Existing oversized session catalog; split session lifecycle, queue, and browser binding capability groups.',
  'src/core/ai-dev/orchestration/capability-registry.test.ts':
    'Existing oversized orchestration registry contract test; split capability families when adding new registry cases.',
  'src/core/ai-dev/orchestration/capability-registry.ts':
    'Existing oversized orchestration registry; split registry metadata and execution adapters during orchestration cleanup.',
  'src/core/ai-service/openai.ts':
    'Existing oversized OpenAI adapter; split request shaping, retry handling, and response parsing during AI service cleanup.',
  'src/core/browser-automation/integrated-browser.ts':
    'Existing oversized browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/browser-extension/extension-browser.ts':
    'Existing oversized extension browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/browser-pool/global-pool.ts':
    'Existing oversized global browser pool; split lifecycle, acquire queue, and diagnostics during pool refactor.',
  'src/core/browser-ruyi/ruyi-browser.ts':
    'Existing oversized Ruyi browser facade; ongoing plan extracts role capabilities and shared browser operation helpers.',
  'src/core/js-plugin/manager.test.ts':
    'Existing oversized plugin manager test; split lifecycle, install, and helper contracts when expanding coverage.',
  'src/core/js-plugin/namespaces/database.ts':
    'Existing oversized plugin database namespace; split import/export helpers and SQL execution adapters during plugin API cleanup.',
  'src/core/js-plugin/namespaces/profile.ts':
    'Existing oversized plugin profile namespace; split launch, pool stats, profile CRUD, and lease operations.',
  'src/core/js-plugin/plugin-loader.test.ts':
    'Existing oversized plugin loader test; split manifest, runtime, and dependency loader contracts.',
  'src/core/js-plugin/registry.ts':
    'Existing oversized plugin registry; split discovery, persistence, and dependency index responsibilities.',
  'src/core/logger.test.ts':
    'Existing oversized logger contract test; split sink, formatting, and redaction scenarios when touched.',
  'src/core/query-engine/builders/CleanBuilder.test.ts':
    'Existing oversized query builder test; split clean operation scenarios by transform family.',
  'src/core/query-engine/QueryEngine.ts':
    'Existing oversized query engine facade; ongoing plan moves builder execution into pipeline steps.',
  'src/core/query-engine/services/PreviewService.ts':
    'Existing oversized preview service; split preview operation families during query pipeline cleanup.',
  'src/core/query-engine/validators/ConfigValidator.ts':
    'Existing oversized config validator; split validation by query feature family.',
  'src/core/stealth/fingerprint-manager.test.ts':
    'Existing oversized fingerprint manager test; split fingerprint generation, cache, and override contracts.',
  'src/core/stealth/shared-scripts.test.ts':
    'Existing oversized stealth shared scripts test; split browser surface scenarios by script family.',
  'src/core/task-manager/pipeline/pipeline.test.ts':
    'Existing oversized task pipeline test; split queue, lifecycle, and retry contracts.',
  'src/core/task-manager/queue.test.ts':
    'Existing oversized task queue test; split queue ordering, retry, and cancellation scenarios.',
  'src/main/duckdb/__tests__/dataset-operations.integration.test.ts':
    'Existing oversized dataset integration test; split import, schema, row, and query operation suites.',
  'src/main/duckdb/__tests__/dataset-service.integration.test.ts':
    'Existing oversized dataset service integration test; split table lifecycle and query scenarios.',
  'src/main/duckdb/dataset-schema-service.ts':
    'Existing oversized dataset schema service; split column metadata, schema mutation, and validation paths.',
  'src/main/duckdb/dataset-service.ts':
    'Existing oversized dataset facade; ongoing plan moves storage/query/schema/tab responsibilities to subservices.',
  'src/main/duckdb/profile-service.ts':
    'Existing oversized profile service; split profile CRUD, pool metadata, and extension association logic.',
  'src/main/duckdb/utils.test.ts':
    'Existing oversized DuckDB utils test; split SQL identifier, statement, and validation contracts.',
  'src/main/ipc-handlers/dataset-handler.test.ts':
    'Existing oversized dataset IPC test; split dataset CRUD, query, schema, and import IPC contracts.',
  'src/main/ipc-handlers/file-handler.test.ts':
    'Existing oversized file IPC test; split dialog, storage, and import route contracts.',
  'src/main/ipc-handlers/profile-ipc-handler.ts':
    'Existing oversized profile IPC handler; split profile CRUD, group, and browser pool route factories during IPC cleanup.',
  'src/main/ipc-handlers/system-handler.ts':
    'Existing oversized system IPC handler; split logs, diagnostics, downloads, and shell routes during IPC cleanup.',
  'src/main/ipc-handlers/view-handler.test.ts':
    'Existing oversized view IPC test; split view lifecycle, bounds, cloud auth, and dock contracts.',
  'src/main/mcp-http-session-runtime.ts':
    'Existing oversized MCP session runtime; session state has been grouped and further route split remains planned.',
  'src/main/mcp-server-http.auth-invoke.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.browser-binding.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.mcp-surface.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.orchestration-routes.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/mcp-server-http.transport-session.test.ts':
    'Focused split from former MCP giant test; kept under 1500 lines by split contract.',
  'src/main/profile/browser-pool-integration-cloak.ts':
    'New Cloak Playwright adapter owns runtime launch plus advanced Playwright role bridges; split download, dialog, interception, and event helpers after real-browser smoke tests stabilize.',
  'src/main/profile/ruyi-firefox-client.test.ts':
    'Existing oversized Ruyi Firefox client test; split launch, connection, and protocol contracts.',
  'src/main/profile/ruyi-firefox-client.ts':
    'Existing oversized Ruyi Firefox client; split launch process, protocol client, and browser state adapter.',
  'src/main/sync/sync-local-apply-service.ts':
    'Existing oversized sync apply service; split account/site/tag/profile apply pipelines.',
  'src/renderer/src/components/AccountCenter/ExtensionPackagesPanel.tsx':
    'Existing oversized account-center panel; split package list, actions, and detail dialogs.',
  'src/renderer/src/components/AccountCenter/ProfileFormDialog.tsx':
    'Existing oversized profile form dialog; split form schema, fingerprint, extension, and proxy sections.',
  'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.crud-isolation.test.tsx':
    'Existing oversized dataset page test; split CRUD isolation scenarios by workflow.',
  'src/renderer/src/components/DatasetsPage/__tests__/DatasetsPage.tab-flow.test.tsx':
    'Existing oversized dataset page test; split tab flow, selection, and persistence scenarios.',
  'src/renderer/src/components/DatasetsPage/AddColumnDialog.tsx':
    'Existing oversized add-column dialog; split field editors and validation helpers.',
  'src/renderer/src/components/DatasetsPage/DatasetTable.tsx':
    'Existing oversized dataset table; split toolbar, data grid, selection, and pagination views.',
  'src/renderer/src/components/DatasetsPage/index.tsx':
    'Existing oversized datasets page; ongoing store split enables future view decomposition.',
  'src/renderer/src/components/DatasetsPage/panels/CleanPanel.tsx':
    'Existing oversized clean panel; split operation forms and preview result views.',
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/columns.tsx':
    'Existing oversized table column definitions; split action, display, and editor column groups.',
  'src/renderer/src/components/DatasetsPage/TanStackDataTable/index.tsx':
    'Existing oversized TanStack table wrapper; split virtual table, controls, and row operations.',
  'src/renderer/src/components/PluginMarket/PluginMarket.tsx':
    'Existing oversized plugin market page; split catalog, install flow, and package detail panels.',
  'src/renderer/src/stores/__tests__/datasetStore.test.ts':
    'Legacy dataset store compatibility suite; kept under 1500 lines by split contract.',
  'src/types/browser-interface.ts':
    'Existing oversized browser interface compatibility surface; role interfaces are being split out incrementally.',
  'src/types/js-plugin.d.ts':
    'Existing oversized plugin declaration file; split namespace declarations when plugin API versioning lands.',
};

const STATEMENT_RITUAL_BASELINE: Record<string, { prepare: number; destroySync: number }> = {};

const OBSERVE_WRAPPER_BASELINE: Record<string, number> = {
  'src/core/browser-automation/browser-facade-shared.ts': 1,
  'src/core/browser-automation/integrated-browser.ts': 1,
  'src/core/browser-extension/extension-browser.ts': 1,
  'src/core/browser-ruyi/ruyi-browser.ts': 1,
};

const NORMALIZE_SYNC_DEFINITION_ALLOWLIST = new Set([
  'src/main/duckdb/account-service.ts:normalizeSyncPermission',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncBoolean',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncInteger',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncOwnership',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncScope',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncString',
  'src/main/duckdb/sync-field-normalizer.ts:normalizeSyncTimestamp',
]);

const CATCH_ANY_BASELINE: Record<string, number> = {};

const HIGH_RISK_IPC_ROUTE_PERMISSION_EXPECTATIONS: Record<string, string> = {
  'file:upload': 'privileged',
  'file:delete': 'privileged',
  'file:open': 'privileged',
  'file:getImageData': 'privileged',
  'file:deleteDatasetFiles': 'privileged',
  'file:upload-from-path': 'privileged',
  'duckdb:import-records-from-base64': 'privileged',
  'duckdb:import-records-from-file': 'privileged',
  'internal-browser:get-devtools-config': 'internal',
  'internal-browser:set-devtools-config': 'internal',
  'download-image': 'privileged',
  'shell:openPath': 'privileged',
  'js-plugin:import': 'privileged',
  'cloud-catalog:plugins:install': 'privileged',
  'js-plugin:uninstall': 'privileged',
  'profile:delete': 'privileged',
  'profile:pool-launch': 'privileged',
  'profile:pool-show-browser': 'privileged',
  'profile:pool-destroy-profile-browsers': 'privileged',
  'browser-pool:set-config': 'privileged',
  'browser-pool:apply-preset': 'privileged',
  'browser-pool:reset-config': 'privileged',
};

const HIGH_RISK_IPC_ROUTES_REQUIRING_SCHEMA = new Set(
  Object.keys(HIGH_RISK_IPC_ROUTE_PERMISSION_EXPECTATIONS)
);

function collectSourceFiles(dir: string, extensions: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'release', 'release-build'].includes(entry.name)) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.has(getExtension(entry.name))) {
      files.push(normalizePath(fullPath));
    }
  }

  return files;
}

function getExtension(fileName: string): string {
  if (fileName.endsWith('.d.ts')) {
    return '.ts';
  }
  if (fileName.endsWith('.tsx')) {
    return '.tsx';
  }
  return fileName.endsWith('.ts') ? '.ts' : '';
}

function normalizePath(filePath: string): string {
  return relative(process.cwd(), filePath).replace(/\\/g, '/');
}

function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function countLines(source: string): number {
  return source.split(/\r?\n/).length;
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function isTestSourceFile(filePath: string): boolean {
  return (
    filePath.includes('/__tests__/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}

function countDirectConsoleCalls(source: string): number {
  return source.split(/\r?\n/).reduce((total, line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return total;
    }
    return total + countMatches(line, /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g);
  }, 0);
}

function getObjectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
    return null;
  }

  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return String(name.text);
  }

  return null;
}

function getStringPropertyValue(
  property: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile
): string | null {
  if (!ts.isPropertyAssignment(property)) {
    return null;
  }

  const initializer = property.initializer;
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.text;
  }

  if (ts.isIdentifier(initializer)) {
    return initializer.getText(sourceFile);
  }

  return null;
}

describe('architecture maintenance guardrails', () => {
  it('requires architecture notes for existing TypeScript files over the hard size limit', () => {
    const oversizedFiles = collectSourceFiles(SOURCE_ROOT, new Set(['.ts', '.tsx']))
      .map((filePath) => ({
        filePath,
        lines: countLines(readSource(filePath)),
      }))
      .filter((file) => file.lines > HARD_SIZE_LIMIT);

    const undocumented = oversizedFiles
      .filter((file) => !ARCHITECTURE_SIZE_NOTES[file.filePath]?.trim())
      .map((file) => `${file.filePath} (${file.lines} lines)`);
    const staleNotes = Object.keys(ARCHITECTURE_SIZE_NOTES).filter(
      (filePath) => !existsSync(filePath)
    );
    const missingRepairTargets = oversizedFiles
      .filter((file) => {
        const target = ARCHITECTURE_SIZE_REPAIR_TARGETS[file.filePath];
        return !target?.owner.trim() || !target.target.trim() || !target.exitCondition.trim();
      })
      .map((file) => `${file.filePath} (${file.lines} lines)`);
    const staleRepairTargets = Object.keys(ARCHITECTURE_SIZE_REPAIR_TARGETS).filter(
      (filePath) => !existsSync(filePath)
    );

    expect(undocumented).toEqual([]);
    expect(staleNotes).toEqual([]);
    expect(missingRepairTargets).toEqual([]);
    expect(staleRepairTargets).toEqual([]);
  });

  it('prevents direct console calls from growing while logger migration continues', () => {
    const consoleFiles = collectSourceFiles(SOURCE_ROOT, new Set(['.ts', '.tsx']))
      .filter((filePath) => !isTestSourceFile(filePath))
      .map((filePath) => ({
        filePath,
        count: countDirectConsoleCalls(readSource(filePath)),
      }))
      .filter((file) => file.count > 0);

    const unexpectedFiles = consoleFiles
      .filter((file) => DIRECT_CONSOLE_CALL_BASELINE[file.filePath] === undefined)
      .map((file) => `${file.filePath} (${file.count})`);
    const increasedBaseline = consoleFiles
      .filter((file) => file.count > (DIRECT_CONSOLE_CALL_BASELINE[file.filePath] ?? 0))
      .map(
        (file) =>
          `${file.filePath} (${file.count}/${DIRECT_CONSOLE_CALL_BASELINE[file.filePath] ?? 0})`
      );
    const staleBaseline = Object.keys(DIRECT_CONSOLE_CALL_BASELINE).filter(
      (filePath) => !existsSync(filePath)
    );

    expect(unexpectedFiles).toEqual([]);
    expect(increasedBaseline).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });

  it('prevents new DuckDB prepare/destroySync statement rituals outside the migration baseline', () => {
    const ritualFiles = collectSourceFiles('src/main', new Set(['.ts']))
      .filter((filePath) => !filePath.endsWith('.test.ts') && !filePath.endsWith('.spec.ts'))
      .filter((filePath) => filePath !== 'src/main/duckdb/statement-executor.ts')
      .map((filePath) => {
        const source = readSource(filePath);
        return {
          filePath,
          prepare: countMatches(source, /\bprepare\s*\(/g),
          destroySync: countMatches(source, /\bdestroySync\s*\(/g),
        };
      })
      .filter((file) => file.prepare > 0 && file.destroySync > 0);

    const unexpectedFiles = ritualFiles
      .filter((file) => !STATEMENT_RITUAL_BASELINE[file.filePath])
      .map((file) => `${file.filePath} (${file.prepare}/${file.destroySync})`);
    const increasedBaseline = ritualFiles
      .filter((file) => {
        const baseline = STATEMENT_RITUAL_BASELINE[file.filePath];
        return (
          baseline && (file.prepare > baseline.prepare || file.destroySync > baseline.destroySync)
        );
      })
      .map((file) => `${file.filePath} (${file.prepare}/${file.destroySync})`);

    expect(unexpectedFiles).toEqual([]);
    expect(increasedBaseline).toEqual([]);
  });

  it('keeps DuckDB transaction SQL behind the shared transaction helper', () => {
    const transactionFiles = collectSourceFiles('src/main', new Set(['.ts']))
      .filter((filePath) => !filePath.endsWith('.test.ts') && !filePath.endsWith('.spec.ts'))
      .filter((filePath) => filePath !== 'src/main/duckdb/utils.ts')
      .map((filePath) => ({
        filePath,
        count: countMatches(readSource(filePath), /\b(?:BEGIN TRANSACTION|COMMIT|ROLLBACK)\b/g),
      }))
      .filter((file) => file.count > 0)
      .map((file) => `${file.filePath} (${file.count})`);

    expect(transactionFiles).toEqual([]);
  });

  it('keeps normalizeSync definitions centralized instead of creating new service-local families', () => {
    const definitionPattern =
      /^\s*(?:export\s+)?(?:function\s+(normalizeSync[A-Za-z0-9_]*)|(?:private|protected|public)\s+(?:static\s+)?(normalizeSync[A-Za-z0-9_]*))\s*\(/gm;
    const definitions: string[] = [];

    for (const filePath of collectSourceFiles('src/main', new Set(['.ts']))) {
      if (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')) {
        continue;
      }

      const source = readSource(filePath);
      for (const match of source.matchAll(definitionPattern)) {
        definitions.push(`${filePath}:${match[1] ?? match[2]}`);
      }
    }

    const unexpectedDefinitions = definitions
      .filter((definition) => !NORMALIZE_SYNC_DEFINITION_ALLOWLIST.has(definition))
      .sort();

    expect(unexpectedDefinitions).toEqual([]);
  });

  it('allows browser observation wrappers only as thin adapters to the shared helper', () => {
    const wrapperPattern =
      /\b(?:export\s+)?(?:private\s+|protected\s+|public\s+)?async\s+(?:function\s+)?observeBrowserOperation\b/g;
    const wrappers = collectSourceFiles('src/core', new Set(['.ts']))
      .filter((filePath) => !filePath.endsWith('.test.ts') && !filePath.endsWith('.spec.ts'))
      .map((filePath) => ({
        filePath,
        count: countMatches(readSource(filePath), wrapperPattern),
      }))
      .filter((entry) => entry.count > 0);

    const unexpectedFiles = wrappers
      .filter((entry) => !OBSERVE_WRAPPER_BASELINE[entry.filePath])
      .map((entry) => `${entry.filePath} (${entry.count})`);
    const increasedBaseline = wrappers
      .filter((entry) => entry.count > (OBSERVE_WRAPPER_BASELINE[entry.filePath] ?? 0))
      .map((entry) => `${entry.filePath} (${entry.count})`);

    expect(unexpectedFiles).toEqual([]);
    expect(increasedBaseline).toEqual([]);
  });

  it('keeps browser pool reset awaitable and health checks typed', () => {
    const managerSource = readSource('src/core/browser-pool/pool-manager.ts');
    const globalPoolSource = readSource('src/core/browser-pool/global-pool.ts');
    const utilsSource = readSource('src/core/browser-pool/utils.ts');

    expect(managerSource).toMatch(/export\s+function\s+createBrowserPoolManager\b/);
    expect(managerSource).toMatch(/export\s+async\s+function\s+resetBrowserPoolManager\b/);
    expect(managerSource).not.toMatch(/instance\.stop\(\)\.catch/);
    expect(globalPoolSource).toContain('hasBrowserClosedStateProbe');
    expect(globalPoolSource).not.toMatch(/\(\s*browser\.browser\s+as\s+any\s*\)/);
    expect(utilsSource).toContain('hasBrowserResetCapability');
    expect(utilsSource).not.toMatch(/\(\s*browser\s+as\s+any\s*\)\.reset/);
  });

  it('keeps screenshot normalization shared and snapshot capture managers lazy-bound', () => {
    const integratedSource = readSource('src/core/browser-automation/integrated-browser.ts');
    const ruyiSource = readSource('src/core/browser-ruyi/ruyi-browser.ts');
    const snapshotSource = readSource('src/core/browser-automation/snapshot.ts');
    const screenshotUtilsSource = readSource('src/core/browser-automation/screenshot-utils.ts');

    for (const source of [integratedSource, ruyiSource]) {
      expect(source).not.toMatch(/\bfunction\s+normalizeScreenshotFormat\b/);
      expect(source).not.toMatch(/\bfunction\s+normalizeScreenshotCaptureMode\b/);
      expect(source).not.toMatch(/\bfunction\s+getMimeTypeForScreenshotFormat\b/);
      expect(source).toContain('screenshot-utils');
    }
    expect(screenshotUtilsSource).toContain('normalizeScreenshotFormat');
    expect(snapshotSource).toContain('getNetworkManager?:');
    expect(snapshotSource).toContain('getConsoleManager?:');
    expect(integratedSource).toContain('getNetworkManager: () => this.networkManager');
    expect(integratedSource).toContain('getConsoleManager: () => this.consoleManager');
    expect(integratedSource).not.toContain('networkManager: undefined');
    expect(integratedSource).not.toContain('consoleManager: undefined');
  });

  it('keeps query pipeline steps on explicit nextContext results', () => {
    const stepSource = readSource('src/core/query-engine/pipeline/QueryPipelineStep.ts');
    const pipelineSource = readSource('src/core/query-engine/pipeline/QueryPipeline.ts');
    const adapterSource = readSource('src/core/query-engine/pipeline/createBuilderStep.ts');
    const softDeleteStepSource = readSource(
      'src/core/query-engine/pipeline/createSoftDeleteStep.ts'
    );
    const queryEngineSource = readSource('src/core/query-engine/QueryEngine.ts');

    expect(stepSource).toContain('QueryPipelineStepResult');
    expect(stepSource).toContain('nextContext: SQLContext');
    expect(pipelineSource).toContain('copyContextInto');
    expect(adapterSource).toContain('const nextContext: SQLContext');
    expect(adapterSource).not.toMatch(/context\.ctes\.push/);
    expect(adapterSource).not.toMatch(/context\.currentTable\s*=/);
    expect(adapterSource).not.toMatch(/context\.availableColumns\s*=/);
    expect(softDeleteStepSource).toContain('nextContext');
    expect(queryEngineSource).toContain('createSoftDeleteStep');
    expect(queryEngineSource).not.toContain('applySoftDelete');
    expect(queryEngineSource).not.toContain('executeWithAhoCorasick');
    expect(queryEngineSource.indexOf('createSoftDeleteStep(this.logger)')).toBeLessThan(
      queryEngineSource.indexOf("key: 'filter'")
    );
  });

  it('keeps query field-reference validation outside QueryEngine orchestration', () => {
    const queryEngineSource = readSource('src/core/query-engine/QueryEngine.ts');
    const fieldValidatorSource = readSource(
      'src/core/query-engine/validators/FieldReferenceValidator.ts'
    );

    expect(queryEngineSource).toContain('FieldReferenceValidator.validate');
    expect(queryEngineSource).not.toContain("Filter field '");
    expect(queryEngineSource).not.toContain("Aggregate measure field '");
    expect(fieldValidatorSource).toContain('validateAggregate');
    expect(fieldValidatorSource).toContain('validateCompute');
  });

  it('keeps query builder sync and async contracts explicit', () => {
    const builderInterfaceSource = readSource('src/core/query-engine/interfaces/IQueryBuilder.ts');
    const mockDuckDbSource = readSource(
      'src/core/query-engine/__tests__/mocks/MockDuckDBService.ts'
    );

    expect(builderInterfaceSource).toContain('export type MaybePromise');
    expect(builderInterfaceSource).toContain('MaybePromise<string>');
    expect(builderInterfaceSource).toContain('MaybePromise<Set<string>>');
    expect(builderInterfaceSource).not.toMatch(/\basync\s+build\(context: SQLContext/);
    expect(builderInterfaceSource).not.toMatch(/\basync\s+getResultColumns\(context: SQLContext/);
    expect(mockDuckDbSource).toContain('tokenizeSql');
    expect(mockDuckDbSource).not.toContain('sql.match(');
  });

  it('keeps MCP and HTTP route registration options grouped by responsibility', () => {
    const mcpTypesSource = readSource('src/main/mcp-http-types.ts');
    const httpRoutesSource = readSource('src/main/http-route-registry.ts');

    expect(mcpTypesSource).toContain('export interface McpHttpRouteContext');
    expect(mcpTypesSource).toContain('routeContext: McpHttpRouteContext');
    expect(mcpTypesSource).toContain('authContext: McpAuthContext');
    expect(mcpTypesSource).toContain('browserBinding: McpBrowserBindingPort');
    expect(mcpTypesSource).toContain('invokeQueue: McpInvokeQueuePort');
    expect(mcpTypesSource).toContain('sessionLifecycle: McpSessionLifecyclePort');
    expect(mcpTypesSource).not.toMatch(/export interface RegisterMcpRoutesOptions\s*{[^}]*\bapp:/s);
    expect(mcpTypesSource).not.toMatch(
      /export interface RegisterMcpRoutesOptions\s*{[^}]*\btransports:/s
    );

    expect(httpRoutesSource).toContain('interface HttpServerRouteContext');
    expect(httpRoutesSource).toContain('interface HttpSessionRouteContext');
    expect(httpRoutesSource).toContain('interface HttpBrowserRouteContext');
    expect(httpRoutesSource).toContain('server: HttpServerRouteContext');
    expect(httpRoutesSource).toContain('sessions: HttpSessionRouteContext');
    expect(httpRoutesSource).toContain('browser: HttpBrowserRouteContext');
    expect(httpRoutesSource).not.toMatch(/interface RegisterHttpRoutesOptions\s*{[^}]*\bapp:/s);
    expect(httpRoutesSource).not.toMatch(
      /interface RegisterHttpRoutesOptions\s*{[^}]*\btransports:/s
    );
  });

  it('requires explicit permission metadata for every IPC route literal', () => {
    const violations: string[] = [];

    for (const filePath of collectSourceFiles('src/main/ipc-handlers', new Set(['.ts']))) {
      if (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')) {
        continue;
      }

      const source = readSource(filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      function visit(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = new Set(
            node.properties
              .map((property) => getObjectPropertyName(property))
              .filter((name): name is string => Boolean(name))
          );
          const looksLikeRoute =
            properties.has('channel') && properties.has('kind') && properties.has('handler');

          if (looksLikeRoute && !properties.has('permission')) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push(`${filePath}:${position.line + 1} route literal missing permission`);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it('requires high-risk IPC routes to declare the expected permission tier', () => {
    const violations: string[] = [];
    const seenRoutes = new Set<string>();

    for (const filePath of collectSourceFiles('src/main/ipc-handlers', new Set(['.ts']))) {
      if (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')) {
        continue;
      }

      const source = readSource(filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      function visit(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = new Map<string, ts.ObjectLiteralElementLike>();
          for (const property of node.properties) {
            const name = getObjectPropertyName(property);
            if (name) properties.set(name, property);
          }

          const channelProperty = properties.get('channel');
          const channel = channelProperty
            ? getStringPropertyValue(channelProperty, sourceFile)
            : null;
          const expectedPermission = channel
            ? HIGH_RISK_IPC_ROUTE_PERMISSION_EXPECTATIONS[channel]
            : undefined;

          if (channel && expectedPermission) {
            seenRoutes.add(channel);
            const permissionProperty = properties.get('permission');
            const actualPermission = permissionProperty
              ? getStringPropertyValue(permissionProperty, sourceFile)
              : null;
            if (actualPermission !== expectedPermission) {
              const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              violations.push(
                `${filePath}:${position.line + 1} ${channel} expected ${expectedPermission} permission, got ${actualPermission || 'none'}`
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    for (const channel of Object.keys(HIGH_RISK_IPC_ROUTE_PERMISSION_EXPECTATIONS)) {
      if (!seenRoutes.has(channel)) {
        violations.push(`${channel} missing route literal for permission guard`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('requires schema metadata for high-risk IPC routes', () => {
    const violations: string[] = [];
    const seenRoutes = new Set<string>();

    for (const filePath of collectSourceFiles('src/main/ipc-handlers', new Set(['.ts']))) {
      if (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')) {
        continue;
      }

      const source = readSource(filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );

      function visit(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = new Map<string, ts.ObjectLiteralElementLike>();
          for (const property of node.properties) {
            const name = getObjectPropertyName(property);
            if (name) properties.set(name, property);
          }

          const channelProperty = properties.get('channel');
          const channel = channelProperty
            ? getStringPropertyValue(channelProperty, sourceFile)
            : null;

          if (
            channel &&
            HIGH_RISK_IPC_ROUTES_REQUIRING_SCHEMA.has(channel) &&
            !properties.has('schema')
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push(`${filePath}:${position.line + 1} ${channel} missing schema`);
          }
          if (channel && HIGH_RISK_IPC_ROUTES_REQUIRING_SCHEMA.has(channel)) {
            seenRoutes.add(channel);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    for (const channel of HIGH_RISK_IPC_ROUTES_REQUIRING_SCHEMA) {
      if (!seenRoutes.has(channel)) {
        violations.push(`${channel} missing route literal for schema guard`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps dataset schema update IPC notifications behind the dataset route helper', () => {
    const routeUtilsSource = readSource('src/main/ipc-handlers/dataset-routes/route-utils.ts');
    const schemaRoutesSource = readSource('src/main/ipc-handlers/dataset-routes/schema-routes.ts');

    expect(countMatches(routeUtilsSource, /['"]dataset:schema-updated['"]/g)).toBe(1);
    expect(routeUtilsSource).toContain('function notifyDatasetSchemaUpdated');
    expect(routeUtilsSource).toContain('export function registerSchemaMutationRoute');
    expect(schemaRoutesSource).toContain("channel: 'duckdb:add-column'");
    expect(routeUtilsSource).not.toMatch(/\bsend\s*\(\s*['"]dataset:schema-updated['"]/);
    expect(schemaRoutesSource).not.toMatch(/\bsend\s*\(\s*['"]dataset:schema-updated['"]/);
  });

  it('keeps dataset delayed DuckDB dependencies behind explicit guards', () => {
    const datasetSource = readSource('src/main/duckdb/dataset-service.ts');
    const querySource = readSource('src/main/duckdb/dataset-query-service.ts');
    const exportSource = readSource('src/main/duckdb/dataset-export-service.ts');
    const exportPlanSource = readSource('src/main/duckdb/dataset-export-plan-builder.ts');

    expect(datasetSource).not.toMatch(/\[['"]queryEngine['"]\]/);
    expect(datasetSource).not.toMatch(/\bsetQueryEngine\b/);
    expect(datasetSource).not.toMatch(/\bsetExportQuerySQLBuilder\b/);
    expect(querySource).not.toMatch(/\bqueryEngine!/);
    expect(querySource).not.toMatch(/\bsetQueryEngine\b/);
    expect(querySource).toContain('requireQueryEngine');
    expect(exportSource).not.toMatch(/\bsetExportQuerySQLBuilder\b/);
    expect(exportPlanSource).toContain('requireExportQuerySQLBuilder');
  });

  it('keeps main service access inside AppRuntime instead of exported globals', () => {
    const source = readSource('src/main/index.ts');

    expect(source).not.toMatch(/export\s+function\s+getLogger\b/);
    expect(source).not.toMatch(/export\s+function\s+getDuckDBService\b/);
    expect(source).toContain('const appRuntime = new AppRuntime()');
  });

  it('keeps dataset record imports off the renderer Base64 fallback path', () => {
    const drawerSource = readSource('src/renderer/src/components/DatasetsPage/AddRecordDrawer.tsx');
    const policySource = readSource('src/renderer/src/components/DatasetsPage/importFilePolicy.ts');
    const attachmentSource = readSource(
      'src/renderer/src/components/DatasetsPage/fields/AttachmentField.tsx'
    );

    expect(drawerSource).not.toContain('arrayBufferToBase64');
    expect(drawerSource).not.toMatch(/\.arrayBuffer\s*\(/);
    expect(drawerSource).not.toContain('importDatasetRecordsFromBase64');
    expect(drawerSource).toContain('getNativePathForFile');
    expect(policySource).not.toContain('arrayBufferToBase64');
    expect(attachmentSource).not.toMatch(/\.arrayBuffer\s*\(/);
    expect(attachmentSource).toContain('uploadFromPath');
  });

  it('keeps DatasetService single-record insert logic centralized for batch reuse', () => {
    const source = readSource('src/main/duckdb/dataset-record-mutation-service.ts');
    const facade = readSource('src/main/duckdb/dataset-service.ts');

    expect(source).toContain('insertRecordInCurrentQueue');
    expect(facade).toContain('this.recordMutationService.insertRecord');
    expect(facade).toContain('this.materializationService.materializeCleanToNewColumns'); expect(facade).toContain('this.groupTabWorkflowService.cloneDatasetToGroupTab');
    expect(
      countMatches(
        source,
        /INSERT INTO \$\{tableName\} \(\$\{columnNames\}\) VALUES \(\$\{placeholders\}\)/g
      )
    ).toBe(1);
    expect(readSource('src/main/duckdb/__tests__/dataset-service.integration.test.ts')).not.toContain("it.skip('should use insertRecord for single record'");
  });

  it('keeps dataset local schema refresh markers inside store state', () => {
    const source = readSource('src/renderer/src/stores/dataset/optimisticSlice.ts');
    const storeSource = readSource('src/renderer/src/stores/datasetStore.ts');
    const testSource = readSource('src/renderer/src/stores/dataset/optimisticSlice.test.ts');

    expect(source).not.toMatch(/^const pendingLocalSchemaRefreshDatasets = new Set/m);
    expect(source).toContain('pendingLocalSchemaRefreshDatasets: Set<string>');
    expect(source).toContain('beginLocalPatch');
    expect(source).toContain('rollbackLocalPatch');
    expect(storeSource).toContain('pendingLocalSchemaRefreshDatasets: new Set()');
    expect(storeSource).toContain('localPatchTransaction: null');
    expect(testSource).toContain('scoped to each store instance');
    expect(testSource).toContain('rolls back a local patch transaction');
  });

  it('keeps dataset column name policy centralized and SQL quoting separate', () => {
    const schemaSource = readSource('src/main/duckdb/dataset-schema-service.ts');
    const serviceSource = readSource('src/main/duckdb/dataset-service.ts');
    const schemaRouteSource = readSource('src/main/ipc-handlers/dataset-routes/schema-routes.ts');
    const dialogSource = readSource('src/renderer/src/components/DatasetsPage/AddColumnDialog.tsx');

    expect(schemaSource).toContain('assertDatasetColumnNamePolicy');
    expect(schemaRouteSource).toContain('validateDatasetColumnNamePolicy');
    expect(dialogSource).toContain('DATASET_COLUMN_NAME_ALLOWED_PATTERN');
    expect(serviceSource).not.toMatch(/\bfunction validateColumnName\b/);
    expect(serviceSource).not.toContain('dangerousKeywords');
  });

  it('keeps main bootstrap mutable runtime service state inside AppRuntime', () => {
    const source = readSource('src/main/index.ts');
    const mutableRuntimeBindings = [
      'store',
      'duckdbService',
      'logger',
      'downloadManager',
      'windowManager',
      'viewManager',
      'jsPluginManager',
      'updateManager',
      'httpMcpServer',
      'httpServerStartPromise',
      'schedulerService',
      'extensionPackages',
      'disposeResourceMonitoring',
      'hookBus',
      'webhookSender',
    ];
    const reintroducedBindings = mutableRuntimeBindings.filter((binding) =>
      new RegExp(`^\\s*(?:export\\s+)?let\\s+${binding}\\b`, 'm').test(source)
    );

    expect(source).not.toMatch(/\bexport\s+let\b/);
    expect(reintroducedBindings).toEqual([]);
  });

  it('keeps AppRuntime on the service container migration path', () => {
    const source = readSource('src/main/app-runtime.ts');

    expect(source).toContain("import { ServiceContainer } from './runtime/service-container'");
    expect(source).toContain('readonly container = new ServiceContainer()');
    expect(source).toContain("from './runtime/readiness-registry'");
    expect(source).toContain('readonly readiness = new ReadinessRegistry()');
    expect(source).toContain('getRuntimeReadiness()');
    expect(readSource('src/main/bootstrap/shutdown-bootstrap.ts')).toContain("from '../runtime/shutdown-coordinator'");
  });

  it('prevents new production catch(any) sites while the legacy baseline is reduced', () => {
    const catchAnyPattern = /\bcatch\s*\(\s*\w+\s*:\s*any\s*\)/g;
    const catchAnyFiles = collectSourceFiles(SOURCE_ROOT, new Set(['.ts', '.tsx']))
      .filter(
        (filePath) =>
          !filePath.endsWith('.test.ts') &&
          !filePath.endsWith('.test.tsx') &&
          !filePath.endsWith('.spec.ts') &&
          !filePath.endsWith('.spec.tsx') &&
          !filePath.includes('/__tests__/')
      )
      .map((filePath) => ({
        filePath,
        count: countMatches(readSource(filePath), catchAnyPattern),
      }))
      .filter((file) => file.count > 0);

    const unexpectedFiles = catchAnyFiles
      .filter((file) => !CATCH_ANY_BASELINE[file.filePath])
      .map((file) => `${file.filePath} (${file.count})`);
    const increasedBaseline = catchAnyFiles
      .filter((file) => file.count > (CATCH_ANY_BASELINE[file.filePath] ?? 0))
      .map((file) => `${file.filePath} (${file.count})`);
    const staleBaseline = Object.keys(CATCH_ANY_BASELINE).filter(
      (filePath) => !existsSync(filePath)
    );

    expect(unexpectedFiles).toEqual([]);
    expect(increasedBaseline).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
