/**
 * ONNX Runtime 类型定义
 *
 * 提供 ONNX 模型推理相关的类型定义
 */

/**
 * 支持的张量数据类型
 */
export type TensorDataType =
  | 'float32'
  | 'float64'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'bool'
  | 'string';

/**
 * 支持的执行提供者
 */
export type ExecutionProvider = 'cpu' | 'cuda' | 'directml' | 'coreml';

/**
 * 张量数据
 */
export interface TensorData {
  /** 数据（支持多种类型） */
  data:
    | Float32Array
    | Float64Array
    | Int8Array
    | Int16Array
    | Int32Array
    | BigInt64Array
    | Uint8Array
    | Uint16Array
    | Uint32Array
    | BigUint64Array
    | number[];
  /** 维度 */
  dims: number[];
  /** 数据类型（可选，默认 float32） */
  type?: TensorDataType;
}

/**
 * 张量元信息
 */
export interface TensorMeta {
  /** 张量名称 */
  name: string;
  /** 维度（-1 表示动态维度） */
  dims: number[];
  /** 数据类型 */
  type: TensorDataType;
}

/**
 * 模型元信息
 */
export interface ModelMeta {
  /** 输入张量信息 */
  inputs: TensorMeta[];
  /** 输出张量信息 */
  outputs: TensorMeta[];
}

/**
 * 模型加载配置
 */
export interface ONNXModelConfig {
  /** 模型唯一标识（可选，默认使用路径生成） */
  modelId?: string;
  /** ONNX 模型文件路径 */
  modelPath: string;
  /** 执行提供者（默认 cpu） */
  executionProvider?: ExecutionProvider;
  /** 是否启用图优化（默认 true） */
  graphOptimization?: boolean;
  /** 线程数（CPU 执行时） */
  intraOpNumThreads?: number;
  /** 是否启用内存模式（默认 true） */
  enableMemoryPattern?: boolean;
}

/**
 * 推理选项
 */
export interface InferenceOptions {
  /** 指定输出张量名称（可选，默认返回所有输出） */
  outputNames?: string[];
}

/**
 * 推理结果
 */
export interface InferenceResult {
  /** 输出张量 */
  outputs: Record<string, TensorData>;
  /** 推理耗时（毫秒） */
  duration: number;
}

/**
 * 已加载模型信息
 */
export interface LoadedModelInfo {
  /** 模型 ID */
  modelId: string;
  /** 模型路径 */
  modelPath: string;
  /** 加载时间戳 */
  loadedAt: number;
  /** 最后使用时间戳 */
  lastUsed: number;
  /** 模型元信息 */
  meta: ModelMeta;
}

/**
 * 图像预处理选项
 */
export interface ImagePreprocessOptions {
  /** 目标尺寸 [width, height] */
  targetSize: [number, number];
  /** 归一化方式 */
  normalize?:
    | 'imagenet'
    | 'zero-one'
    | { mean: [number, number, number]; std: [number, number, number] };
  /** 颜色格式 */
  colorFormat?: 'rgb' | 'bgr';
  /** 数据布局 */
  layout?: 'nchw' | 'nhwc';
  /** 是否保持宽高比（使用 padding） */
  keepAspectRatio?: boolean;
  /** padding 填充值 */
  padValue?: number;
}

/**
 * 分类结果
 */
export interface ClassificationResult {
  /** 类别索引 */
  index: number;
  /** 类别标签（如果提供了标签映射） */
  label?: string;
  /** 置信度分数 */
  score: number;
}

/**
 * ONNX 服务错误
 */
export class ONNXError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ONNXError';
  }
}

/**
 * 模型未找到错误
 */
export class ModelNotFoundError extends ONNXError {
  constructor(modelId: string) {
    super(`Model "${modelId}" not found`, 'MODEL_NOT_FOUND');
    this.name = 'ModelNotFoundError';
  }
}

/**
 * 模型加载失败错误
 */
export class ModelLoadError extends ONNXError {
  constructor(modelPath: string, cause?: Error) {
    super(`Failed to load model from "${modelPath}"`, 'MODEL_LOAD_FAILED', cause);
    this.name = 'ModelLoadError';
  }
}

/**
 * 推理失败错误
 */
export class InferenceError extends ONNXError {
  constructor(modelId: string, cause?: Error) {
    super(`Inference failed for model "${modelId}"`, 'INFERENCE_FAILED', cause);
    this.name = 'InferenceError';
  }
}
