// @tianshe-test area=tooling layer=unit runtime=node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const {
  buildAdapterGate,
  buildProcedureGate,
  buildReleaseGateReport,
  buildSiteAdapterCanaryGate,
  checkRuntimeInstall,
  evaluateDatasetProvenancePolicy,
  evaluateRuntimeMaturityPolicy,
  evaluateSideEffectPolicy,
} = require('../../../scripts/v4-release-gate.js') as any;
const {
  SITE_ADAPTER_CANARY_SUITES,
} = require('../../../scripts/site-adapter-canary.js') as any;
const { buildStatusSummary } = require('../../../scripts/v4-status-summary.js') as any;

const root = path.resolve(__dirname, '../../..');

function writePassingSiteAdapterCanaryEvidence(tempRoot: string): string {
  const evidencePath = path.join(tempRoot, 'site-adapter-canary-latest.json');
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-23T00:00:00.000Z',
      status: 'passed',
      suite: 'all',
      code: 0,
      command: 'npx.cmd',
      args: ['vitest', 'run', '--no-file-parallelism'],
      suites: SITE_ADAPTER_CANARY_SUITES.map((suite: { id: string }) => suite.id),
    }),
    'utf8'
  );
  return evidencePath;
}

describe('v4 release gate', () => {
  it('reports missing browser runtimes as explicit environment gaps', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-'));
    const result = checkRuntimeInstall(tempRoot, { includeSystemPaths: false });

    expect(result.status).toBe('environment_gap');
    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'chrome', remediation: expect.stringContaining('Chrome') }),
        expect.objectContaining({ id: 'firefox', remediation: expect.stringContaining('Firefox') }),
      ])
    );
  });

  it('detects repo client browser runtimes without relying on system installs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-client-'));
    const clientChrome = path.join(tempRoot, 'client', 'chrome', 'chrome.exe');
    const clientFirefox = path.join(tempRoot, 'client', 'firefox', 'firefox.exe');
    fs.mkdirSync(path.dirname(clientChrome), { recursive: true });
    fs.mkdirSync(path.dirname(clientFirefox), { recursive: true });
    fs.writeFileSync(clientChrome, '');
    fs.writeFileSync(clientFirefox, '');

    const result = checkRuntimeInstall(tempRoot, { includeSystemPaths: false });

    expect(result.runtimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'chrome', installed: true, path: clientChrome }),
        expect.objectContaining({ id: 'firefox', installed: true, path: clientFirefox }),
      ])
    );
  });

  it('summarizes adapter release gate paths and evidence commands', () => {
    const gate = buildAdapterGate(root);

    expect(gate.status).toBe('configured');
    expect(gate.adapters.map((adapter: { id: string }) => adapter.id).sort()).toEqual([
      'books-to-scrape',
      'github-profile',
      'hacker-news',
      'npm-package',
      'open-library',
      'quotes-to-scrape',
      'wikipedia-article',
    ]);
    expect(gate.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'books-to-scrape',
          requiredChecks: expect.arrayContaining(['low-risk procedure runner']),
          evidenceCommands: expect.arrayContaining([
            expect.stringContaining('books-to-scrape.test.ts'),
          ]),
          paths: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/site-adapters/books-to-scrape/procedures/save-search-draft.ts',
              exists: true,
            }),
          ]),
        }),
        expect.objectContaining({
          id: 'github-profile',
          requiredChecks: expect.arrayContaining([
            'low-risk login Procedure runner',
            'low-risk issue draft Procedure runner',
            'high-risk issue Procedure confirmation gate',
          ]),
          paths: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
              exists: true,
            }),
            expect.objectContaining({
              path: 'src/site-adapters/github-profile/procedures/prepare-issue-draft.ts',
              exists: true,
            }),
            expect.objectContaining({
              path: 'src/site-adapters/github-profile/procedures/create-issue.ts',
              exists: true,
            }),
          ]),
        }),
        expect.objectContaining({
          id: 'open-library',
          requiredChecks: expect.arrayContaining(['low-risk procedure runner']),
          evidenceCommands: expect.arrayContaining([
            expect.stringContaining('open-library.test.ts'),
          ]),
          paths: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/site-adapters/open-library/procedures/prepare-search-draft.ts',
              exists: true,
            }),
          ]),
        }),
        expect.objectContaining({
          id: 'npm-package',
          capability: 'npm.extract_package_summary',
          evidenceCommands: expect.arrayContaining([
            expect.stringContaining('site-capability-catalog.test.ts'),
          ]),
          paths: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/site-adapters/npm-package/adapter.ts',
              exists: true,
            }),
          ]),
        }),
      ])
    );
  });

  it('summarizes official procedure release gate coverage', () => {
    const gate = buildProcedureGate();

    expect(gate.status).toBe('configured');
    expect(gate.total).toBeGreaterThanOrEqual(1);
    expect(gate.procedures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterId: 'books-to-scrape',
          id: 'save-search-draft',
          sideEffectLevel: 'low',
          requiredScopes: ['browser.write'],
          implemented: true,
        }),
        expect.objectContaining({
          adapterId: 'open-library',
          id: 'prepare-search-draft',
          sideEffectLevel: 'low',
          requiredScopes: ['browser.write'],
          implemented: true,
        }),
        expect.objectContaining({
          adapterId: 'github-profile',
          id: 'prepare-issue-draft',
          sideEffectLevel: 'low',
          requiredScopes: ['browser.write', 'profile.read'],
          implemented: true,
        }),
      ])
    );
    expect(gate).toMatchObject({
      missingImplementation: [],
      missingVerification: [],
      missingRequiredScopes: [],
      invalidSideEffectLevel: [],
      requiredChecks: expect.arrayContaining([
        'runner replay/resume evidence',
        'persistent resume store evidence',
        'repair publish target canary gate',
      ]),
    });
  });

  it('builds a release dashboard with package, canary, snapshot, and adapter gates', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-site-canary-'));
    const siteAdapterCanaryEvidencePath = writePassingSiteAdapterCanaryEvidence(tempRoot);
    const report = buildReleaseGateReport({ root, siteAdapterCanaryEvidencePath });

    expect(report.gates.packageResource.evidenceCommand).toBe('npm run test:package-smoke');
    expect(report.gates.realCanary.evidenceCommand).toContain('test:browser-canary');
    expect(report.gates.realCanary.coverage).toEqual(
      expect.arrayContaining([
        expect.stringContaining('electron-webcontents hidden partition'),
        expect.stringContaining('cloak runtime pool'),
        expect.stringContaining('profile cookie/localStorage persistence'),
      ])
    );
    if (report.gates.runtimeInstall.status === 'environment_gap') {
      expect(report.gates.realCanary.status).toBe('environment_gap');
      expect(report.gates.realCanary.environmentGaps.length).toBeGreaterThan(0);
    } else {
      expect(['configured', 'passed', 'failed']).toContain(report.gates.realCanary.status);
    }
    expect(report.gates.governanceSnapshot.path).toBe(
      'docs/generated/v4-governance-snapshot.json'
    );
    expect(report.gates.governanceSnapshot.publicSurfacePolicy).toMatchObject({
      status: 'ok',
      allowedDebugSurfaceNames: expect.arrayContaining(['browser_debug_state']),
      forbiddenPublicSurfaceNames: [],
      rawPlaywrightSurfaceNames: [],
    });
    expect(report.gates.governanceSnapshot.sideEffectPolicy).toMatchObject({
      status: 'ok',
      highRiskMissingConfirmation: [],
      datasetCommitMissingConfirmation: [],
      writeScopeMarkedReadOnly: [],
    });
    expect(report.gates.governanceSnapshot.datasetProvenancePolicy).toMatchObject({
      status: 'ok',
      forbiddenPublicRowMutationNames: [],
      stageWritePlanMissingProvenance: [],
      commitWritePlanMissingProvenance: [],
      commitWritePlanMissingConfirmation: [],
      siteDatasetWriteMissingStagedCommit: [],
      siteDatasetWriteMissingConfirmation: [],
    });
    expect(report.gates.governanceSnapshot.runtimeMaturityPolicy).toMatchObject({
      status: 'ok',
      supportedPlanned: [],
      productionCoreMissingStableRuntime: [],
      labRuntimeDynamicStable: [],
    });
    expect(
      report.gates.governanceSnapshot.runtimeMaturityPolicy.labRuntimeDynamicExperimental
    ).toEqual(
      expect.arrayContaining([
        'chromium-cloak-playwright:network.responseBody',
        'chromium-cloak-playwright:download.manage',
      ])
    );
    expect(report.gates.governanceSnapshot.repairScopeMatrixOk).toBe(true);
    expect(report.gates.adapterRelease.status).toBe('configured');
    expect(report.gates.procedureRelease).toMatchObject({
      status: 'configured',
      missingImplementation: [],
      missingVerification: [],
      missingRequiredScopes: [],
      invalidSideEffectLevel: [],
    });
    expect(report.gates.siteAdapterCanary).toMatchObject({
      status: 'passed',
      evidenceCommand: expect.stringContaining('test:site-adapter-canary'),
      latestEvidence: expect.objectContaining({
        status: 'passed',
        hasAllSuites: true,
      }),
    });
    expect(report.gates.siteAdapterCanary.coverage).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SiteAdapterRunner fixture/browser-snapshot'),
        expect.stringContaining('replay/resume'),
        expect.stringContaining('target canary'),
      ])
    );
  });

  it('prints a single v4 status summary from latest snapshot and release evidence', () => {
    const summary = buildStatusSummary();

    expect(summary).toContain('# v4 Status Summary');
    expect(summary).toContain('releaseGate.status');
    expect(summary).toContain('procedureRelease.status');
    expect(summary).toContain('siteAdapterCanary.status');
    expect(summary).toContain('datasetProvenancePolicy.status');
    expect(summary).toContain('runtimeMaturityPolicy.status');
    expect(summary).toContain('docs/zg.v4-implementation-gap-analysis.zh-CN.md');
  });

  it('fails runtime maturity policy when planned capabilities are marked supported', () => {
    const result = evaluateRuntimeMaturityPolicy({
      runtimeDescriptor: {
        browserCapabilityNames: ['snapshot.page'],
        capabilityMatrix: [
          {
            runtimeId: 'electron-webcontents',
            capabilityName: 'snapshot.page',
            supported: true,
            stability: 'planned',
            source: 'static-runtime',
            semanticChecks: ['snapshot.page.semantic-elements'],
          },
          {
            runtimeId: 'chromium-cloak-playwright',
            capabilityName: 'network.responseBody',
            supported: true,
            stability: 'stable',
            source: 'runtime',
            semanticChecks: ['network.responseBody.body'],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      supportedPlanned: ['electron-webcontents:snapshot.page'],
      labRuntimeDynamicStable: ['chromium-cloak-playwright:network.responseBody'],
    });
  });

  it('fails side effect policy when public high-risk tools lack confirmation gates', () => {
    const result = evaluateSideEffectPolicy({
      capabilityCatalog: {
        publicCapabilities: [
          {
            name: 'plugin_install',
            sideEffectLevel: 'high',
            requiredScopes: ['plugin.write'],
            inputFields: ['sourcePath'],
          },
          {
            name: 'dataset_commit_write_plan',
            sideEffectLevel: 'high',
            requiredScopes: ['dataset.write'],
            inputFields: ['plan'],
          },
          {
            name: 'profile_list',
            sideEffectLevel: 'none',
            requiredScopes: ['profile.read'],
            inputFields: [],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      highRiskMissingConfirmation: ['plugin_install', 'dataset_commit_write_plan'],
      datasetCommitMissingConfirmation: ['dataset_commit_write_plan'],
    });
  });

  it('fails dataset provenance policy when public row mutation bypasses staged write plans', () => {
    const result = evaluateDatasetProvenancePolicy({
      capabilityCatalog: {
        publicCapabilities: [
          {
            name: 'dataset_update_record',
            sideEffectLevel: 'low',
            requiredScopes: ['dataset.write'],
            inputFields: ['datasetId', 'rowId', 'updates'],
          },
          {
            name: 'dataset_stage_write_plan',
            sideEffectLevel: 'none',
            requiredScopes: ['dataset.write'],
            inputFields: ['datasetId', 'operations'],
          },
          {
            name: 'dataset_commit_write_plan',
            sideEffectLevel: 'high',
            requiredScopes: ['dataset.write'],
            inputFields: ['plan'],
          },
          {
            name: 'books_to_scrape.extract_product',
            sideEffectLevel: 'low',
            requiredScopes: ['browser.read', 'dataset.write'],
            inputFields: ['url', 'datasetId'],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      forbiddenPublicRowMutationNames: ['dataset_update_record'],
      stageWritePlanMissingProvenance: ['dataset_stage_write_plan'],
      commitWritePlanMissingProvenance: ['dataset_commit_write_plan'],
      commitWritePlanMissingConfirmation: ['dataset_commit_write_plan'],
      siteDatasetWriteCapabilities: ['books_to_scrape.extract_product'],
      siteDatasetWriteMissingStagedCommit: ['books_to_scrape.extract_product'],
      siteDatasetWriteMissingConfirmation: ['books_to_scrape.extract_product'],
    });
  });

  it('fails the governance gate when public MCP surface drifts into raw debug tools', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-surface-'));
    const snapshotPath = path.join(tempRoot, 'snapshot.json');
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-23T00:00:00.000Z',
        capabilityCatalog: {
          siteCapabilityNames: [],
        },
        mcpPublicSurface: {
          total: 3,
          names: ['browser_debug_state', 'browser_evaluate', 'site_adapter_debug_shell'],
          rawPlaywrightSurfaceNames: ['browser_evaluate'],
          defaultSurfaceRejectsRawPlaywright: false,
        },
        runtimeDescriptor: {
          browserCapabilityNames: ['network.responseBody'],
          capabilityMatrix: [
            {
              runtimeId: 'chromium-cloak-playwright',
              capabilityName: 'network.responseBody',
              supported: true,
              source: 'runtime',
            },
            { runtimeId: 'electron-webcontents', capabilityName: 'network.responseBody' },
            { runtimeId: 'chromium-extension-relay', capabilityName: 'network.responseBody' },
            { runtimeId: 'firefox-bidi', capabilityName: 'network.responseBody' },
          ],
        },
        repairScope: {
          officialAdapterMatrix: {
            ok: true,
          },
        },
      }),
      'utf8'
    );

    const siteAdapterCanaryEvidencePath = writePassingSiteAdapterCanaryEvidence(tempRoot);
    const report = buildReleaseGateReport({ root, snapshotPath, siteAdapterCanaryEvidencePath });

    expect(report.gates.governanceSnapshot.status).toBe('failed');
    expect(report.gates.governanceSnapshot.publicSurfacePolicy).toMatchObject({
      status: 'failed',
      rawPlaywrightSurfaceNames: ['browser_evaluate'],
      forbiddenPublicSurfaceNames: ['browser_evaluate', 'site_adapter_debug_shell'],
      allowedDebugSurfaceNames: ['browser_debug_state'],
    });
    expect(report.blocking).toContain('governance_snapshot_failed');
  });

  it('blocks release when site adapter canary latest evidence is missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-missing-site-canary-'));
    const report = buildReleaseGateReport({
      root,
      siteAdapterCanaryEvidencePath: path.join(tempRoot, 'missing.json'),
    });

    expect(report.gates.siteAdapterCanary).toMatchObject({
      status: 'missing',
      latestEvidence: null,
      evidenceCommand: 'npm run test:site-adapter-canary -- --suite all',
    });
    expect(report.blocking).toContain('site_adapter_canary_missing_or_failed');
  });

  it('requires site adapter canary evidence to cover every official suite', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-partial-site-canary-'));
    const evidencePath = path.join(tempRoot, 'latest.json');
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-23T00:00:00.000Z',
        status: 'passed',
        suite: 'procedure',
        code: 0,
        command: 'npx.cmd',
        args: ['vitest', 'run', '--no-file-parallelism'],
        suites: ['procedure'],
      }),
      'utf8'
    );

    const gate = buildSiteAdapterCanaryGate({ evidencePath });

    expect(gate).toMatchObject({
      status: 'incomplete',
      latestEvidence: expect.objectContaining({
        status: 'passed',
        hasAllSuites: false,
      }),
    });
  });

  it('promotes real canary to passed when latest all-suite evidence is green', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-gate-evidence-'));
    const evidencePath = path.join(tempRoot, 'latest.json');
    const siteAdapterCanaryEvidencePath = writePassingSiteAdapterCanaryEvidence(tempRoot);
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-23T00:00:00.000Z',
        status: 'passed',
        runtime: 'all',
        code: 0,
        command: 'npx.cmd',
        args: ['vitest', 'run', '--no-file-parallelism'],
        suites: ['pool', 'electron', 'extension', 'ruyi', 'cloak'],
      }),
      'utf8'
    );

    const report = buildReleaseGateReport({
      root,
      browserCanaryEvidencePath: evidencePath,
      siteAdapterCanaryEvidencePath,
    });

    if (report.gates.runtimeInstall.status === 'ok') {
      expect(report.gates.realCanary.status).toBe('passed');
      expect(report.status).toBe('ready');
    }
  });
});
