/**
 * MobileNet Feature Extractor
 *
 * 使用 MobileNetV3 提取图像特征向量
 * 支持自动下载模型和 GPU 加速
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../logger';
import { dynamicImport } from '../utils/dynamic-import';
import { getONNXService, imageToNCHW, l2Normalize } from '../onnx-runtime';
import type { ExecutionProvider } from '../onnx-runtime';
import type { FeatureExtractorConfig, DownloadProgress, ModelInfo } from './types';

const logger = createLogger('MobileNetExtractor');

function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

function cleanupDir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function findFirstFileByExt(rootDir: string, extLower: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.toLowerCase().endsWith(extLower)) {
        return fullPath;
      }
    }
  }
  return null;
}

function copyFilesFlat(sourceDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

/**
 * 默认的 MobileNetV3-Small 配置
 */
const DEFAULT_CONFIG: FeatureExtractorConfig = {
  modelPath: '',
  inputSize: [224, 224],
  inputName: 'input',
  outputName: 'output', // 最后的池化层输出
  featureDim: 576,
  normalizeOutput: true,
};

/**
 * MobileNet 特征提取器
 *
 * 使用 MobileNetV3 模型提取图像的语义特征向量，
 * 用于图像相似度搜索
 */
export class MobileNetExtractor {
  private config: FeatureExtractorConfig;
  private modelId: string | null = null;
  private initialized = false;
  private executionProvider: ExecutionProvider;
  private sharp: any = null;

  constructor(config?: Partial<FeatureExtractorConfig>, executionProvider?: ExecutionProvider) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.executionProvider = executionProvider || 'cpu';
  }

  /**
   * 初始化提取器
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 加载 sharp
    try {
      const sharpModule = await dynamicImport<{ default?: unknown }>('sharp');
      this.sharp = sharpModule.default || sharpModule;
    } catch (_error) {
      throw new Error(
        'sharp is required for image processing. Please install it: npm install sharp'
      );
    }

    // 检查模型文件
    if (!this.config.modelPath) {
      throw new Error('Model path is required');
    }

    if (!fs.existsSync(this.config.modelPath)) {
      throw new Error(`Model file not found: ${this.config.modelPath}`);
    }

    // 加载 ONNX 模型
    const service = getONNXService();
    this.modelId = await service.loadModel({
      modelPath: this.config.modelPath,
      executionProvider: this.executionProvider,
    });

    this.initialized = true;
    logger.info(`MobileNet extractor initialized: ${this.config.modelPath}`);
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.modelId) {
      throw new Error('Extractor not initialized. Call initialize() first.');
    }
  }

  /**
   * 提取图像特征
   *
   * @param image 图像路径或 Buffer
   * @returns 特征向量
   */
  async extract(image: string | Buffer): Promise<number[]> {
    this.ensureInitialized();

    // 读取图像
    let imageBuffer: Buffer;
    if (typeof image === 'string') {
      if (!fs.existsSync(image)) {
        throw new Error(`Image file not found: ${image}`);
      }
      imageBuffer = fs.readFileSync(image);
    } else {
      imageBuffer = image;
    }

    // 预处理图像
    const [width, height] = this.config.inputSize;
    const rawPixels = await this.sharp(imageBuffer)
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();

    // 转换为 NCHW 格式并 ImageNet 归一化
    const tensorData = imageToNCHW(rawPixels, width, height, {
      normalize: 'imagenet',
      colorFormat: 'rgb',
    });

    // 执行推理
    const service = getONNXService();
    const result = await service.run(this.modelId!, {
      [this.config.inputName]: {
        data: tensorData,
        dims: [1, 3, height, width],
        type: 'float32',
      },
    });

    // 获取特征向量
    let features: number[];
    if (this.config.outputName && result.outputs[this.config.outputName]) {
      features = Array.from(result.outputs[this.config.outputName].data as Float32Array);
    } else {
      // 使用第一个输出
      const firstOutput = Object.values(result.outputs)[0];
      if (!firstOutput) {
        throw new Error('No output from model');
      }
      features = Array.from(firstOutput.data as Float32Array);
    }

    // 如果输出包含分类层，需要截取特征层
    if (features.length > this.config.featureDim) {
      // 假设特征在输出的前 featureDim 个位置
      // 对于 MobileNetV3，实际上需要使用中间层输出
      logger.warn(
        `Output dim ${features.length} > expected ${this.config.featureDim}, truncating...`
      );
      features = features.slice(0, this.config.featureDim);
    }

    // L2 归一化
    if (this.config.normalizeOutput) {
      features = l2Normalize(features);
    }

    return features;
  }

  /**
   * 批量提取特征
   */
  async extractBatch(images: Array<string | Buffer>): Promise<number[][]> {
    const results: number[][] = [];
    for (const image of images) {
      const features = await this.extract(image);
      results.push(features);
    }
    return results;
  }

  /**
   * 获取特征维度
   */
  getFeatureDim(): number {
    return this.config.featureDim;
  }

  /**
   * 获取输入尺寸
   */
  getInputSize(): [number, number] {
    return this.config.inputSize;
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    if (this.modelId) {
      const service = getONNXService();
      await service.unloadModel(this.modelId);
      this.modelId = null;
    }
    this.initialized = false;
    logger.info('MobileNet extractor disposed');
  }

  /**
   * 下载模型文件
   *
   * @param modelInfo 模型信息
   * @param destPath 目标路径
   * @param onProgress 进度回调
   */
  static async downloadModel(
    modelInfo: ModelInfo,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const candidateUrls = [
      ...new Set(
        [modelInfo.url, ...(Array.isArray(modelInfo.urls) ? modelInfo.urls : [])].filter(Boolean)
      ),
    ];
    let lastError: Error | null = null;

    const downloadToFile = async (url: string, outputPath: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(outputPath);
        let downloaded = 0;

        const request = (requestUrl: string, redirectCount: number = 0) => {
          if (redirectCount > 8) {
            reject(new Error('Failed to download: too many redirects'));
            return;
          }

          https
            .get(requestUrl, (response) => {
              const statusCode = Number(response.statusCode || 0);
              if ([301, 302, 303, 307, 308].includes(statusCode)) {
                const redirectUrl = String(response.headers.location || '');
                response.resume();
                if (!redirectUrl) {
                  reject(new Error(`Failed to download: HTTP ${statusCode}`));
                  return;
                }
                const nextUrl = redirectUrl.startsWith('http')
                  ? redirectUrl
                  : new URL(redirectUrl, requestUrl).toString();
                request(nextUrl, redirectCount + 1);
                return;
              }

              if (statusCode !== 200) {
                response.resume();
                reject(new Error(`Failed to download: HTTP ${statusCode}`));
                return;
              }

              const total =
                parseInt(String(response.headers['content-length'] || '0'), 10) || modelInfo.size;

              response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (onProgress) {
                  onProgress({
                    downloaded,
                    total,
                    percent: Math.round((downloaded / total) * 100),
                  });
                }
              });

              response.pipe(file);
              file.on('finish', () => file.close(() => resolve()));
            })
            .on('error', (err) => reject(err));
        };

        file.on('error', (err) => reject(err));
        request(url);
      });
    };

    const extractFromZip = async (zipPath: string, modelPath: string): Promise<void> => {
      const unzipDir = `${modelPath}.unzipped`;
      cleanupDir(unzipDir);
      fs.mkdirSync(unzipDir, { recursive: true });

      try {
        const zipModule = await dynamicImport<any>('adm-zip');
        const AdmZipCtor = zipModule?.default || zipModule;
        const zip = new AdmZipCtor(zipPath);
        zip.extractAllTo(unzipDir, true);

        const onnxPath = findFirstFileByExt(unzipDir, '.onnx');
        if (!onnxPath) {
          throw new Error('Failed to download: no .onnx found in zip bundle');
        }

        const onnxDir = path.dirname(onnxPath);
        copyFilesFlat(onnxDir, path.dirname(modelPath));
        if (onnxPath !== modelPath) {
          fs.copyFileSync(onnxPath, modelPath);
        }
      } finally {
        cleanupDir(unzipDir);
      }
    };

    for (const url of candidateUrls) {
      const isZip = /\.zip($|\?)/i.test(url);
      const tempPath = isZip ? `${destPath}.download.zip` : `${destPath}.download`;
      cleanupFile(tempPath);

      try {
        await downloadToFile(url, tempPath);
        if (isZip) {
          await extractFromZip(tempPath, destPath);
        } else {
          fs.renameSync(tempPath, destPath);
        }
        if (!MobileNetExtractor.isModelDownloaded(destPath)) {
          throw new Error('Downloaded model file is invalid');
        }
        cleanupFile(tempPath);
        logger.info(`Model downloaded: ${destPath}`);
        return;
      } catch (error) {
        cleanupFile(tempPath);
        lastError = error as Error;
        logger.warn(`Model download source failed: ${url}`, error);
      }
    }

    throw lastError || new Error('Failed to download model');
  }

  static isModelDownloaded(modelPath: string): boolean {
    try {
      if (!fs.existsSync(modelPath)) return false;
      const stat = fs.statSync(modelPath);
      if (!stat.isFile()) return false;
      return stat.size > 1024;
    } catch {
      return false;
    }
  }

  /**
   * 获取推荐的模型路径
   */
  static getModelPath(modelsDir: string, modelName: string = 'mobilenetv3-small'): string {
    return path.join(modelsDir, `${modelName}.onnx`);
  }
}

