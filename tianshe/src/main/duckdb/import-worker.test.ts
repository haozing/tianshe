import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { finishWriteStream, writeWithBackpressure } from './import-worker';

describe('import-worker', () => {
  describe('writeWithBackpressure', () => {
    it('returns immediately when write() returns true', async () => {
      const writeStream = new EventEmitter() as any;
      writeStream.write = vi.fn(() => true);

      await writeWithBackpressure(writeStream, 'hello');

      expect(writeStream.write).toHaveBeenCalledWith('hello');
    });

    it('waits for drain when write() returns false', async () => {
      const writeStream = new EventEmitter() as any;
      writeStream.write = vi.fn(() => false);
      writeStream.off = vi.fn();

      const promise = writeWithBackpressure(writeStream, 'hello');

      // Promise 应在 drain 事件前处于 pending
      const earlyCheck = await Promise.race([
        promise.then(() => 'resolved'),
        Promise.resolve('pending'),
      ]);
      expect(earlyCheck).toBe('pending');

      // 触发 drain 事件
      writeStream.emit('drain');

      await promise;
      expect(writeStream.write).toHaveBeenCalledWith('hello');
    });

    it('rejects when writeStream emits error before drain', async () => {
      const writeStream = new EventEmitter() as any;
      writeStream.write = vi.fn(() => false);
      writeStream.off = vi.fn();

      const promise = writeWithBackpressure(writeStream, 'hello');

      const error = new Error('write error');
      writeStream.emit('error', error);

      await expect(promise).rejects.toThrow('write error');
    });
  });

  describe('finishWriteStream', () => {
    it('resolves after finish', async () => {
      const writeStream = new EventEmitter() as any;
      writeStream.end = vi.fn(() => queueMicrotask(() => writeStream.emit('finish')));

      await finishWriteStream(writeStream);

      expect(writeStream.end).toHaveBeenCalledTimes(1);
    });

    it('rejects when end emits an error synchronously', async () => {
      const writeStream = new EventEmitter() as any;
      writeStream.end = vi.fn(() => writeStream.emit('error', new Error('end failed')));

      await expect(finishWriteStream(writeStream)).rejects.toThrow('end failed');
      expect(writeStream.end).toHaveBeenCalledTimes(1);
    });
  });
});
