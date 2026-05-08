import { describe, it, expect, vi } from 'vitest';
import { runPrepared, allPrepared, getPrepared, withPrepared } from './statement-executor';

describe('statement-executor', () => {
  const createMockConn = () => {
    const destroySync = vi.fn();
    const bind = vi.fn();
    const run = vi.fn(async () => undefined);
    const runAndReadAll = vi.fn(async () => ({
      columnNames: () => ['id', 'name'],
      getRows: () => [
        [1, 'alice'],
        [2, 'bob'],
      ],
    }));

    const prepare = vi.fn(async () => ({
      bind,
      run,
      runAndReadAll,
      destroySync,
    }));

    return { prepare, bind, run, runAndReadAll, destroySync };
  };

  describe('withPrepared', () => {
    it('binds params, runs custom work, and destroys statement', async () => {
      const conn = createMockConn() as any;

      const result = await withPrepared(conn, 'SELECT * FROM t WHERE id = ?', [1], async (stmt) => {
        await stmt.run();
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(conn.prepare).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?');
      expect(conn.bind).toHaveBeenCalledWith([1]);
      expect(conn.run).toHaveBeenCalled();
      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('destroys statement even when custom work throws', async () => {
      const conn = createMockConn() as any;

      await expect(
        withPrepared(conn, 'SELECT * FROM t', [], () => {
          throw new Error('work error');
        })
      ).rejects.toThrow('work error');

      expect(conn.destroySync).toHaveBeenCalled();
    });
  });

  describe('runPrepared', () => {
    it('binds params, runs, and destroys statement', async () => {
      const conn = createMockConn() as any;
      await runPrepared(conn, 'INSERT INTO t VALUES (?, ?)', [1, 'a']);

      expect(conn.prepare).toHaveBeenCalledWith('INSERT INTO t VALUES (?, ?)');
      expect(conn.bind).toHaveBeenCalledWith([1, 'a']);
      expect(conn.run).toHaveBeenCalled();
      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('destroys statement even when bind throws', async () => {
      const conn = createMockConn() as any;
      conn.bind.mockImplementation(() => {
        throw new Error('bind error');
      });

      await expect(
        runPrepared(conn, 'INSERT INTO t VALUES (?)', [1])
      ).rejects.toThrow('bind error');

      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('destroys statement even when run throws', async () => {
      const conn = createMockConn() as any;
      conn.run.mockRejectedValue(new Error('run error'));

      await expect(
        runPrepared(conn, 'INSERT INTO t VALUES (?)', [1])
      ).rejects.toThrow('run error');

      expect(conn.destroySync).toHaveBeenCalled();
    });
  });

  describe('allPrepared', () => {
    it('binds params, reads all rows, and destroys statement', async () => {
      const conn = createMockConn() as any;
      const result = await allPrepared(conn, 'SELECT * FROM t WHERE id = ?', [1]);

      expect(conn.prepare).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?');
      expect(conn.bind).toHaveBeenCalledWith([1]);
      expect(conn.runAndReadAll).toHaveBeenCalled();
      expect(conn.destroySync).toHaveBeenCalled();

      expect(result.getRows()).toEqual([
        [1, 'alice'],
        [2, 'bob'],
      ]);
    });

    it('destroys statement even when bind throws', async () => {
      const conn = createMockConn() as any;
      conn.bind.mockImplementation(() => {
        throw new Error('bind error');
      });

      await expect(
        allPrepared(conn, 'SELECT * FROM t', [])
      ).rejects.toThrow('bind error');

      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('destroys statement even when runAndReadAll throws', async () => {
      const conn = createMockConn() as any;
      conn.runAndReadAll.mockRejectedValue(new Error('read error'));

      await expect(
        allPrepared(conn, 'SELECT * FROM t', [])
      ).rejects.toThrow('read error');

      expect(conn.destroySync).toHaveBeenCalled();
    });
  });

  describe('getPrepared', () => {
    it('returns the first row when rows exist', async () => {
      const conn = createMockConn() as any;
      const result = await getPrepared<[number, string]>(conn, 'SELECT * FROM t WHERE id = ?', [1]);

      expect(result).toEqual([1, 'alice']);
      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('returns null when no rows exist', async () => {
      const conn = createMockConn() as any;
      conn.runAndReadAll.mockResolvedValue({
        columnNames: () => [],
        getRows: () => [],
      });

      const result = await getPrepared(conn, 'SELECT * FROM t WHERE id = ?', [999]);

      expect(result).toBeNull();
      expect(conn.destroySync).toHaveBeenCalled();
    });

    it('destroys statement even when runAndReadAll throws', async () => {
      const conn = createMockConn() as any;
      conn.runAndReadAll.mockRejectedValue(new Error('read error'));

      await expect(
        getPrepared(conn, 'SELECT * FROM t', [])
      ).rejects.toThrow('read error');

      expect(conn.destroySync).toHaveBeenCalled();
    });
  });
});
