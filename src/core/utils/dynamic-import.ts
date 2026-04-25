/**
 * 动态导入工具
 *
 * 提供运行时动态导入模块的能力，避免编译时依赖检查。
 * 用于可选依赖（如 onnxruntime-node, sharp, hnswlib-node 等）的延迟加载。
 */

/**
 * 模块导入结果缓存
 * 避免重复导入同一模块
 */
const moduleCache = new Map<string, unknown>();

/**
 * 动态导入模块
 *
 * 使用 Function 构造器绕过编译时的模块检查，
 * 允许在运行时按需加载可选依赖。
 *
 * @param modulePath 模块路径（npm 包名或相对路径）
 * @returns Promise<T> 模块导出对象
 *
 * @example
 * // 导入 npm 包
 * const ort = await dynamicImport<typeof import('onnxruntime-node')>('onnxruntime-node');
 *
 * @example
 * // 导入并获取默认导出
 * const sharpModule = await dynamicImport<{ default: typeof import('sharp') }>('sharp');
 * const sharp = sharpModule.default;
 */
export async function dynamicImport<T = unknown>(modulePath: string): Promise<T> {
  // 检查缓存
  if (moduleCache.has(modulePath)) {
    return moduleCache.get(modulePath) as T;
  }

  // 使用 Function 构造器动态导入
  // 这可以避免打包工具（如 webpack/esbuild）在编译时尝试解析模块
  const loader = new Function('modulePath', 'return import(modulePath)') as (
    path: string
  ) => Promise<T>;

  const module = await loader(modulePath);

  // 缓存结果
  moduleCache.set(modulePath, module);

  return module;
}

/**
 * 安全地动态导入模块
 *
 * 如果模块不存在，返回 null 而不是抛出错误。
 * 适用于检测可选依赖是否已安装。
 *
 * @param modulePath 模块路径
 * @returns Promise<T | null> 模块导出对象，或 null（如果模块不存在）
 *
 * @example
 * const sharp = await safeDynamicImport<typeof import('sharp')>('sharp');
 * if (!sharp) {
 *   console.warn('sharp is not installed, image processing disabled');
 * }
 */
export async function safeDynamicImport<T = unknown>(modulePath: string): Promise<T | null> {
  try {
    return await dynamicImport<T>(modulePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/**
 * 检查模块是否可用
 *
 * @param modulePath 模块路径
 * @returns Promise<boolean> 模块是否已安装
 */
export async function isModuleAvailable(modulePath: string): Promise<boolean> {
  const result = await safeDynamicImport(modulePath);
  return result !== null;
}

/**
 * 清除模块缓存
 *
 * 主要用于测试场景
 *
 * @param modulePath 可选，指定要清除的模块。不传则清除全部。
 */
export function clearModuleCache(modulePath?: string): void {
  if (modulePath) {
    moduleCache.delete(modulePath);
  } else {
    moduleCache.clear();
  }
}