/**
 * 创建一个配置好的 MobileNetV3-Small 提取器
 */
export async function createMobileNetExtractor(
  modelsDir: string,
  options?: {
    executionProvider?: ExecutionProvider;
    autoDownload?: boolean;
    onDownloadProgress?: (progress: DownloadProgress) => void;
  }
): Promise<MobileNetExtractor> {
  const { PRESET_MODELS } = await import('./types');
  const modelInfo = PRESET_MODELS['mobilenetv3-small'];
  const modelPath = MobileNetExtractor.getModelPath(modelsDir, 'mobilenetv3-small');
  const modelDir = path.dirname(modelPath);

  // 自动下载模型
  if (options?.autoDownload && !MobileNetExtractor.isModelDownloaded(modelPath)) {
    logger.info('Downloading MobileNetV3-Small model...');
    await MobileNetExtractor.downloadModel(modelInfo, modelPath, options.onDownloadProgress);
  }

  const extractor = new MobileNetExtractor(
    {
      modelPath,
      inputSize: modelInfo.inputSize,
      featureDim: modelInfo.featureDim,
      normalizeOutput: true,
    },
    options?.executionProvider
  );

  try {
    await extractor.initialize();
  } catch (error) {
    if (!options?.autoDownload) throw error;
    logger.warn('Model init failed, retry with fresh download...', error);
    cleanupFile(modelPath);
    cleanupFile(path.join(modelDir, 'mobilenet_v3_small.data'));
    await MobileNetExtractor.downloadModel(modelInfo, modelPath, options.onDownloadProgress);
    await extractor.initialize();
  }
  return extractor;
}
