/**
 * Bytecode Runner
 *
 * 提供V8字节码(.jsc文件)执行功能
 * 使用bytenode库编译和运行V8字节码，提供更高的代码保护
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../logger';

const logger = createLogger('BytecodeRunner');

// Lazy load bytenode to avoid errors if not installed
let bytenode: any = null;

/**
 * 字节码执行配置
 */
export interface BytecodeConfig {
  /** 字节码文件路径或Buffer */
  source: string | Buffer;
  /** 源文件名（用于错误堆栈） */
  filename?: string;
  /** 是否为临时文件（执行后删除） */
  isTemporary?: boolean;
}

/**
 * V8字节码运行器
 *
 * @example
 * const runner = new BytecodeRunner();
 * const moduleExports = await runner.runBytecode({
 *   source: '/path/to/module.jsc',
 *   filename: 'premium-feature.jsc'
 * });
 */
export class BytecodeRunner {
  private tempDir: string;
  private bytenodeInitialized: boolean = false;

  constructor() {
    // 创建临时目录
    this.tempDir = path.join(os.tmpdir(), 'airpa-bytecode');
    fs.ensureDirSync(this.tempDir);
  }

  /**
   * 初始化bytenode
   */
  private async initBytenode(): Promise<void> {
    if (this.bytenodeInitialized) {
      return;
    }

    try {
      // 动态加载bytenode
      bytenode = require('bytenode');
      this.bytenodeInitialized = true;
    } catch (error: any) {
      throw new Error(
        'Bytenode module not found. Please install it with: npm install bytenode\n' +
          'Error: ' +
          error.message
      );
    }
  }

  /**
   * 运行字节码
   *
   * @param config - 字节码配置
   * @returns 模块导出对象
   *
   * @example
   * // 从文件运行
   * const module = await runner.runBytecode({
   *   source: '/path/to/compiled.jsc'
   * });
   *
   * @example
   * // 从Buffer运行
   * const bytecodeBuffer = await helpers.network.get('https://server.com/module.jsc');
   * const module = await runner.runBytecode({
   *   source: bytecodeBuffer,
   *   filename: 'remote-module.jsc',
   *   isTemporary: true
   * });
   */
  async runBytecode(config: BytecodeConfig): Promise<any> {
    await this.initBytenode();

    let bytecodePath: string | undefined;
    let shouldCleanup = false;

    try {
      // 处理输入源
      if (typeof config.source === 'string') {
        // 文件路径
        bytecodePath = config.source;

        if (!(await fs.pathExists(bytecodePath))) {
          throw new Error(`Bytecode file not found: ${bytecodePath}`);
        }
      } else {
        // Buffer - 需要写入临时文件
        bytecodePath = await this.writeTemporaryBytecode(
          config.source,
          config.filename || 'temp.jsc'
        );
        shouldCleanup = true;
      }

      // 验证文件
      await this.validateBytecode(bytecodePath);

      // 运行字节码
      const moduleExports = this.executeBytecode(bytecodePath);

      // 清理临时文件
      if (shouldCleanup || config.isTemporary) {
        await this.cleanupFile(bytecodePath);
      }

      return moduleExports;
    } catch (error: any) {
      // 确保清理临时文件
      if (shouldCleanup && bytecodePath) {
        await this.cleanupFile(bytecodePath);
      }

      throw new Error(`Failed to run bytecode: ${error.message}`);
    }
  }

  /**
   * 编译JavaScript到字节码
   *
   * @param jsCode - JavaScript源代码
   * @param outputPath - 输出.jsc文件路径
   *
   * @example
   * await runner.compileToJSC(
   *   'module.exports = { hello: () => "world" }',
   *   '/path/to/output.jsc'
   * );
   */
  async compileToJSC(jsCode: string, outputPath: string): Promise<void> {
    await this.initBytenode();

    try {
      // 创建临时JS文件
      const tempJsPath = path.join(
        this.tempDir,
        `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.js`
      );

      // 写入JS代码
      await fs.writeFile(tempJsPath, jsCode, 'utf-8');

      // 编译为字节码
      await bytenode.compileFile({
        filename: tempJsPath,
        output: outputPath,
      });

      // 清理临时JS文件
      await this.cleanupFile(tempJsPath);
    } catch (error: any) {
      throw new Error(`Failed to compile JavaScript to bytecode: ${error.message}`);
    }
  }

