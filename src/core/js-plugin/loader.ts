/**
 * JS 插件加载器
 *
 * 负责提取 .tsai 文件、验证清单、加载模块
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as Module from 'module';
import AdmZip from 'adm-zip';
import type { JSPluginManifest, JSPluginModule } from '../../types/js-plugin';
import { assertSafeZipEntryPath, assertSafeZipMetadata } from '../../utils/zip-safety';

function isLikelyBrowserExtensionManifest(manifest: any): boolean {
  if (!manifest || typeof manifest !== 'object') return false;

  return (
    typeof manifest.manifest_version === 'number' ||
    !!manifest.background ||
    Array.isArray(manifest.content_scripts) ||
    !!manifest.action ||
    !!manifest.browser_action
  );
}

/**
 * 验证插件清单
 */
export function validateManifest(manifest: any): manifest is JSPluginManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be an object');
  }

  // 验证必需字段
  if (!manifest.id || typeof manifest.id !== 'string') {
    if (isLikelyBrowserExtensionManifest(manifest)) {
      throw new Error(
        'Manifest.id is required and must be a string.\n' +
          'The selected manifest looks like a Chrome/Edge browser extension manifest, not an Airpa JS plugin.\n' +
          'Airpa plugins must provide these fields in manifest.json: id, name, version, author, main.'
      );
    }

    throw new Error('Manifest.id is required and must be a string');
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('Manifest.name is required and must be a string');
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('Manifest.version is required and must be a string');
  }

  if (!manifest.author || typeof manifest.author !== 'string') {
    throw new Error('Manifest.author is required and must be a string');
  }

  if (!manifest.main || typeof manifest.main !== 'string') {
    throw new Error('Manifest.main is required and must be a string');
  }

  // 验证插件 ID 格式 (字母、数字、下划线 - SQL安全字符)
  if (!/^[a-zA-Z0-9_]+$/.test(manifest.id)) {
    throw new Error(
      'Plugin ID must only contain alphanumeric characters and underscores (a-z, A-Z, 0-9, _).\n' +
        'Example: use "doudian_publisher" instead of "doudian-publisher"'
    );
  }

  // 验证版本号格式 (语义化版本)
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Version must follow semantic versioning (e.g., 1.0.0)');
  }

  return true;
}

/**
 * 读取并验证插件清单
 */
