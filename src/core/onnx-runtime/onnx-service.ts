/**
 * ONNX Runtime 服务
 *
 * 提供 ONNX 模型加载和推理能力
 * 支持 CPU、CUDA、DirectML 等执行提供者
 */

import { createLogger } from '../logger';
import { dynamicImport } from '../utils/dynamic-import';
import type {
  ONNXModelConfig,
  InferenceOptions,
  InferenceResult,
  LoadedModelInfo,
  ModelMeta,
  TensorData,
  TensorMeta,
  ExecutionProvider,
} from './types';
import { ModelNotFoundError, ModelLoadError, InferenceError } from './types';
import { toTypedArray, toArray } from './tensor-utils';

const logger = createLogger('ONNXService');

// ONNX Runtime 类型（动态导入，避免编译时依赖）

type OrtModule = any;
type InferenceSession = any;
type Tensor = any;
type SessionOptions = any;

/**
 * 已加载的模型
 */
interface LoadedModel {
  session: InferenceSession;
  config: ONNXModelConfig;
  meta: ModelMeta;
  loadedAt: number;
  lastUsed: number;
}

/**
 * ONNX Runtime 服务
 *
 * 提供统一的 ONNX 模型推理能力：
 * - 模型加载/卸载
 * - 推理执行
 * - 会话池管理
 */
