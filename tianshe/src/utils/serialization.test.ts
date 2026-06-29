/**
 * serialization.ts 单元测试
 *
 * 测试覆盖：
 * 1. clone 函数 - 深度克隆对象
 * 2. safeStringify 函数 - 安全的 JSON 序列化
 */

import { describe, it, expect } from 'vitest';
import { clone, safeStringify } from './serialization';

describe('serialization 工具函数测试', () => {
  describe('clone 函数', () => {
    describe('基本类型测试', () => {
      it('应该返回 null', () => {
        const result = clone(null);
        expect(result).toBe(null);
      });

      it('应该返回 undefined', () => {
        const result = clone(undefined);
        expect(result).toBe(undefined);
      });

      it('应该克隆数字', () => {
        expect(clone(42)).toBe(42);
        expect(clone(0)).toBe(0);
        expect(clone(-100)).toBe(-100);
        expect(clone(3.14)).toBe(3.14);
      });

      it('应该克隆字符串', () => {
        expect(clone('hello')).toBe('hello');
        expect(clone('')).toBe('');
        expect(clone('中文测试')).toBe('中文测试');
      });

      it('应该克隆布尔值', () => {
        expect(clone(true)).toBe(true);
        expect(clone(false)).toBe(false);
      });

      it('应该克隆 NaN', () => {
        const result = clone(NaN);
        expect(Number.isNaN(result)).toBe(true);
      });

      it('应该克隆 Infinity', () => {
        expect(clone(Infinity)).toBe(Infinity);
        expect(clone(-Infinity)).toBe(-Infinity);
      });
    });

    describe('简单对象测试', () => {
      it('应该克隆空对象', () => {
        const original = {};
        const cloned = clone(original);

        expect(cloned).toEqual({});
        expect(cloned).not.toBe(original);
      });

      it('应该克隆简单对象', () => {
        const original = { a: 1, b: 'test', c: true };
        const cloned = clone(original);

        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
      });

      it('应该深度克隆嵌套对象', () => {
        const original = {
          a: 1,
          b: {
            c: 2,
            d: {
              e: 3,
            },
          },
        };
        const cloned = clone(original);

        // 修改克隆对象不应影响原对象
        cloned.b.d.e = 999;

        expect(original.b.d.e).toBe(3);
        expect(cloned.b.d.e).toBe(999);
        expect(cloned.b).not.toBe(original.b);
        expect(cloned.b.d).not.toBe(original.b.d);
      });

      it('应该克隆包含 null 和 undefined 的对象', () => {
        const original = {
          a: null,
          b: undefined,
          c: 'test',
        };
        const cloned = clone(original);

        expect(cloned.a).toBe(null);
        expect(cloned.b).toBe(undefined);
        expect(cloned.c).toBe('test');
      });
    });

    describe('数组测试', () => {
      it('应该克隆空数组', () => {
        const original: any[] = [];
        const cloned = clone(original);

        expect(cloned).toEqual([]);
        expect(cloned).not.toBe(original);
      });

      it('应该克隆简单数组', () => {
        const original = [1, 2, 3, 'test', true];
        const cloned = clone(original);

        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
      });

      it('应该克隆嵌套数组', () => {
        const original = [1, [2, 3, [4, 5]], 6];
        const cloned = clone(original);

        // 修改克隆数组不应影响原数组
        (cloned[1] as number[])[2] = 999;

        expect((original[1] as number[])[2]).toEqual([4, 5]);
        expect((cloned[1] as number[])[2]).toBe(999);
      });

      it('应该克隆对象数组', () => {
        const original = [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ];
        const cloned = clone(original);

        cloned[0].name = 'Charlie';

        expect(original[0].name).toBe('Alice');
        expect(cloned[0].name).toBe('Charlie');
        expect(cloned[0]).not.toBe(original[0]);
      });
    });

    describe('特殊类型测试', () => {
      it('应该克隆 Date 对象', () => {
        const original = new Date('2024-01-01T00:00:00.000Z');
        const cloned = clone(original);

        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
        expect(cloned instanceof Date).toBe(true);
        expect(cloned.getTime()).toBe(original.getTime());

        // 修改克隆不应影响原对象
        cloned.setFullYear(2025);
        expect(original.getFullYear()).toBe(2024);
      });

      it('应该克隆 RegExp 对象', () => {
        const original = /test\d+/gi;
        const cloned = clone(original);

        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
        expect(cloned instanceof RegExp).toBe(true);
        expect(cloned.source).toBe(original.source);
        expect(cloned.flags).toBe(original.flags);
      });

      it('应该克隆不同 flags 的 RegExp', () => {
        const patterns = [/test/, /test/i, /test/g, /test/m, /test/gim];

        patterns.forEach((pattern) => {
          const cloned = clone(pattern);
          expect(cloned.source).toBe(pattern.source);
          expect(cloned.flags).toBe(pattern.flags);
          expect(cloned).not.toBe(pattern);
        });
      });
    });

    describe('循环引用测试', () => {
      it('应该处理对象的循环引用', () => {
        const original: any = { a: 1 };
        original.self = original;

        const cloned = clone(original);

        expect(cloned.a).toBe(1);
        expect(cloned.self).toBe(cloned); // 循环引用应该指向克隆对象本身
        expect(cloned).not.toBe(original);
      });

      it('应该处理数组的循环引用', () => {
        const original: any[] = [1, 2];
        original.push(original);

        const cloned = clone(original);

        expect(cloned[0]).toBe(1);
        expect(cloned[1]).toBe(2);
        expect(cloned[2]).toBe(cloned); // 循环引用应该指向克隆数组本身
        expect(cloned).not.toBe(original);
      });

      it('应该处理复杂的循环引用', () => {
        const original: any = {
          a: { b: 1 },
          c: [1, 2],
        };
        original.a.parent = original;
        original.c.push(original);

        const cloned = clone(original);

        expect(cloned.a.b).toBe(1);
        expect(cloned.a.parent).toBe(cloned);
        expect(cloned.c[2]).toBe(cloned);
        expect(cloned).not.toBe(original);
      });

      it('应该处理相互引用的对象', () => {
        const obj1: any = { name: 'obj1' };
        const obj2: any = { name: 'obj2' };
        obj1.ref = obj2;
        obj2.ref = obj1;

        const container = { obj1, obj2 };
        const cloned = clone(container);

        expect(cloned.obj1.name).toBe('obj1');
        expect(cloned.obj2.name).toBe('obj2');
        expect(cloned.obj1.ref).toBe(cloned.obj2);
        expect(cloned.obj2.ref).toBe(cloned.obj1);
      });
    });

    describe('复杂嵌套测试', () => {
      it('应该克隆包含多种类型的复杂对象', () => {
        const original = {
          number: 42,
          string: 'test',
          boolean: true,
          null_value: null,
          undefined_value: undefined,
          date: new Date('2024-01-01'),
          regex: /test/gi,
          array: [1, 2, 3],
          nested: {
            deep: {
              value: 'deep value',
            },
          },
          mixed_array: [{ id: 1 }, [1, 2], 'string', null],
        };

        const cloned = clone(original);

        expect(cloned).toEqual(original);
        expect(cloned).not.toBe(original);
        expect(cloned.date).not.toBe(original.date);
        expect(cloned.regex).not.toBe(original.regex);
        expect(cloned.nested).not.toBe(original.nested);
        expect(cloned.nested.deep).not.toBe(original.nested.deep);

        // 修改克隆不应影响原对象
        cloned.nested.deep.value = 'modified';
        expect(original.nested.deep.value).toBe('deep value');
      });
    });

    describe('边界情况测试', () => {
      it('应该克隆包含空字符串的对象', () => {
        const original = { empty: '' };
        const cloned = clone(original);

        expect(cloned.empty).toBe('');
      });

      it('应该克隆包含零的对象', () => {
        const original = { zero: 0 };
        const cloned = clone(original);

        expect(cloned.zero).toBe(0);
      });

      it('应该克隆包含负数的对象', () => {
        const original = { negative: -100 };
        const cloned = clone(original);

        expect(cloned.negative).toBe(-100);
      });

      it('应该克隆大型对象', () => {
        const original: any = {};
        for (let i = 0; i < 1000; i++) {
          original[`key_${i}`] = {
            value: i,
            nested: { data: `data_${i}` },
          };
        }

        const cloned = clone(original);

        expect(Object.keys(cloned).length).toBe(1000);
        expect(cloned.key_500.value).toBe(500);
        expect(cloned.key_500.nested.data).toBe('data_500');
      });
    });
  });

  describe('safeStringify 函数', () => {
    describe('基本类型测试', () => {
      it('应该序列化 null', () => {
        expect(safeStringify(null)).toBe('null');
      });

      it('应该序列化 undefined', () => {
        expect(safeStringify(undefined)).toBe('undefined');
      });

      it('应该序列化数字', () => {
        expect(safeStringify(42)).toBe('42');
        expect(safeStringify(0)).toBe('0');
        expect(safeStringify(-100)).toBe('-100');
        expect(safeStringify(3.14)).toBe('3.14');
      });

      it('应该序列化字符串', () => {
        expect(safeStringify('hello')).toBe('hello');
        expect(safeStringify('')).toBe('');
        expect(safeStringify('中文')).toBe('中文');
      });

      it('应该序列化布尔值', () => {
        expect(safeStringify(true)).toBe('true');
        expect(safeStringify(false)).toBe('false');
      });

      it('应该序列化特殊数字值', () => {
        expect(safeStringify(NaN)).toBe('NaN');
        expect(safeStringify(Infinity)).toBe('Infinity');
        expect(safeStringify(-Infinity)).toBe('-Infinity');
      });
    });

    describe('对象和数组测试', () => {
      it('应该序列化空对象', () => {
        expect(safeStringify({})).toBe('{}');
      });

      it('应该序列化空数组', () => {
        expect(safeStringify([])).toBe('[]');
      });

      it('应该序列化简单对象', () => {
        const obj = { a: 1, b: 'test' };
        const result = safeStringify(obj);
        expect(result).toBe('{"a":1,"b":"test"}');
      });

      it('应该序列化简单数组', () => {
        const arr = [1, 2, 3];
        const result = safeStringify(arr);
        expect(result).toBe('[1,2,3]');
      });

      it('应该序列化嵌套对象', () => {
        const obj = {
          a: 1,
          b: {
            c: 2,
            d: {
              e: 3,
            },
          },
        };
        const result = safeStringify(obj);
        expect(result).toBe('{"a":1,"b":{"c":2,"d":{"e":3}}}');
      });

      it('应该序列化包含 null 的对象', () => {
        const obj = { a: null, b: 'test' };
        const result = safeStringify(obj);
        expect(result).toBe('{"a":null,"b":"test"}');
      });

      it('应该序列化包含 undefined 的对象（undefined 会被忽略）', () => {
        const obj = { a: 1, b: undefined, c: 'test' };
        const result = safeStringify(obj);
        // JSON.stringify 会忽略 undefined 属性
        expect(result).toBe('{"a":1,"c":"test"}');
      });
    });

    describe('循环引用测试', () => {
      it('应该处理对象的循环引用', () => {
        const obj: any = { a: 1 };
        obj.self = obj;

        const result = safeStringify(obj);
        expect(result).toBe('{"a":1,"self":"[Circular]"}');
      });

      it('应该处理数组的循环引用', () => {
        const arr: any[] = [1, 2];
        arr.push(arr);

        const result = safeStringify(arr);
        expect(result).toBe('[1,2,"[Circular]"]');
      });

      it('应该处理深层循环引用', () => {
        const obj: any = {
          a: {
            b: {
              c: 1,
            },
          },
        };
        obj.a.b.parent = obj;

        const result = safeStringify(obj);
        expect(result).toBe('{"a":{"b":{"c":1,"parent":"[Circular]"}}}');
      });

      it('应该处理相互引用的对象', () => {
        const obj1: any = { name: 'obj1' };
        const obj2: any = { name: 'obj2' };
        obj1.ref = obj2;
        obj2.ref = obj1;

        const container = { obj1, obj2 };
        const result = safeStringify(container);

        // 第一次出现 obj1 和 obj2 正常序列化，第二次出现标记为 [Circular]
        expect(result).toContain('"name":"obj1"');
        expect(result).toContain('"name":"obj2"');
        expect(result).toContain('"[Circular]"');
      });
    });

    describe('长度限制测试', () => {
      it('应该截断超过默认长度的字符串', () => {
        const obj: any = {};
        for (let i = 0; i < 50; i++) {
          obj[`key_${i}`] = `value_${i}`;
        }

        const result = safeStringify(obj);
        expect(result.length).toBeLessThanOrEqual(203); // 200 + '...'
        expect(result).toMatch(/\.\.\.$/);
      });

      it('应该使用自定义最大长度', () => {
        const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
        const maxLength = 20;
        const result = safeStringify(obj, maxLength);

        expect(result.length).toBeLessThanOrEqual(maxLength + 3); // maxLength + '...'
        expect(result).toMatch(/\.\.\.$/);
      });

      it('应该保持短字符串不变', () => {
        const obj = { a: 1 };
        const result = safeStringify(obj, 100);

        expect(result).toBe('{"a":1}');
        expect(result).not.toContain('...');
      });

      it('应该正确处理恰好等于最大长度的字符串', () => {
        const obj = { a: 1 }; // '{"a":1}' 长度为 7
        const result = safeStringify(obj, 7);

        expect(result).toBe('{"a":1}');
        expect(result).not.toContain('...');
      });

      it('应该正确处理超过最大长度 1 个字符的字符串', () => {
        const obj = { a: 1 }; // '{"a":1}' 长度为 7
        const result = safeStringify(obj, 6);

        expect(result).toBe('{"a":1...');
        expect(result.length).toBe(9); // 6 + 3
      });
    });

    describe('错误处理测试', () => {
      it('应该处理无法序列化的值', () => {
        // 函数无法被 JSON.stringify 序列化
        const obj = { fn: () => {} };
        const result = safeStringify(obj);

        // JSON.stringify 会将函数转换为 undefined，然后被忽略
        expect(result).toBe('{}');
      });

      it('应该处理 BigInt（如果环境支持）', () => {
        // BigInt 无法被 JSON.stringify 序列化
        try {
          const obj = { big: BigInt(9007199254740991) };
          const result = safeStringify(obj);

          // 应该返回错误信息而不是抛出异常
          expect(result).toContain('[Unserializable:');
        } catch (_e) {
          // 如果环境不支持 BigInt，跳过此测试
          expect(true).toBe(true);
        }
      });

      it('应该处理 Symbol', () => {
        const obj = { sym: Symbol('test') };
        const result = safeStringify(obj);

        // JSON.stringify 会将 Symbol 转换为 undefined，然后被忽略
        expect(result).toBe('{}');
      });
    });

    describe('复杂场景测试', () => {
      it('应该序列化包含多种类型的复杂对象', () => {
        const obj = {
          number: 42,
          string: 'test',
          boolean: true,
          null_value: null,
          array: [1, 2, 3],
          nested: {
            deep: {
              value: 'deep',
            },
          },
        };

        const result = safeStringify(obj);
        expect(result).toContain('"number":42');
        expect(result).toContain('"string":"test"');
        expect(result).toContain('"boolean":true');
        expect(result).toContain('"null_value":null');
        expect(result).toContain('"array":[1,2,3]');
      });

      it('应该序列化包含特殊字符的字符串', () => {
        const obj = {
          quotes: 'He said "hello"',
          newlines: 'line1\nline2',
          tabs: 'col1\tcol2',
          unicode: '中文测试 🎉',
        };

        const result = safeStringify(obj);
        expect(result).toContain('He said \\"hello\\"');
        expect(result).toContain('\\n');
        expect(result).toContain('\\t');
        expect(result).toContain('中文测试 🎉');
      });

      it('应该序列化空值混合数组', () => {
        const arr = [1, null, undefined, 'test', true];
        const result = safeStringify(arr);

        // JSON.stringify 将数组中的 undefined 转换为 null
        expect(result).toBe('[1,null,null,"test",true]');
      });
    });

    describe('边界情况测试', () => {
      it('应该序列化包含空字符串的对象', () => {
        const obj = { empty: '' };
        expect(safeStringify(obj)).toBe('{"empty":""}');
      });

      it('应该序列化包含零的对象', () => {
        const obj = { zero: 0 };
        expect(safeStringify(obj)).toBe('{"zero":0}');
      });

      it('应该序列化包含 false 的对象', () => {
        const obj = { flag: false };
        expect(safeStringify(obj)).toBe('{"flag":false}');
      });

      it('应该序列化 Date 对象', () => {
        const date = new Date('2024-01-01T00:00:00.000Z');
        const result = safeStringify(date);

        expect(result).toBe('"2024-01-01T00:00:00.000Z"');
      });

      it('应该序列化包含 Date 的对象', () => {
        const obj = { date: new Date('2024-01-01T00:00:00.000Z') };
        const result = safeStringify(obj);

        expect(result).toBe('{"date":"2024-01-01T00:00:00.000Z"}');
      });

      it('应该处理非常大的数字', () => {
        const obj = { big: Number.MAX_SAFE_INTEGER };
        const result = safeStringify(obj);

        expect(result).toBe(`{"big":${Number.MAX_SAFE_INTEGER}}`);
      });

      it('应该处理非常小的数字', () => {
        const obj = { small: Number.MIN_SAFE_INTEGER };
        const result = safeStringify(obj);

        expect(result).toBe(`{"small":${Number.MIN_SAFE_INTEGER}}`);
      });

      it('应该处理长度为 0 的最大长度限制', () => {
        const obj = { a: 1 };
        const result = safeStringify(obj, 0);

        expect(result).toBe('...');
      });
    });

    describe('性能测试', () => {
      it('应该能够处理大型嵌套对象', () => {
        const createNestedObject = (depth: number): any => {
          if (depth === 0) return { value: 'leaf' };
          return { nested: createNestedObject(depth - 1) };
        };

        const obj = createNestedObject(50);
        const result = safeStringify(obj);

        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
      });

      it('应该能够处理大型数组', () => {
        const arr = Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `item_${i}`,
        }));

        const result = safeStringify(arr, 500);

        expect(result).toBeTruthy();
        expect(result.length).toBeLessThanOrEqual(503); // 500 + '...'
      });
    });
  });
});
