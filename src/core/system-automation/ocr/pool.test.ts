import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GutenOCRPool } from './pool';

const detectCalls: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
const terminateMock = vi.fn();

vi.mock('./providers/gutenye-worker-adapter', () => ({
  GutenOCRWorkerAdapter: class MockGutenOCRWorkerAdapter {
    async initialize(): Promise<void> {
      return undefined;
    }

    async recognize(): Promise<[]> {
      return new Promise((resolve, reject) => {
        detectCalls.push({
          resolve: () => resolve([]),
          reject,
        });
      });
    }

    async recognizeDetailed(): Promise<[]> {
      return [];
    }

    async terminate(): Promise<void> {
      terminateMock();
    }
  },
}));

vi.mock('./providers/gutenye-adapter', () => ({
  GutenOCRAdapter: class MockGutenOCRAdapter {},
}));

describe('GutenOCRPool queue backpressure', () => {
  beforeEach(() => {
    detectCalls.length = 0;
    terminateMock.mockClear();
  });

  it('enforces maxQueue in the default wait mode', async () => {
    const pool = new GutenOCRPool({ size: 1, maxQueue: 1 });

    const running = pool.recognize(Buffer.from('running'));
    await vi.waitFor(() => expect(detectCalls).toHaveLength(1));

    const queued = pool.recognize(Buffer.from('queued'));
    await expect(pool.recognize(Buffer.from('overflow'))).rejects.toThrow(
      'OCR pool queue is full'
    );

    detectCalls[0].resolve();
    await running;
    await vi.waitFor(() => expect(detectCalls).toHaveLength(2));

    detectCalls[1].resolve();
    await queued;
    await pool.terminate();
  });

  it('removes aborted waiters so later requests can use the freed queue slot', async () => {
    const pool = new GutenOCRPool({ size: 1, maxQueue: 1 });

    const running = pool.recognize(Buffer.from('running'));
    await vi.waitFor(() => expect(detectCalls).toHaveLength(1));

    const controller = new AbortController();
    const aborted = pool.recognize(Buffer.from('aborted'), undefined, {
      signal: controller.signal,
    });

    controller.abort(new Error('stop waiting'));
    await expect(aborted).rejects.toThrow('stop waiting');

    const queuedAfterAbort = pool.recognize(Buffer.from('queued-after-abort'));

    detectCalls[0].resolve();
    await running;
    await vi.waitFor(() => expect(detectCalls).toHaveLength(2));

    detectCalls[1].resolve();
    await queuedAfterAbort;
    await pool.terminate();
  });

  it('allows explicit unbounded wait queues with maxQueue Infinity', async () => {
    const pool = new GutenOCRPool({ size: 1, maxQueue: Infinity });

    const running = pool.recognize(Buffer.from('running'));
    await vi.waitFor(() => expect(detectCalls).toHaveLength(1));

    const queued = [
      pool.recognize(Buffer.from('queued-1')),
      pool.recognize(Buffer.from('queued-2')),
      pool.recognize(Buffer.from('queued-3')),
    ];

    for (let index = 0; index < 4; index += 1) {
      detectCalls[index].resolve();
      await (index === 0 ? running : queued[index - 1]);
      if (index < 3) {
        await vi.waitFor(() => expect(detectCalls).toHaveLength(index + 2));
      }
    }

    await pool.terminate();
  });
});
