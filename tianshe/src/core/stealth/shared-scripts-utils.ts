/**
 * 共享脚本生成模块
 *
 * 提供可在 CDP 和直接 JS 注入两种方式下复用的脚本生成函数
 * 避免 cdp-emulation.ts 和 script-generator.ts 之间的代码重复
 */

// ========== 工具函数 ==========

/**
 * 基于种子的伪随机数生成器（Mulberry32 算法）
 *
 * 用于生成确定性随机数，确保同一种子产生相同序列
 *
 * @param seed - 随机种子
 * @returns 返回 0-1 之间的伪随机数的函数
 */

export function createSeededRandom(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 简单的字符串哈希函数（djb2 算法）
 *
 * 用于从字符串生成确定性种子
 *
 * @param str - 输入字符串
 * @returns 哈希值
 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash; // 转换为 32 位整数
  }
  return Math.abs(hash);
}

// ========== WebGL 脚本 ==========

/**
 * 生成 WebGL 参数覆盖脚本
 *
 * 覆盖 WebGLRenderingContext.getParameter 以返回自定义的 GPU 信息
 *
 * @param webgl - WebGL 配置
 * @param noiseSeed - 可选的噪声种子，提供时会为 WebGL 添加微小噪声
 * @returns JavaScript 代码字符串
 */
