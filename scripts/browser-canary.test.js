const {
  CANARY_SUITES,
  buildVitestInvocation,
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
    expect(selectSuites('all').map((suite) => suite.id)).toEqual(['pool', 'extension', 'ruyi']);
    expect(selectSuites('ruyi,extension').map((suite) => suite.id)).toEqual([
      'extension',
      'ruyi',
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
      'src/main/profile/browser-pool-integration-extension.canary.test.ts',
      '--reporter=dot',
    ]);
    expect(invocation.env.AIRPA_RUN_EXTENSION_CANARY).toBe('1');
    expect(invocation.env.AIRPA_RUN_RUYI_CANARY).toBeUndefined();
  });

  it('keeps suite definitions explicit', () => {
    expect(CANARY_SUITES).toEqual([
      expect.objectContaining({
        id: 'pool',
        env: 'AIRPA_RUN_BROWSER_POOL_CANARY',
      }),
      expect.objectContaining({
        id: 'extension',
        env: 'AIRPA_RUN_EXTENSION_CANARY',
      }),
      expect.objectContaining({
        id: 'ruyi',
        env: 'AIRPA_RUN_RUYI_CANARY',
      }),
    ]);
  });
});
