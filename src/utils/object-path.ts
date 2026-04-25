/**
 * 对象路径处理工具
 * 提供统一的对象路径访问和设置接口
 */

/**
 * 解析路径字符串为键数组
 * @param path 路径字符串 (如 "vars.a.b.c")
 * @returns 键数组 (如 ["a", "b", "c"])
 */
export function parsePath(path: string): string[] {
  return path.replace(/^vars\./, '').split('.');
}

/**
 * 通过路径获取对象值
 * @param obj 对象
 * @param path 路径字符串 (如 "vars.a.b.c" 或 "a.b.c")
 * @returns 值或 undefined
 */
export function getByPath(obj: any, path: string): any {
  const keys = parsePath(path);
  let value = obj;

  for (const key of keys) {
    if (value === undefined || value === null) {
      return undefined;
    }
    value = value[key];
  }

  return value;
}

/**
 * 通过路径设置对象值
 * @param obj 对象
 * @param path 路径字符串 (如 "vars.a.b.c" 或 "a.b.c")
 * @param value 要设置的值
 */
export function setByPath(obj: any, path: string, value: any): void {
  const keys = parsePath(path);
  let target = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!target[key] || typeof target[key] !== 'object') {
      target[key] = {};
    }
    target = target[key];
  }

  target[keys[keys.length - 1]] = value;
}

/**
 * 检查路径是否存在
 * @param obj 对象
 * @param path 路径字符串
 * @returns 是否存在
 */
export function hasPath(obj: any, path: string): boolean {
  const value = getByPath(obj, path);
  return value !== undefined;
}

/**
 * 删除路径对应的值
 * @param obj 对象
 * @param path 路径字符串
 * @returns 是否成功删除
 */
export function deleteByPath(obj: any, path: string): boolean {
  const keys = parsePath(path);
  let target = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!target[key] || typeof target[key] !== 'object') {
      return false;
    }
    target = target[key];
  }

  const lastKey = keys[keys.length - 1];
  if (lastKey in target) {
    delete target[lastKey];
    return true;
  }

  return false;
}
