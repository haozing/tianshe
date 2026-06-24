import {
  createSiteAdapterFieldDiagnostics,
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  type SiteAdapterFixture,
  type SiteAdapterFixtureRunResult,
  type SiteAdapterModule,
} from '../site-adapter-runtime';
import type { BrowserInterface, SnapshotOptions } from '../../types/browser-interface';

export type SiteAdapterLabRunnerId = 'fixture' | 'browser-snapshot' | 'playwright-lab';
export type SiteAdapterLabRunnerStatus =
  | 'not_configured'
  | 'environment_gap'
  | 'passed'
  | 'failed';

export interface SiteAdapterLabRunnerEvidence {
  runner: SiteAdapterLabRunnerId;
  status: SiteAdapterLabRunnerStatus;
  ok: boolean | null;
  result?: Record<string, unknown>;
  diagnostics?: SiteAdapterFixtureRunResult['diagnostics'];
  verifierResults?: SiteAdapterFixtureRunResult['verifierResults'];
  artifactRefs?: string[];
  message?: string;
}

export interface SiteAdapterLabBrowserRunnerOptions {
  browser?: Pick<BrowserInterface, 'snapshot'>;
  fixtureName?: string;
  input?: Record<string, unknown>;
  snapshotOptions?: SnapshotOptions;
  unavailableReason?: string;
}

export interface SiteAdapterLabPlaywrightRunnerOptions {
  run?: (input: {
    adapter: SiteAdapterModule;
    fixture: SiteAdapterFixture;
    expected: Record<string, unknown>;
  }) => Promise<SiteAdapterFixtureRunResult> | SiteAdapterFixtureRunResult;
  unavailableReason?: string;
}

export interface SiteAdapterLabRunnerDiffOptions {
  browserRunner?: SiteAdapterLabBrowserRunnerOptions;
  playwrightLabRunner?: SiteAdapterLabPlaywrightRunnerOptions;
}

export interface SiteAdapterLabRunnerDiffResult {
  fixtureRunner: SiteAdapterFixtureRunResult;
  expectedDiff: ReturnType<typeof createSiteAdapterFieldDiagnostics>;
  runnerComparison: {
    fixtureRunnerOk: boolean;
    browserRunnerOk: boolean | null;
    playwrightLabRunnerOk: boolean | null;
    driftStatus: 'not_compared' | 'aligned' | 'drift' | 'environment_gap';
    runners: {
      fixture: SiteAdapterLabRunnerEvidence;
      browserSnapshot: SiteAdapterLabRunnerEvidence;
      playwrightLab: SiteAdapterLabRunnerEvidence;
    };
  };
}

function createRunnerEvidence(
  runner: SiteAdapterLabRunnerId,
  run: SiteAdapterFixtureRunResult
): SiteAdapterLabRunnerEvidence {
  return {
    runner,
    status: run.ok ? 'passed' : 'failed',
    ok: run.ok,
    result: run.result,
    diagnostics: run.diagnostics,
    verifierResults: run.verifierResults,
    artifactRefs: run.artifactRefs,
  };
}

function createNotConfiguredEvidence(
  runner: Exclude<SiteAdapterLabRunnerId, 'fixture'>
): SiteAdapterLabRunnerEvidence {
  return {
    runner,
    status: 'not_configured',
    ok: null,
    message: `${runner} runner was not provided for this Lab run.`,
  };
}

function createEnvironmentGapEvidence(
  runner: Exclude<SiteAdapterLabRunnerId, 'fixture'>,
  message: string
): SiteAdapterLabRunnerEvidence {
  return {
    runner,
    status: 'environment_gap',
    ok: null,
    message,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function normalizeResultForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeResultForComparison);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'runner')
        .map(([key, entry]) => [key, normalizeResultForComparison(entry)])
    );
  }
  return value;
}

function runnerMatchesFixture(
  fixtureRunner: SiteAdapterFixtureRunResult,
  runner: SiteAdapterLabRunnerEvidence
): boolean {
  return (
    runner.ok === fixtureRunner.ok &&
    stableJson(normalizeResultForComparison(runner.result || {})) ===
      stableJson(normalizeResultForComparison(fixtureRunner.result))
  );
}