export class ONNXRuntimeService {
  private static instance: ONNXRuntimeService | null = null;
  private models = new Map<string, LoadedModel>();
  private ort: OrtModule | null = null;
  private initialized = false;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): ONNXRuntimeService {
    if (!ONNXRuntimeService.instance) {
      ONNXRuntimeService.instance = new ONNXRuntimeService();
    }
    return ONNXRuntimeService.instance;
  }

  /**
   * 初始化 ONNX Runtime
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      this.ort = await dynamicImport<OrtModule>('onnxruntime-node');
      this.initialized = true;
      logger.info('ONNX Runtime initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize ONNX Runtime:', error);

      const rawMessage = error instanceof Error ? error.message : String(error);
      const isWindows = process.platform === 'win32';

      const hints: string[] = [];
      if (isWindows) {
        hints.push('请确认安装了 Microsoft Visual C++ Redistributable 2015-2022 (x64)。');
        hints.push('官方下载： https://aka.ms/vs/17/release/vc_redist.x64.exe');
        hints.push('如果是便携版(Portable)运行，安装包不会自动安装运行库，需要手动安装后再启动。');
      }
      if (/DLL initialization routine failed/i.test(rawMessage)) {
        hints.push('该错误通常由缺失/损坏的系统运行库或不兼容的系统组件导致。');
      }

      const err = new Error(
        [
          'Failed to initialize ONNX Runtime (onnxruntime-node).',
          `原始错误：${rawMessage}`,
          hints.length ? `\n解决建议：\n- ${hints.join('\n- ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      ) as Error & { cause?: unknown };
      err.cause = error;
      throw err;
    }
  }

  /**
   * 生成模型 ID
   */
  private generateModelId(modelPath: string): string {
    const filename = modelPath.split(/[/\\]/).pop() || 'model';
    const timestamp = Date.now().toString(36);
    return `${filename.replace('.onnx', '')}_${timestamp}`;
  }

  /**
   * 获取执行提供者配置
   */
  private getExecutionProviders(provider?: ExecutionProvider): string[] {
    switch (provider) {
      case 'cuda':
        return ['cuda', 'cpu'];
      case 'directml':
        return ['dml', 'cpu'];
      case 'coreml':
        return ['coreml', 'cpu'];
      default:
        return ['cpu'];
    }
  }

  /**
   * 提取模型元信息
   *
   * 注意：ONNX Runtime Node.js 版本不直接暴露完整的张量维度和类型信息，
   * 这里只能获取输入/输出名称。如需精确的维度信息，请使用 Python 工具分析模型。
   */
  private extractModelMeta(session: InferenceSession): ModelMeta {
    const inputs: TensorMeta[] = session.inputNames.map((name: string) => ({
      name,
      dims: [], // ONNX Runtime Node.js 不暴露维度信息
      type: 'float32' as const, // 默认类型，实际类型需从模型文档获取
    }));

    const outputs: TensorMeta[] = session.outputNames.map((name: string) => ({
      name,
      dims: [],
      type: 'float32' as const,
    }));

    return { inputs, outputs };
  }

  /**
   * 加载 ONNX 模型
   *
   * @param config 模型配置
   * @returns 模型 ID
   */
  async loadModel(config: ONNXModelConfig): Promise<string> {
    await this.ensureInitialized();

    if (!this.ort) {
      throw new Error('ONNX Runtime not initialized');
    }

    const modelId = config.modelId || this.generateModelId(config.modelPath);

    // 检查是否已加载
    if (this.models.has(modelId)) {
      logger.info(`Model "${modelId}" already loaded, reusing`);
      return modelId;
    }

    try {
      logger.info(`Loading ONNX model: ${config.modelPath}`);

      const sessionOptions: SessionOptions = {
        executionProviders: this.getExecutionProviders(config.executionProvider),
        graphOptimizationLevel: config.graphOptimization !== false ? 'all' : 'disabled',
        enableMemPattern: config.enableMemoryPattern !== false,
      };

      if (config.intraOpNumThreads) {
        sessionOptions.intraOpNumThreads = config.intraOpNumThreads;
      }

      const session = await this.ort.InferenceSession.create(config.modelPath, sessionOptions);
      const meta = this.extractModelMeta(session);

      const loadedModel: LoadedModel = {
        session,
        config,
        meta,
        loadedAt: Date.now(),
        lastUsed: Date.now(),
      };

      this.models.set(modelId, loadedModel);
      logger.info(`Model "${modelId}" loaded successfully`);

      return modelId;
    } catch (error) {
      logger.error(`Failed to load model: ${config.modelPath}`, error);
      throw new ModelLoadError(config.modelPath, error as Error);
    }
  }

  /**
   * 卸载模型
   *
   * @param modelId 模型 ID
   */
  async unloadModel(modelId: string): Promise<void> {
    const model = this.models.get(modelId);
    if (!model) {
      logger.warn(`Model "${modelId}" not found, skipping unload`);
      return;
    }

    try {
      // InferenceSession 没有 dispose 方法，依赖 GC
      this.models.delete(modelId);
      logger.info(`Model "${modelId}" unloaded`);
    } catch (error) {
      logger.error(`Failed to unload model "${modelId}":`, error);
    }
  }

  /**
   * 执行推理
   *
   * @param modelId 模型 ID
   * @param inputs 输入张量
   * @param options 推理选项
   * @returns 推理结果
   */
  async run(
    modelId: string,
    inputs: Record<string, TensorData>,
    options?: InferenceOptions
  ): Promise<InferenceResult> {
    await this.ensureInitialized();

    if (!this.ort) {
      throw new Error('ONNX Runtime not initialized');
    }

    const model = this.models.get(modelId);
    if (!model) {
      throw new ModelNotFoundError(modelId);
    }

    try {
      const startTime = performance.now();

      // 构建输入 feeds
      const feeds: Record<string, Tensor> = {};
      for (const [name, tensorData] of Object.entries(inputs)) {
        const data = toTypedArray(tensorData.data as number[], tensorData.type || 'float32');
        feeds[name] = new this.ort.Tensor(tensorData.type || 'float32', data, tensorData.dims);
      }

      // 执行推理
      const results = await model.session.run(feeds, options?.outputNames);

      // 转换输出
      const outputs: Record<string, TensorData> = {};
      for (const [name, tensor] of Object.entries(results) as [string, Tensor][]) {
        outputs[name] = {
          data: toArray(tensor.data as Float32Array),
          dims: tensor.dims as number[],
          type: tensor.type as TensorData['type'],
        };
      }

      const duration = performance.now() - startTime;
      model.lastUsed = Date.now();

      return { outputs, duration };
    } catch (error) {
      logger.error(`Inference failed for model "${modelId}":`, error);
      throw new InferenceError(modelId, error as Error);
    }
  }

  /**
   * 获取模型信息
   *
   * @param modelId 模型 ID
   * @returns 模型信息
   */
  getModelInfo(modelId: string): LoadedModelInfo | null {
    const model = this.models.get(modelId);
    if (!model) {
      return null;
    }

    return {
      modelId,
      modelPath: model.config.modelPath,
      loadedAt: model.loadedAt,
      lastUsed: model.lastUsed,
      meta: model.meta,
    };
  }

  /**
   * 列出已加载的模型
   *
   * @returns 模型信息列表
   */
  listModels(): LoadedModelInfo[] {
    const result: LoadedModelInfo[] = [];
    for (const [modelId, model] of this.models) {
      result.push({
        modelId,
        modelPath: model.config.modelPath,
        loadedAt: model.loadedAt,
        lastUsed: model.lastUsed,
        meta: model.meta,
      });
    }
    return result;
  }

  /**
   * 检查模型是否已加载
   */
  hasModel(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /**
   * 清理所有模型
   */
  async dispose(): Promise<void> {
    logger.info('Disposing all ONNX models...');
    for (const modelId of this.models.keys()) {
      await this.unloadModel(modelId);
    }
    this.models.clear();
  }
}

/**
 * 获取 ONNX 服务实例
 */
export function getONNXService(): ONNXRuntimeService {
  return ONNXRuntimeService.getInstance();
}
