import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ChildProcessFFIIsolatedCallRunner } from './isolated-runner';

describe('ChildProcessFFIIsolatedCallRunner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `tianshe-ffi-runner-${Date.now()}`);
    await fs.ensureDir(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('returns an isolated worker result', async () => {
    const workerPath = await writeWorker('success', `
      process.once('message', () => {
        process.send({ type: 'result', result: 7 });
      });
    `);
    const runner = new ChildProcessFFIIsolatedCallRunner(workerPath);

    const result = await runner.run(createRequest(), { timeoutMs: 1000 });

    expect(result).toBe(7);
  });

  it('kills a hanging isolated worker on timeout', async () => {
    const workerPath = await writeWorker('hang', `
      process.once('message', () => {
        setInterval(() => {}, 1000);
      });
    `);
    const runner = new ChildProcessFFIIsolatedCallRunner(workerPath);

    await expect(runner.run(createRequest(), { timeoutMs: 50 })).rejects.toThrow(
      'timed out after 50ms'
    );
  });

  it('reports worker crashes without crashing the parent process', async () => {
    const workerPath = await writeWorker('crash', `
      process.once('message', () => {
        process.exit(134);
      });
    `);
    const runner = new ChildProcessFFIIsolatedCallRunner(workerPath);

    await expect(runner.run(createRequest(), { timeoutMs: 1000 })).rejects.toThrow(
      'exited before returning a result'
    );
  });

  async function writeWorker(name: string, source: string): Promise<string> {
    const filePath = path.join(tempDir, `${name}.js`);
    await fs.writeFile(filePath, source, 'utf8');
    return filePath;
  }
});

function createRequest() {
  return {
    libPath: 'mock.dll',
    functionName: 'MockFunction',
    signature: { returns: 'int', args: [] },
    args: [],
    callerId: 'test-plugin',
  };
}
