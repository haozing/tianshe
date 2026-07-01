import { describe, expect, it } from 'vitest';
import { DatabaseError } from './errors';

describe('DatabaseError', () => {
  it('redacts sensitive database details from public serialization', () => {
    const error = new DatabaseError(
      'Failed to execute SQL',
      {
        pluginId: 'plugin-1',
        datasetId: 'dataset-1',
        operation: 'executeSQL',
        sql: 'SELECT * FROM users WHERE token = ?',
        params: ['secret-token'],
        value: { apiKey: 'secret' },
        record: { password: 'secret' },
        updates: { password: 'changed' },
        nested: {
          rawHeaders: ['authorization', 'Bearer secret'],
          safe: 'kept',
        },
      },
      new Error('duckdb failed near secret-token')
    );

    expect(error.cause).toBeUndefined();
    expect(error.details).toEqual({
      pluginId: 'plugin-1',
      datasetId: 'dataset-1',
      operation: 'executeSQL',
      sqlRedacted: true,
      paramsRedacted: true,
      valueRedacted: true,
      recordRedacted: true,
      updatesRedacted: true,
      nested: {
        rawHeadersRedacted: true,
        safe: 'kept',
      },
    });

    const json = error.toJSON();
    expect(json.cause).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('secret-token');
    expect(JSON.stringify(json)).not.toContain('SELECT * FROM users');
  });
});
