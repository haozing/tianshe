/**
 * LRU 缓存（最近最少使用）
 * 用于管理有限资源池，自动回收最久未使用的项
 */
export class LRUCache<K> {
  private cache: Map<K, number> = new Map(); // key -> 最后访问时间戳
  private maxSize: number;

  constructor(maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('maxSize must be greater than 0');
    }
    this.maxSize = maxSize;
  }

  /**
   * 添加项到缓存
   */
  add(key: K): void {
    this.cache.set(key, Date.now());
  }

  /**
   * 访问项（更新时间戳）
   */
  touch(key: K): void {
    if (this.cache.has(key)) {
      this.cache.set(key, Date.now());
    }
  }

  /**
   * 移除项
   */
  remove(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 回收最旧的项（LRU 算法）
   * @returns 被回收的 key，如果缓存未满则返回 undefined
   */
  evict(): K | undefined {
    if (this.cache.size < this.maxSize) {
      return undefined;
    }

    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, time] of this.cache.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }

    return oldestKey;
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 检查是否包含某个 key
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 获取所有 key
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取项的最后访问时间
   */
  getAccessTime(key: K): number | undefined {
    return this.cache.get(key);
  }

  /**
   * 获取最大容量
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * 是否已满
   */
  isFull(): boolean {
    return this.cache.size >= this.maxSize;
  }
}
