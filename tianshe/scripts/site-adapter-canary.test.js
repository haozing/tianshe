const {
  SITE_ADAPTER_CANARY_SUITES,
  buildVitestInvocation,
  parseArgs,
  selectSuites,
} = require('./site-adapter-canary.js');

describe('site-adapter-canary', () => {
  it('parses suite, timeout, dry-run, and passthrough args', () => {
    const options = parseArgs(
      ['--suite=procedure', '--timeout-ms', '1234', '--dry-run', '--', '--reporter=dot'],
      {}
    );

    expect(options).toEqual({
      suite: 'procedure',
      timeoutMs: 1234,
      dryRun: true,
      passThroughArgs: ['--reporter=dot'],
    });
  });

  it('selects all or a comma-separated subset of suites', () => {
    expect(selectSuites('all').map((suite) => suite.id)).toEqual([
      'runner',
      'official-adapters',
      'books-pack',
      'open-library-pack',
      'github-pack',
      'procedure',
      'persistent-resume',
      'repair-workflow',
      'repair-model-gateway',
      'repair-studio-ipc',
      'repair-studio-ui',
      'lab-repair-handoff-ui',
      'dataset-evidence-ui',
      'repair-model-provider-config',
      'procedure-repair',
      'repair-scope',
      'site-capabilities',
      'login-health',
      'login-lease',
      'mcp-session-binding',
    ]);
    expect(selectSuites('procedure,repair-scope').map((suite) => suite.id)).toEqual([
      'procedure',
      'repair-scope',
    ]);
  });

  it('rejects unknown suites', () => {
    expect(() => selectSuites('unknown')).toThrow(/Unknown site adapter canary suite/);
  });

  it('builds a no-file-parallelism vitest invocation', () => {
    const invocation = buildVitestInvocation({
      suite: 'procedure,repair-scope',
      timeoutMs: 300000,
      dryRun: false,
      passThroughArgs: ['--reporter=dot'],
    });

    expect(invocation.args).toEqual([
      'vitest',
      'run',
      '--no-file-parallelism',
      'src/core/site-adapter-runtime/procedure.test.ts',
      'src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      '--reporter=dot',
    ]);
    expect(invocation.suites.map((suite) => suite.id)).toEqual(['procedure', 'repair-scope']);
  });

  it('keeps suite definitions explicit', () => {
    expect(SITE_ADAPTER_CANARY_SUITES).toEqual([
      expect.objectContaining({ id: 'runner' }),
      expect.objectContaining({ id: 'official-adapters' }),
      expect.objectContaining({ id: 'books-pack' }),
      expect.objectContaining({ id: 'open-library-pack' }),
      expect.objectContaining({ id: 'github-pack' }),
      expect.objectContaining({ id: 'procedure' }),
      expect.objectContaining({ id: 'persistent-resume' }),
      expect.objectContaining({ id: 'repair-workflow' }),
      expect.objectContaining({ id: 'repair-model-gateway' }),
      expect.objectContaining({ id: 'repair-studio-ipc' }),
      expect.objectContaining({ id: 'repair-studio-ui' }),
      expect.objectContaining({ id: 'lab-repair-handoff-ui' }),
      expect.objectContaining({ id: 'dataset-evidence-ui' }),
      expect.objectContaining({ id: 'repair-model-provider-config' }),
      expect.objectContaining({ id: 'procedure-repair' }),
      expect.objectContaining({ id: 'repair-scope' }),
      expect.objectContaining({ id: 'site-capabilities' }),
      expect.objectContaining({ id: 'login-health' }),
      expect.objectContaining({ id: 'login-lease' }),
      expect.objectContaining({ id: 'mcp-session-binding' }),
    ]);
  });
});
