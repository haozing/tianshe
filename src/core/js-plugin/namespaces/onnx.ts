/**
 * ONNX Namespace
 *
 * 提供 ONNX 模型推理能力的命名空间接口
 * 支持任意 ONNX 模型的加载和推理
 *
 * @example
 * // 加载 MobileNetV3 分类模型
 * const modelId = await helpers.onnx.loadModel('./models/mobilenetv3-small.onnx');
 *
 * // 预处理图像
 * const input = await helpers.onnx.preprocessImage('./test.jpg', {
 *   targetSize: [224, 224],
 *   normalize: 'imagenet'
 * });
 *
 * // 执行推理
 * const result = await helpers.onnx.run(modelId, { input });
 *
 * // 后处理
 * const probs = helpers.onnx.softmax(result.output.data);
 * const top5 = helpers.onnx.topK(probs, 5);
 */

import { createLogger } from '../../logger';
import { dynamicImport } from '../../utils/dynamic-import';
import {
  ONNXRuntimeService,
  getONNXService,
  softmax as tensorSoftmax,
  topK as tensorTopK,
  cosineSimilarity as tensorCosineSimilarity,
  l2Normalize as tensorL2Normalize,
  toArray,
  imageToNCHW,
  imageToNHWC,
  createTensor,
  getTensorSize,
} from '../../onnx-runtime';
import type {
  TensorData,
  TensorMeta,
  ExecutionProvider,
  ImagePreprocessOptions,
  ClassificationResult,
} from '../../onnx-runtime';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('ONNXNamespace');

// Re-export types for plugin developers
export type {
  TensorData,
  TensorMeta,
  ExecutionProvider,
  ImagePreprocessOptions,
  ClassificationResult,
} from '../../onnx-runtime';

/**
 * 简化的张量输入格式（用于插件 API）
 */
export interface SimpleTensorInput {
  /** 数据（支持普通数组或 TypedArray） */
  data: number[] | Float32Array | Uint8Array | Int32Array;
  /** 维度 */
  dims: number[];
  /** 数据类型（可选，默认 float32） */
  type?: 'float32' | 'int32' | 'uint8';
}

/**
 * 简化的张量输出格式
 */
export interface SimpleTensorOutput {
  /** 数据（普通数组） */
  data: number[];
  /** 维度 */
  dims: number[];
}

/**
 * 模型加载选项
 */
export interface LoadModelOptions {
  /** 模型 ID（可选） */
  modelId?: string;
  /** 执行提供者 */
  executionProvider?: ExecutionProvider;
}

/**
 * 模型信息
 */
export interface ModelInfo {
  /** 模型 ID */
  modelId: string;
  /** 加载时间 */
  loadedAt: number;
  /** 最后使用时间 */
  lastUsed: number;
  /** 输入张量信息 */
  inputs: TensorMeta[];
  /** 输出张量信息 */
  outputs: TensorMeta[];
}

/**
 * ONNX 命名空间
 *
 * 提供 ONNX 模型推理能力：
 * - 模型加载/卸载
 * - 通用推理接口
 * - 图像预处理
 * - 后处理工具（softmax、topK）
 */
export class ONNXNamespace {
  private service: ONNXRuntimeService;
  private pluginModelIds: Set<string> = new Set();

  constructor(private pluginId: string) {
    this.service = getONNXService();
  }