function calculateDriftStatus(
  fixtureRunner: SiteAdapterFixtureRunResult,
  comparedRunners: SiteAdapterLabRunnerEvidence[]
): SiteAdapterLabRunnerDiffResult['runnerComparison']['driftStatus'] {
  const configured = comparedRunners.filter((runner) => runner.status !== 'not_configured');
  if (configured.length === 0) {
    return 'not_compared';
  }
  if (configured.some((runner) => runner.status === 'environment_gap')) {
    return 'environment_gap';
  }
  return configured.every((runner) => runnerMatchesFixture(fixtureRunner, runner))
    ? 'aligned'
    : 'drift';
}

async function runBrowserSnapshotComparison(
  adapter: SiteAdapterModule,
  fixture: SiteAdapterFixture,
  expected: Record<string, unknown>,
  options?: SiteAdapterLabBrowserRunnerOptions
): Promise<SiteAdapterLabRunnerEvidence> {
  if (!options) {
    return createNotConfiguredEvidence('browser-snapshot');
  }
  if (options.unavailableReason) {
    return createEnvironmentGapEvidence('browser-snapshot', options.unavailableReason);
  }
  if (!options.browser) {
    return createNotConfiguredEvidence('browser-snapshot');
  }

  try {
    const result = await runReadOnlySiteAdapterRuntimeCanary(adapter, {
      browser: options.browser,
      fixtureName: options.fixtureName || fixture.name,
      expected,
      input: options.input ?? fixture.input,
      snapshotOptions: options.snapshotOptions,
    });
    return createRunnerEvidence('browser-snapshot', result);
  } catch (error) {
    return {
      runner: 'browser-snapshot',
      status: 'failed',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPlaywrightLabComparison(
  adapter: SiteAdapterModule,
  fixture: SiteAdapterFixture,
  expected: Record<string, unknown>,
  options?: SiteAdapterLabPlaywrightRunnerOptions
): Promise<SiteAdapterLabRunnerEvidence> {
  if (!options) {
    return createNotConfiguredEvidence('playwright-lab');
  }
  if (options.unavailableReason) {
    return createEnvironmentGapEvidence('playwright-lab', options.unavailableReason);
  }
  if (!options.run) {
    return createNotConfiguredEvidence('playwright-lab');
  }

  try {
    const result = await options.run({ adapter, fixture, expected });
    return createRunnerEvidence('playwright-lab', result);
  } catch (error) {
    return {
      runner: 'playwright-lab',
      status: 'failed',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runSiteAdapterLabFixturePanel(
  adapter: SiteAdapterModule,
  fixture: SiteAdapterFixture,
  expected: Record<string, unknown>,
  options: SiteAdapterLabRunnerDiffOptions = {}
): Promise<SiteAdapterLabRunnerDiffResult> {
  const fixtureRunner = await runReadOnlySiteAdapterFixture(adapter, {
    ...fixture,
    expected,
  });
  const expectedDiff = createSiteAdapterFieldDiagnostics(fixtureRunner.result, expected);
  const browserSnapshot = await runBrowserSnapshotComparison(
    adapter,
    fixture,
    expected,
    options.browserRunner
  );
  const playwrightLab = await runPlaywrightLabComparison(
    adapter,
    fixture,
    expected,
    options.playwrightLabRunner
  );

  return {
    fixtureRunner,
    expectedDiff,
    runnerComparison: {
      fixtureRunnerOk: fixtureRunner.ok,
      browserRunnerOk: browserSnapshot.ok,
      playwrightLabRunnerOk: playwrightLab.ok,
      driftStatus: calculateDriftStatus(fixtureRunner, [browserSnapshot, playwrightLab]),
      runners: {
        fixture: createRunnerEvidence('fixture', fixtureRunner),
        browserSnapshot,
        playwrightLab,
      },
    },
  };
}