export async function readManifest(pluginDir: string): Promise<JSPluginManifest> {
  const manifestPath = path.join(pluginDir, 'manifest.json');

  if (!(await fs.pathExists(manifestPath))) {
    throw new Error('manifest.json not found in plugin directory');
  }

  try {
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    validateManifest(manifest);

    return manifest as JSPluginManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nPlugin directory: ${pluginDir}\nManifest path: ${manifestPath}`);
  }
}

/**
 * 验证路径是否在指定目录内（防止路径穿越攻击）
 */
function isPathWithinDirectory(targetPath: string, directory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDir = path.resolve(directory);
  return resolvedTarget.startsWith(resolvedDir + path.sep) || resolvedTarget === resolvedDir;
}

let hostModulePathsPatched = false;

function patchHostModuleResolution(): void {
  if (hostModulePathsPatched) return;
  hostModulePathsPatched = true;

  const globalPaths = (Module as any).globalPaths as string[] | undefined;
  if (!Array.isArray(globalPaths)) return;

  const candidates = new Set<string>();
  const resourcesPath = (process as any).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.add(path.join(resourcesPath, 'app.asar', 'node_modules'));
    candidates.add(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules'));
  }
  const cwd = process.cwd();
  if (cwd) {
    candidates.add(path.join(cwd, 'node_modules'));
  }

  for (const candidate of candidates) {
    if (!globalPaths.includes(candidate)) {
      globalPaths.push(candidate);
    }
  }
}

/**
 * 加载插件模块
 *
 * 使用 require() 直接加载 - 无沙箱隔离
 * 注意：已添加路径穿越检测，防止恶意 manifest.main 配置
 */
export function loadPluginModule(pluginDir: string, mainFile: string): JSPluginModule {
  patchHostModuleResolution();

  // 安全检查：防止路径穿越攻击
  // 禁止绝对路径
  if (path.isAbsolute(mainFile)) {
    throw new Error(
      `Security error: main file cannot be an absolute path: ${mainFile}\n` +
        'The main field in manifest.json must be a relative path within the plugin directory.'
    );
  }

  // 禁止 .. 路径穿越
  if (mainFile.includes('..')) {
    throw new Error(
      `Security error: main file cannot contain path traversal (..): ${mainFile}\n` +
        'The main field in manifest.json must not navigate outside the plugin directory.'
    );
  }

  const mainPath = path.join(pluginDir, mainFile);

  // 二次验证：确保解析后的路径仍在插件目录内
  if (!isPathWithinDirectory(mainPath, pluginDir)) {
    throw new Error(
      `Security error: resolved main path escapes plugin directory.\n` +
        `Plugin dir: ${pluginDir}\n` +
        `Resolved path: ${path.resolve(mainPath)}`
    );
  }

  if (!fs.existsSync(mainPath)) {
    throw new Error(`Main file not found: ${mainFile}`);
  }

  // 清除 require 缓存（处理 Junction/符号链接路径）
  try {
    // 1. 获取真实路径（解析 Junction/符号链接）
    const realMainPath = fs.realpathSync(mainPath);
    const normalizedPath = path.normalize(mainPath);

    // 2. 收集所有可能的路径变体
    const pathsToDelete = [
      mainPath, // Junction/符号链接路径
      realMainPath, // 真实路径
      normalizedPath, // 规范化路径
    ];

    // 添加 require.resolve() 的结果
    try {
      pathsToDelete.push(require.resolve(mainPath));
    } catch {
      // 忽略 resolve 失败的情况
    }

    // 3. 清除所有路径的缓存
    const deleted = new Set<string>();
    for (const p of pathsToDelete) {
      if (require.cache[p]) {
        delete require.cache[p];
        deleted.add(p);
      }
    }

    if (deleted.size > 0) {
      console.log(`  🧹 Cleared cache for main file:`);
      deleted.forEach((p) => console.log(`    - ${p}`));
    }
  } catch (error) {
    console.warn(`  ⚠️  Failed to clear cache:`, error);
  }

  // 直接 require - 无沙箱隔离
  const module = require(mainPath);

  // 支持 ES6 default export 和 CommonJS
  const pluginModule = module.default || module;

  // 验证模块基本结构
  if (!pluginModule || typeof pluginModule !== 'object') {
    throw new Error('Plugin module must export an object');
  }

  // 检查新架构的入口点
  const hasActivate = typeof pluginModule.activate === 'function';
  const hasCommands = pluginModule.commands && typeof pluginModule.commands === 'object';

  // 必须至少有一个新架构的入口点
  if (!hasActivate && !hasCommands) {
    throw new Error(
      'Plugin module must have activate() function and/or commands object.\n' +
        'The old execute() pattern is no longer supported.'
    );
  }

  return pluginModule as JSPluginModule;
}

/**
 * 复制插件目录到目标位置
 */
export async function copyPluginDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.ensureDir(targetDir);
  await fs.copy(sourceDir, targetDir, {
    overwrite: true,
    errorOnExist: false,
  });
}

/**
 * 删除插件目录
 */
export async function removePluginDirectory(pluginDir: string): Promise<void> {
  if (await fs.pathExists(pluginDir)) {
    await fs.remove(pluginDir);
  }
}

/**
 * 将插件目录打包为 .tsai 文件
 *
 * @param pluginDir - 插件目录路径（必须包含 manifest.json）
 * @param outputPath - 输出的 .tsai 文件路径（可选，默认为 pluginDir 同级目录下的 {pluginId}.tsai）
 * @returns 生成的 .tsai 文件路径
 */
export async function packPlugin(pluginDir: string, outputPath?: string): Promise<string> {
  // 1. 验证插件目录存在
  if (!(await fs.pathExists(pluginDir))) {
    throw new Error(`Plugin directory not found: ${pluginDir}`);
  }

  const stats = await fs.stat(pluginDir);
  if (!stats.isDirectory()) {
    throw new Error(`Expected a directory, got a file: ${pluginDir}`);
  }

  // 2. 读取并验证 manifest
  const manifest = await readManifest(pluginDir);
  console.log(`[PACK] Packing plugin: ${manifest.name} (${manifest.id}) v${manifest.version}`);

  // 3. 确定输出路径
  const tsaiFileName = `${manifest.id}.tsai`;
  const finalOutputPath = outputPath || path.join(path.dirname(pluginDir), tsaiFileName);

  // 4. 创建 zip 压缩包
  const zip = new AdmZip();

  // 递归添加目录内容
  const addDirectoryToZip = async (dirPath: string, zipPath: string = '') => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // 递归添加子目录
        await addDirectoryToZip(fullPath, entryZipPath);
      } else if (entry.isFile()) {
        // 添加文件
        const content = await fs.readFile(fullPath);
        zip.addFile(entryZipPath, content);
      }
    }
  };

  await addDirectoryToZip(pluginDir);

  // 5. 写入 .tsai 文件
  await fs.ensureDir(path.dirname(finalOutputPath));
  zip.writeZip(finalOutputPath);

  console.log(`[PACK] Plugin packed successfully: ${finalOutputPath}`);
  return finalOutputPath;
}

/**
 * 安全解压 ZIP 文件（带 ZipSlip 防护）
 *
 * @param zip - AdmZip 实例
 * @param targetDir - 目标目录
 */
async function safeExtractAll(zip: AdmZip, targetDir: string): Promise<void> {
  const entries = zip.getEntries();
  assertSafeZipMetadata(entries, 'plugin package');

  for (const entry of entries) {
    const entryPath = entry.entryName;
    const targetPath = assertSafeZipEntryPath(entryPath, targetDir);

    if (entry.isDirectory) {
      await fs.ensureDir(targetPath);
    } else {
      // 确保父目录存在
      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, entry.getData());
    }
  }
}

/**
 * 解压 .tsai 文件到指定目录
 *
 * 安全特性：
 * - ZipSlip 防护：检测并拒绝恶意路径
 * - 路径穿越检测：防止 ../ 攻击
 *
 * @param tsaiPath - .tsai 文件路径
 * @param extractDir - 解压目标目录
 * @returns 解压后的插件目录路径
 */
export async function unpackPlugin(tsaiPath: string, extractDir: string): Promise<string> {
  // 1. 验证文件存在
  if (!(await fs.pathExists(tsaiPath))) {
    throw new Error(`Plugin file not found: ${tsaiPath}`);
  }

  const stats = await fs.stat(tsaiPath);
  if (!stats.isFile()) {
    throw new Error(`Expected a file, got a directory: ${tsaiPath}`);
  }

  console.log(`[UNPACK] Extracting plugin from: ${tsaiPath}`);

  // 2. 创建临时解压目录
  const tempDir = path.join(extractDir, `_temp_${Date.now()}`);
  await fs.ensureDir(tempDir);

  try {
    // 3. 安全解压 .tsai 文件（带 ZipSlip 防护）
    const zip = new AdmZip(tsaiPath);
    await safeExtractAll(zip, tempDir);

    // 4. 检测并处理嵌套目录
    const manifestPath = path.join(tempDir, 'manifest.json');

    if (!(await fs.pathExists(manifestPath))) {
      // manifest.json 不在根目录，检查是否有嵌套目录
      console.log(`[UNPACK] manifest.json not found in root, checking for nested directory...`);

      const entries = await fs.readdir(tempDir, { withFileTypes: true });
      const subdirs = entries.filter((entry) => entry.isDirectory());

      if (subdirs.length === 1) {
        // 只有一个子目录，检查该目录是否包含 manifest.json
        const subDirPath = path.join(tempDir, subdirs[0].name);
        const nestedManifestPath = path.join(subDirPath, 'manifest.json');

        if (await fs.pathExists(nestedManifestPath)) {
          console.log(`[UNPACK] Found manifest.json in nested directory: ${subdirs[0].name}`);
          // 将子目录的内容移到临时目录
          const files = await fs.readdir(subDirPath);
          for (const file of files) {
            await fs.move(path.join(subDirPath, file), path.join(tempDir, file), {
              overwrite: true,
            });
          }
          // 删除空的子目录
          await fs.remove(subDirPath);
          console.log(`[UNPACK] Flattened nested directory structure`);
        } else {
          throw new Error(
            `Invalid plugin structure: manifest.json not found in root or nested directory`
          );
        }
      } else if (subdirs.length === 0) {
        throw new Error(
          `Invalid plugin structure: manifest.json not found and no subdirectories exist`
        );
      } else {
        throw new Error(
          `Invalid plugin structure: manifest.json not found. ` +
            `Expected manifest.json in root, or a single directory containing it. ` +
            `Found ${subdirs.length} subdirectories.`
        );
      }
    }

    // 5. 读取 manifest 获取插件 ID
    const manifest = await readManifest(tempDir);
    console.log(
      `[UNPACK] Plugin identified: ${manifest.name} (${manifest.id}) v${manifest.version}`
    );

    // 6. 移动到最终目录
    const targetDir = path.join(extractDir, manifest.id);

    // 如果目标目录已存在，先删除
    if (await fs.pathExists(targetDir)) {
      console.log(`[UNPACK] Removing existing plugin directory: ${targetDir}`);
      await fs.remove(targetDir);
    }

    await fs.move(tempDir, targetDir);

    console.log(`[UNPACK] Plugin extracted successfully to: ${targetDir}`);
    return targetDir;
  } catch (error) {
    // 清理临时目录
    await fs.remove(tempDir).catch(() => {});
    throw error;
  }
}

/**
 * 从 .tsai 文件或目录中提取插件
 *
 * 支持的格式：
 * - 目录：直接复制到目标位置
 * - .tsai 文件：解压到目标位置
 * - .zip 文件：解压到目标位置
 */
export async function extractPlugin(pluginPath: string, extractDir: string): Promise<string> {
  const stats = await fs.stat(pluginPath);

  if (stats.isDirectory()) {
    // 如果是目录，直接复制
    const manifest = await readManifest(pluginPath);
    const targetDir = path.join(extractDir, manifest.id);
    await copyPluginDirectory(pluginPath, targetDir);
    return targetDir;
  } else {
    // 如果是文件，检查扩展名
    const ext = path.extname(pluginPath).toLowerCase();

    if (ext === '.tsai' || ext === '.zip') {
      // 使用 unpackPlugin 解压
      return await unpackPlugin(pluginPath, extractDir);
    } else {
      throw new Error(
        `Invalid plugin file format. Expected .tsai, .zip, or directory. Got: ${ext}`
      );
    }
  }
}