  /**
   * 加载 ONNX 模型
   *
   * @param modelPath 模型路径（绝对路径或相对于插件目录）
   * @param options 加载选项
   * @returns 模型 ID
   *
   * @example
   * const modelId = await helpers.onnx.loadModel('./models/classifier.onnx');
   *
   * @example
   * const modelId = await helpers.onnx.loadModel('d:/models/mobilenet.onnx', {
   *   modelId: 'mobilenet-v3',
   *   executionProvider: 'cuda'
   * });
   */
  async loadModel(modelPath: string, options?: LoadModelOptions): Promise<string> {
    // 如果是相对路径，尝试解析
    let resolvedPath = modelPath;
    if (!path.isAbsolute(modelPath)) {
      // 相对路径，假设相对于插件目录
      logger.warn(`Relative model path "${modelPath}" used. Consider using absolute paths.`);
    }

    // 检查文件是否存在
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Model file not found: ${resolvedPath}`);
    }

    const modelId = await this.service.loadModel({
      modelId: options?.modelId,
      modelPath: resolvedPath,
      executionProvider: options?.executionProvider,
    });

    // 记录此插件加载的模型
    this.pluginModelIds.add(modelId);
    logger.info(`[Plugin:${this.pluginId}] Loaded model: ${modelId}`);

    return modelId;
  }

  /**
   * 卸载模型
   *
   * @param modelId 模型 ID
   *
   * @example
   * await helpers.onnx.unloadModel('mobilenet-v3');
   */
  async unloadModel(modelId: string): Promise<void> {
    await this.service.unloadModel(modelId);
    this.pluginModelIds.delete(modelId);
    logger.info(`[Plugin:${this.pluginId}] Unloaded model: ${modelId}`);
  }

  /**
   * 执行推理
   *
   * @param modelId 模型 ID
   * @param inputs 输入张量（键为输入名称）
   * @returns 输出张量
   *
   * @example
   * const result = await helpers.onnx.run('mobilenet-v3', {
   *   input: { data: imageData, dims: [1, 3, 224, 224], type: 'float32' }
   * });
   * console.log(result.output.data); // 输出概率
   */
  async run(
    modelId: string,
    inputs: Record<string, SimpleTensorInput>
  ): Promise<Record<string, SimpleTensorOutput>> {
    // 转换输入格式
    const tensorInputs: Record<string, TensorData> = {};
    for (const [name, input] of Object.entries(inputs)) {
      tensorInputs[name] = {
        data: input.data,
        dims: input.dims,
        type: input.type || 'float32',
      };
    }

    const result = await this.service.run(modelId, tensorInputs);

    // 转换输出格式
    const outputs: Record<string, SimpleTensorOutput> = {};
    for (const [name, output] of Object.entries(result.outputs)) {
      outputs[name] = {
        data: toArray(output.data),
        dims: output.dims,
      };
    }

    return outputs;
  }

  /**
   * 获取模型信息
   *
   * @param modelId 模型 ID
   * @returns 模型信息
   *
   * @note 此方法内部是同步执行的，但保留 async 签名以保持 API 一致性。
   *
   * @example
   * const info = await helpers.onnx.getModelInfo('mobilenet-v3');
   * console.log('Inputs:', info.inputs);
   * console.log('Outputs:', info.outputs);
   */
  getModelInfo(modelId: string): ModelInfo | null {
    const info = this.service.getModelInfo(modelId);
    if (!info) {
      return null;
    }

    return {
      modelId: info.modelId,
      loadedAt: info.loadedAt,
      lastUsed: info.lastUsed,
      inputs: info.meta.inputs,
      outputs: info.meta.outputs,
    };
  }

  /**
   * 列出已加载的模型
   *
   * @returns 模型列表
   *
   * @note 此方法内部是同步执行的，但保留 async 签名以保持 API 一致性。
   *
   * @example
   * const models = helpers.onnx.listModels();
   * console.log(models.map(m => m.modelId));
   */
  listModels(): Array<{ modelId: string; loadedAt: number; lastUsed: number }> {
    return this.service.listModels().map((m) => ({
      modelId: m.modelId,
      loadedAt: m.loadedAt,
      lastUsed: m.lastUsed,
    }));
  }

  // ========== 图像预处理 ==========

  /**
   * 图像预处理
   *
   * 将图像转换为模型所需的张量格式
   *
   * @param image 图像路径或 Buffer
   * @param options 预处理选项
   * @returns 张量数据
   *
   * @example
   * // ImageNet 标准预处理
   * const input = await helpers.onnx.preprocessImage('./cat.jpg', {
   *   targetSize: [224, 224],
   *   normalize: 'imagenet',
   *   layout: 'nchw'
   * });
   *
   * @example
   * // 自定义归一化
   * const input = await helpers.onnx.preprocessImage(imageBuffer, {
   *   targetSize: [256, 256],
   *   normalize: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] }
   * });
   */
  async preprocessImage(
    image: string | Buffer,
    options: ImagePreprocessOptions
  ): Promise<SimpleTensorInput> {
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

    // 使用 sharp 图像库解码和调整大小
    try {
      // 动态导入 sharp
      type SharpInstance = {
        resize(w: number, h: number, options?: object): SharpInstance;
        removeAlpha(): SharpInstance;
        raw(): SharpInstance;
        toBuffer(): Promise<Buffer>;
      };
      type SharpFn = (input: Buffer) => SharpInstance;
      const sharpModule = await dynamicImport<{ default?: SharpFn } | SharpFn>('sharp');
      const sharp = ((sharpModule as { default?: SharpFn }).default || sharpModule) as SharpFn;
      const { targetSize, layout = 'nchw', normalize = 'zero-one', colorFormat = 'rgb' } = options;
      const [width, height] = targetSize;

      // 调整大小并获取原始像素
      const rawPixels = await sharp(imageBuffer)
        .resize(width, height, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();

      // 转换为张量格式
      let tensorData: Float32Array;
      if (layout === 'nchw') {
        tensorData = imageToNCHW(rawPixels, width, height, { normalize, colorFormat });
      } else {
        tensorData = imageToNHWC(rawPixels, width, height, { normalize, colorFormat });
      }

      const dims = layout === 'nchw' ? [1, 3, height, width] : [1, height, width, 3];

      return {
        data: tensorData,
        dims,
        type: 'float32',
      };
    } catch (error) {
      // 如果 sharp 不可用，抛出更友好的错误
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'Image preprocessing requires the "sharp" package. Please install it: npm install sharp'
        );
      }
      throw error;
    }
  }

  // ========== 后处理工具 ==========

  /**
   * Softmax 函数
   *
   * 将原始输出转换为概率分布
   *
   * @param data 输入数据
   * @returns 概率分布
   *
   * @example
   * const probs = helpers.onnx.softmax(result.output.data);
   */
  softmax(data: number[]): number[] {
    return tensorSoftmax(data);
  }

  /**
   * 获取 Top-K 结果
   *
   * @param data 输入数据（通常是 softmax 后的概率）
   * @param k 返回前 k 个结果
   * @returns 排序后的结果
   *
   * @example
   * const top5 = helpers.onnx.topK(probs, 5);
   * console.log(top5); // [{ index: 281, score: 0.85 }, ...]
   */
  topK(data: number[], k: number): Array<{ index: number; score: number }> {
    return tensorTopK(data, k);
  }

  /**
   * 计算余弦相似度
   *
   * 用于特征向量比较
   *
   * @param a 向量 A
   * @param b 向量 B
   * @returns 相似度（-1 到 1）
   *
   * @example
   * const similarity = helpers.onnx.cosineSimilarity(features1, features2);
   */
  cosineSimilarity(a: number[], b: number[]): number {
    return tensorCosineSimilarity(a, b);
  }

  /**
   * L2 归一化（单位向量化）
   *
   * 将向量归一化为单位长度，常用于：
   * - 余弦相似度计算前的预处理
   * - 特征向量的标准化
   *
   * @param vector 输入向量
   * @returns 归一化后的向量（长度为 1）
   *
   * @example
   * const normalized = helpers.onnx.l2Normalize([3, 4]); // [0.6, 0.8]
   *
   * @example
   * // 用于特征向量标准化
   * const features = await helpers.onnx.extractFeatures('model', image);
   * const normalized = helpers.onnx.l2Normalize(features);
   */
  l2Normalize(vector: number[]): number[] {
    return tensorL2Normalize(vector);
  }

  /**
   * 计算张量的总元素数
   *
   * @param dims 维度数组
   * @returns 元素总数
   *
   * @example
   * const size = helpers.onnx.getTensorSize([1, 3, 224, 224]); // 150528
   */
  getTensorSize(dims: number[]): number {
    return getTensorSize(dims);
  }

  /**
   * 创建张量数据
   *
   * @param data 数据数组
   * @param dims 维度
   * @param type 数据类型，默认 'float32'
   * @returns 张量数据对象
   *
   * @example
   * const tensor = helpers.onnx.createTensor([1, 2, 3, 4], [2, 2], 'float32');
   */
  createTensor(
    data: number[] | Float32Array | Uint8Array | Int32Array,
    dims: number[],
    type: 'float32' | 'int32' | 'uint8' = 'float32'
  ): SimpleTensorInput {
    const tensorData = createTensor(data, dims, type);
    return {
      data: Array.from(tensorData.data as Float32Array | Uint8Array | Int32Array),
      dims: tensorData.dims,
      type: tensorData.type as 'float32' | 'int32' | 'uint8',
    };
  }

  // ========== 便捷方法 ==========

  /**
   * 图像分类
   *
   * 便捷的分类方法，自动处理预处理和后处理
   *
   * @param modelId 模型 ID
   * @param image 图像路径或 Buffer
   * @param options 选项
   * @returns 分类结果
   *
   * @example
   * const results = await helpers.onnx.classifyImage('mobilenet', './cat.jpg', {
   *   topK: 5,
   *   labels: ['cat', 'dog', 'bird', ...]
   * });
   */
  async classifyImage(
    modelId: string,
    image: string | Buffer,
    options?: {
      topK?: number;
      labels?: string[];
      inputName?: string;
      outputName?: string;
      inputSize?: [number, number];
    }
  ): Promise<ClassificationResult[]> {
    const {
      topK: k = 5,
      labels,
      inputName = 'input',
      outputName,
      inputSize = [224, 224],
    } = options || {};

    // 预处理图像
    const input = await this.preprocessImage(image, {
      targetSize: inputSize,
      normalize: 'imagenet',
      layout: 'nchw',
    });

    // 执行推理
    const result = await this.run(modelId, { [inputName]: input });

    // 获取输出（使用指定名称或第一个输出）
    const outputData = outputName ? result[outputName]?.data : Object.values(result)[0]?.data;

    if (!outputData) {
      throw new Error('No output data from model');
    }

    // Softmax 并获取 Top-K
    const probs = this.softmax(outputData);
    const topResults = this.topK(probs, k);

    // 映射标签
    return topResults.map((r) => ({
      index: r.index,
      label: labels?.[r.index],
      score: r.score,
    }));
  }

  /**
   * 提取特征向量
   *
   * 用于相似度匹配等场景
   *
   * @param modelId 特征提取模型 ID
   * @param image 图像
   * @param options 选项
   * @returns 特征向量
   *
   * @example
   * const features = await helpers.onnx.extractFeatures('feature-model', './img.jpg');
   * const similarity = helpers.onnx.cosineSimilarity(features, referenceFeatures);
   */
  async extractFeatures(
    modelId: string,
    image: string | Buffer,
    options?: {
      inputName?: string;
      outputName?: string;
      inputSize?: [number, number];
    }
  ): Promise<number[]> {
    const { inputName = 'input', outputName, inputSize = [224, 224] } = options || {};

    const input = await this.preprocessImage(image, {
      targetSize: inputSize,
      normalize: 'imagenet',
      layout: 'nchw',
    });

    const result = await this.run(modelId, { [inputName]: input });

    const outputData = outputName ? result[outputName]?.data : Object.values(result)[0]?.data;

    if (!outputData) {
      throw new Error('No output data from model');
    }

    return outputData;
  }

  /**
   * 清理此插件加载的所有模型
   *
   * @internal
   */
  async dispose(): Promise<void> {
    for (const modelId of this.pluginModelIds) {
      try {
        await this.service.unloadModel(modelId);
      } catch (error) {
        logger.error(`Failed to unload model ${modelId}:`, error);
      }
    }
    this.pluginModelIds.clear();
  }
}
