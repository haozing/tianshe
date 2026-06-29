/**
 * SQL模板参数化工具测试
 */

import { describe, it, expect } from 'vitest';
import {
  SQLTemplateParameterizer,
  parameterizeSQLTemplate,
  validateSQLTemplate,
} from './sql-template';

describe('SQLTemplateParameterizer', () => {
  const parameterizer = new SQLTemplateParameterizer();

  describe('parameterize', () => {
    it('should convert simple Handlebars template to parameterized query', () => {
      const template = "UPDATE data SET status='{{result}}' WHERE id={{id}}";
      const context = { result: 'completed', id: 123 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET status=? WHERE id=?');
      expect(parsed.params).toEqual(['completed', 123]);
      expect(parsed.variables).toEqual(['result', 'id']);
      expect(parsed.originalTemplate).toBe(template);
    });

    it('should handle nested property paths', () => {
      const template =
        "UPDATE data SET name='{{user.name}}', email='{{user.email}}' WHERE id={{row.id}}";
      const context = {
        user: { name: 'Alice', email: 'alice@example.com' },
        row: { id: 456 },
      };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET name=?, email=? WHERE id=?');
      expect(parsed.params).toEqual(['Alice', 'alice@example.com', 456]);
      expect(parsed.variables).toEqual(['user.name', 'user.email', 'row.id']);
    });

    it('should handle special characters in values (SQL injection attempt)', () => {
      const template = "UPDATE data SET name='{{name}}' WHERE id={{id}}";
      const context = { name: "O'Reilly'; DROP TABLE users; --", id: 789 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET name=? WHERE id=?');
      expect(parsed.params).toEqual(["O'Reilly'; DROP TABLE users; --", 789]);
    });

    it('should handle null and undefined values', () => {
      const template = 'UPDATE data SET value={{value}}, nullValue={{nullValue}} WHERE id={{id}}';
      const context = { value: null, nullValue: undefined, id: 999 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET value=?, nullValue=? WHERE id=?');
      expect(parsed.params).toEqual([null, null, 999]);
    });

    it('should handle numeric values correctly', () => {
      const template = 'UPDATE data SET count={{count}}, price={{price}} WHERE id={{id}}';
      const context = { count: 42, price: 19.99, id: 111 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET count=?, price=? WHERE id=?');
      expect(parsed.params).toEqual([42, 19.99, 111]);
    });

    it('should handle boolean values', () => {
      const template = 'UPDATE data SET active={{active}}, verified={{verified}} WHERE id={{id}}';
      const context = { active: true, verified: false, id: 222 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET active=?, verified=? WHERE id=?');
      expect(parsed.params).toEqual([true, false, 222]);
    });

    it('should handle templates with spaces in Handlebars syntax', () => {
      const template = "UPDATE data SET name='{{ name }}', count={{ count }} WHERE id={{ id }}";
      const context = { name: 'Test', count: 10, id: 333 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET name=?, count=? WHERE id=?');
      expect(parsed.params).toEqual(['Test', 10, 333]);
    });

    it('should handle INSERT statements', () => {
      const template =
        "INSERT INTO data (name, email, created_at) VALUES ('{{name}}', '{{email}}', {{timestamp}})";
      const context = { name: 'Bob', email: 'bob@example.com', timestamp: 1234567890 };

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('INSERT INTO data (name, email, created_at) VALUES (?, ?, ?)');
      expect(parsed.params).toEqual(['Bob', 'bob@example.com', 1234567890]);
    });
  });

  describe('validateTemplate', () => {
    it('should accept valid UPDATE template', () => {
      const template = "UPDATE data SET status='{{status}}' WHERE id={{id}}";
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should accept valid INSERT template', () => {
      const template = "INSERT INTO data (name) VALUES ('{{name}}')";
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject DROP TABLE', () => {
      const template = 'DROP TABLE users';
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('DROP');
    });

    it('should reject TRUNCATE', () => {
      const template = 'TRUNCATE data';
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('TRUNCATE');
    });

    it('should reject SQL comments (potential injection)', () => {
      const template = "UPDATE data SET status='completed' -- WHERE id=1";
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(false);
    });

    it('should reject UNION SELECT (injection attempt)', () => {
      const template = 'SELECT * FROM data UNION SELECT * FROM users';
      const result = parameterizer.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('UNION');
    });
  });

  describe('detectSQLType', () => {
    it('should detect UPDATE statement', () => {
      const type = parameterizer.detectSQLType('UPDATE data SET x=?');
      expect(type).toBe('UPDATE');
    });

    it('should detect INSERT statement', () => {
      const type = parameterizer.detectSQLType('INSERT INTO data VALUES (?)');
      expect(type).toBe('INSERT');
    });

    it('should detect SELECT statement', () => {
      const type = parameterizer.detectSQLType('SELECT * FROM data WHERE id=?');
      expect(type).toBe('SELECT');
    });

    it('should detect DELETE statement', () => {
      const type = parameterizer.detectSQLType('DELETE FROM data WHERE id=?');
      expect(type).toBe('DELETE');
    });

    it('should handle lowercase SQL', () => {
      const type = parameterizer.detectSQLType('update data set x=?');
      expect(type).toBe('UPDATE');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty template', () => {
      const template = '';
      const context = {};

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('');
      expect(parsed.params).toEqual([]);
      expect(parsed.variables).toEqual([]);
    });

    it('should handle template with no variables', () => {
      const template = "UPDATE data SET status='completed'";
      const context = {};

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe("UPDATE data SET status='completed'");
      expect(parsed.params).toEqual([]);
      expect(parsed.variables).toEqual([]);
    });

    it('should handle missing context values', () => {
      const template = "UPDATE data SET name='{{name}}' WHERE id={{id}}";
      const context = { id: 123 }; // name is missing

      const parsed = parameterizer.parameterize(template, context);

      expect(parsed.sql).toBe('UPDATE data SET name=? WHERE id=?');
      expect(parsed.params).toEqual([null, 123]); // Missing value becomes null
    });
  });
});

describe('Convenience functions', () => {
  it('parameterizeSQLTemplate should work', () => {
    const result = parameterizeSQLTemplate("UPDATE data SET x='{{value}}' WHERE id={{id}}", {
      value: 'test',
      id: 1,
    });

    expect(result.sql).toBe('UPDATE data SET x=? WHERE id=?');
    expect(result.params).toEqual(['test', 1]);
  });

  it('validateSQLTemplate should work', () => {
    const result = validateSQLTemplate('UPDATE data SET x=?');
    expect(result.valid).toBe(true);

    const invalidResult = validateSQLTemplate('DROP TABLE data');
    expect(invalidResult.valid).toBe(false);
  });
});
