/**
 * ONNX Runtime 模块导出
 *
 * 提供统一的 ONNX 模型推理能力
 */

// 核心服务
export { ONNXRuntimeService, getONNXService } from './onnx-service';

// 工具函数
export {
  toTypedArray,
  toArray,
  softmax,
  topK,
  cosineSimilarity,
  l2Normalize,
  getTensorSize,
  validateDims,
  createTensor,
  imageToNCHW,
  imageToNHWC,
} from './tensor-utils';

// 类型导出
export type {
  TensorDataType,
  ExecutionProvider,
  TensorData,
  TensorMeta,
  ModelMeta,
  ONNXModelConfig,
  InferenceOptions,
  InferenceResult,
  LoadedModelInfo,
  ImagePreprocessOptions,
  ClassificationResult,
} from './types';

// 错误类型
export { ONNXError, ModelNotFoundError, ModelLoadError, InferenceError } from './types';