  /**
   * 编译JavaScript文件到字节码
   *
   * @param jsPath - JavaScript源文件路径
   * @param jscPath - 输出.jsc文件路径（可选，默认为源文件同名.jsc）
   *
   * @example
   * await runner.compileFileToJSC('/path/to/source.js', '/path/to/output.jsc');
   * await runner.compileFileToJSC('/path/to/source.js'); // 输出到 source.jsc
   */
  async compileFileToJSC(jsPath: string, jscPath?: string): Promise<string> {
    await this.initBytenode();

    try {
      // 验证输入文件
      if (!(await fs.pathExists(jsPath))) {
        throw new Error(`Source file not found: ${jsPath}`);
      }

      // 确定输出路径
      const outputPath = jscPath || jsPath.replace(/\.js$/, '.jsc');

      // 编译
      await bytenode.compileFile({
        filename: jsPath,
        output: outputPath,
      });

      return outputPath;
    } catch (error: any) {
      throw new Error(`Failed to compile file to bytecode: ${error.message}`);
    }
  }

  /**
   * 写入临时字节码文件
   */
  private async writeTemporaryBytecode(buffer: Buffer, filename: string): Promise<string> {
    const tempPath = path.join(
      this.tempDir,
      `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${filename}`
    );

    await fs.writeFile(tempPath, buffer);

    return tempPath;
  }

  /**
   * 验证字节码文件
   */
  private async validateBytecode(bytecodePath: string): Promise<void> {
    try {
      const stats = await fs.stat(bytecodePath);

      // 检查文件大小
      if (stats.size === 0) {
        throw new Error('Bytecode file is empty');
      }

      // 检查文件扩展名
      if (!bytecodePath.endsWith('.jsc')) {
        logger.warn('Bytecode file does not have .jsc extension: ' + bytecodePath);
      }

      // 可以添加更多验证逻辑，如魔数检查等
    } catch (error: any) {
      throw new Error(`Bytecode validation failed: ${error.message}`);
    }
  }

  /**
   * 执行字节码文件
   */
  private executeBytecode(bytecodePath: string): any {
    try {
      // 使用bytenode require字节码
      // bytenode.runBytecodeFile返回模块的exports
      const moduleExports = require(bytecodePath);

      return moduleExports;
    } catch (error: any) {
      throw new Error(`Bytecode execution failed: ${error.message}`);
    }
  }

  /**
   * 清理文件
   */
  private async cleanupFile(filePath: string): Promise<void> {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
      }
    } catch (error: any) {
      // 清理失败不抛出错误，只记录警告
      logger.warn('Failed to cleanup file ' + filePath + ': ' + error.message);
    }
  }

  /**
   * 清理所有临时文件
   */
  async cleanupAll(): Promise<void> {
    try {
      await fs.emptyDir(this.tempDir);
    } catch (error: any) {
      logger.warn('Failed to cleanup temporary directory: ' + error.message);
    }
  }

  /**
   * 检查bytenode是否可用
   */
  static async isAvailable(): Promise<boolean> {
    try {
      require.resolve('bytenode');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 字节码工具函数
 */
export class BytecodeUtils {
  /**
   * 检查文件是否为字节码
   */
  static isBytecodeFile(filePath: string): boolean {
    return path.extname(filePath) === '.jsc';
  }

  /**
   * 获取字节码文件对应的JS文件路径
   */
  static getJsPath(jscPath: string): string {
    return jscPath.replace(/\.jsc$/, '.js');
  }

  /**
   * 获取JS文件对应的字节码文件路径
   */
  static getJscPath(jsPath: string): string {
    return jsPath.replace(/\.js$/, '.jsc');
  }

  /**
   * 编译目录中的所有JS文件为字节码
   *
   * @param dirPath - 目录路径
   * @param recursive - 是否递归处理子目录
   * @param deleteSource - 是否删除源JS文件
   */
  static async compileDirToJSC(
    dirPath: string,
    recursive: boolean = true,
    deleteSource: boolean = false
  ): Promise<string[]> {
    const runner = new BytecodeRunner();
    const compiledFiles: string[] = [];

    const processDir = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && recursive) {
          await processDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          try {
            const jscPath = await runner.compileFileToJSC(fullPath);
            compiledFiles.push(jscPath);

            if (deleteSource) {
              await fs.remove(fullPath);
            }
          } catch (error: any) {
            logger.error('Failed to compile ' + fullPath + ': ' + error.message);
          }
        }
      }
    };

    await processDir(dirPath);

    return compiledFiles;
  }
}
