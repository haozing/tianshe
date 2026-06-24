const {
  CANARY_SUITES,
  buildVitestInvocation,
  buildVitestPlan,
  parseArgs,
  selectSuites,
} = require('./browser-canary.js');

describe('browser-canary', () => {
  it('parses runtime, timeout, dry-run, and passthrough args', () => {
    const options = parseArgs(
      ['--runtime=extension', '--timeout-ms', '1234', '--dry-run', '--', '--reporter=dot'],
      {}
    );

    expect(options).toEqual({
      runtime: 'extension',
      timeoutMs: 1234,
      dryRun: true,
      passThroughArgs: ['--reporter=dot'],
    });
  });

  it('selects all or a comma-separated subset of suites', () => {
    expect(selectSuites('all').map((suite) => suite.id)).toEqual([
      'pool',
      'electron',
      'extension',
      'ruyi',
      'cloak',
    ]);
    expect(selectSuites('ruyi,extension,cloak').map((suite) => suite.id)).toEqual([
      'extension',
      'ruyi',
      'cloak',
    ]);
    expect(selectSuites('ruyi').map((suite) => suite.id)).toEqual(['ruyi']);
  });

  it('rejects unknown runtimes', () => {
    expect(() => selectSuites('unknown')).toThrow(/Unknown browser canary runtime/);
  });

  it('builds a vitest invocation that enables selected canary env flags', () => {
    const invocation = buildVitestInvocation({
      runtime: 'extension',
      timeoutMs: 300000,
      dryRun: false,
      passThroughArgs: ['--reporter=dot'],
    });

    expect(invocation.args).toEqual([
      'vitest',
      'run',
      '--no-file-parallelism',
      'src/main/profile/browser-pool-integration-extension.canary.test.ts',
      '--reporter=dot',
    ]);
    expect(invocation.env.AIRPA_RUN_EXTENSION_CANARY).toBe('1');
    expect(invocation.env.AIRPA_RUN_RUYI_CANARY).toBeUndefined();
  });

  it('deduplicates pool-backed canary files and enables cloak through all', () => {
    const invocation = buildVitestInvocation({
      runtime: 'all',
      timeoutMs: 300000,
      dryRun: false,
      passThroughArgs: [],
    });

    expect(
      invocation.args.filter((arg) => arg === 'src/main/profile/browser-pool-real.canary.test.ts')
    ).toHaveLength(1);
    expect(invocation.args).toContain('--no-file-parallelism');
    expect(invocation.env.AIRPA_RUN_CLOAK_CANARY).toBe('1');
    expect(invocation.env.AIRPA_RUN_ELECTRON_CANARY).toBe('1');
  });

  it('plans all canaries as isolated vitest invocations', () => {
    const plan = buildVitestPlan({
      runtime: 'all',
      timeoutMs: 300000,
      dryRun: false,
      passThroughArgs: ['--reporter=dot'],
    });

    expect(plan.suites.map((suite) => suite.id)).toEqual([
      'pool',
      'electron',
      'extension',
      'ruyi',
      'cloak',
    ]);
    expect(plan.invocations.map((invocation) => invocation.id)).toEqual([
      'pool:extension',
      'pool:ruyi',
      'pool:cloak',
      'electron',
      'extension',
      'ruyi',
    ]);
    expect(plan.invocations.every((invocation) => invocation.args.includes('--reporter=dot'))).toBe(
      true
    );
    expect(plan.invocations.find((invocation) => invocation.id === 'pool:cloak')).toMatchObject({
      suiteIds: ['pool', 'cloak'],
      args: expect.arrayContaining(['src/main/profile/browser-pool-real.canary.test.ts']),
    });
    expect(
      plan.invocations.find((invocation) => invocation.id === 'pool:extension').env
        .AIRPA_RUN_EXTENSION_CANARY
    ).toBe('1');
    expect(
      plan.invocations.find((invocation) => invocation.id === 'pool:extension').env
        .AIRPA_RUN_RUYI_CANARY
    ).toBeUndefined();
  });

  it('keeps a standalone cloak run as a single pool-backed invocation', () => {
    const plan = buildVitestPlan({
      runtime: 'cloak',
      timeoutMs: 300000,
      dryRun: false,
      passThroughArgs: [],
    });

    expect(plan.suites.map((suite) => suite.id)).toEqual(['cloak']);
    expect(plan.invocations).toEqual([
      expect.objectContaining({
        id: 'pool:cloak',
        suiteIds: ['cloak'],
        args: expect.arrayContaining(['src/main/profile/browser-pool-real.canary.test.ts']),
      }),
    ]);
  });

  it('keeps suite definitions explicit', () => {
    expect(CANARY_SUITES).toEqual([
      expect.objectContaining({
        id: 'pool',
        env: 'AIRPA_RUN_BROWSER_POOL_CANARY',
      }),
      expect.objectContaining({
        id: 'electron',
        env: 'AIRPA_RUN_ELECTRON_CANARY',
      }),
      expect.objectContaining({
        id: 'extension',
        env: 'AIRPA_RUN_EXTENSION_CANARY',
      }),
      expect.objectContaining({
        id: 'ruyi',
        env: 'AIRPA_RUN_RUYI_CANARY',
      }),
      expect.objectContaining({
        id: 'cloak',
        env: 'AIRPA_RUN_CLOAK_CANARY',
      }),
    ]);
  });
});
