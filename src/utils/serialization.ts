/**
 * 序列化工具函数
 * 提供安全的 JSON 序列化，处理循环引用、特殊值等
 */

/**
 * 深度克隆对象
 *
 * 使用 structuredClone（如果可用）或 JSON 序列化方式
 * 支持处理循环引用
 *
 * @param obj - 要克隆的对象
 * @returns 克隆后的对象
 * @throws Error - 如果对象无法序列化
 *
 * @example
 * const original = { a: 1, b: { c: 2 } };
 * const cloned = clone(original);
 * cloned.b.c = 3;
 * console.log(original.b.c); // 2 (original unchanged)
 */
export function clone<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // 优先使用 structuredClone（Node.js 17+）
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // 如果 structuredClone 失败，回退到 JSON 方式
    }
  }

  // 使用 JSON 方式克隆（处理循环引用）
  const seen = new WeakMap();

  function deepClone(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags);
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return seen.get(value);
      }
      const arr: unknown[] = [];
      seen.set(value, arr);
      for (const item of value) {
        arr.push(deepClone(item));
      }
      return arr;
    }

    if (seen.has(value)) {
      return seen.get(value);
    }

    const cloned: Record<string, unknown> = {};
    seen.set(value, cloned);

    for (const key of Object.keys(value as Record<string, unknown>)) {
      cloned[key] = deepClone((value as Record<string, unknown>)[key]);
    }

    return cloned;
  }

  return deepClone(obj) as T;
}

/**
 * 安全的 JSON 序列化（处理循环引用）
 *
 * 特性：
 * - 处理循环引用（转为 '[Circular]'）
 * - 处理 undefined、null、NaN、Infinity
 * - 限制输出长度
 * - 不会抛出异常
 *
 * @param obj - 要序列化的对象
 * @param maxLength - 最大输出长度（默认 200）
 * @returns 序列化后的字符串
 */
export function safeStringify(obj: any, maxLength: number = 200): string {
  try {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';
    if (typeof obj !== 'object') return String(obj);

    // 处理循环引用
    const seen = new WeakSet();
    const str = JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });

    return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
  } catch {
    return `[Unserializable: ${typeof obj}]`;
  }
}
