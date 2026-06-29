/**
 * Tensor 工具函数
 *
 * 提供张量数据处理的辅助函数
 */

import type { TensorData, TensorDataType } from './types';

/**
 * 将数字数组转换为 TypedArray
 */
export function toTypedArray(
  data: number[] | Float32Array | Uint8Array | Int32Array,
  type: TensorDataType = 'float32'
):
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array {
  if (data instanceof Float32Array || data instanceof Uint8Array || data instanceof Int32Array) {
    return data;
  }

  switch (type) {
    case 'float32':
      return new Float32Array(data);
    case 'float64':
      return new Float64Array(data);
    case 'int8':
      return new Int8Array(data);
    case 'int16':
      return new Int16Array(data);
    case 'int32':
      return new Int32Array(data);
    case 'uint8':
      return new Uint8Array(data);
    case 'uint16':
      return new Uint16Array(data);
    case 'uint32':
      return new Uint32Array(data);
    default:
      return new Float32Array(data);
  }
}

/**
 * 将 TypedArray 转换为普通数组
 */
export function toArray(data: TensorData['data']): number[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    return Array.from(data, (v) => Number(v));
  }
  return Array.from(data);
}

/**
 * Softmax 函数
 */
export function softmax(data: number[] | Float32Array): number[] {
  const arr = Array.isArray(data) ? data : Array.from(data);
  const maxVal = Math.max(...arr);
  const expValues = arr.map((v) => Math.exp(v - maxVal));
  const sumExp = expValues.reduce((a, b) => a + b, 0);
  return expValues.map((v) => v / sumExp);
}

/**
 * 获取 Top-K 结果
 */
export function topK(
  data: number[] | Float32Array,
  k: number
): Array<{ index: number; score: number }> {
  const arr = Array.isArray(data) ? data : Array.from(data);
  const indexed = arr.map((score, index) => ({ index, score }));
  indexed.sort((a, b) => b.score - a.score);
  return indexed.slice(0, k);
}

/**
 * 计算余弦相似度
 */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const arrA = Array.isArray(a) ? a : Array.from(a);
  const arrB = Array.isArray(b) ? b : Array.from(b);

  if (arrA.length !== arrB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < arrA.length; i++) {
    dotProduct += arrA[i] * arrB[i];
    normA += arrA[i] * arrA[i];
    normB += arrB[i] * arrB[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
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
 * const normalized = l2Normalize([3, 4]); // [0.6, 0.8]
 */
export function l2Normalize(vector: number[] | Float32Array): number[] {
  const arr = Array.isArray(vector) ? vector : Array.from(vector);

  let normSquared = 0;
  for (const v of arr) {
    normSquared += v * v;
  }

  const norm = Math.sqrt(normSquared);

  // 处理零向量情况
  if (norm === 0) {
    return arr;
  }

  return arr.map((v) => v / norm);
}

/**
 * 计算张量的总元素数
 */
export function getTensorSize(dims: number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}

/**
 * 验证张量维度是否匹配
 */
export function validateDims(actual: number[], expected: number[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  for (let i = 0; i < actual.length; i++) {
    // -1 表示动态维度，任何值都匹配
    if (expected[i] !== -1 && actual[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 创建张量数据
 */
export function createTensor(
  data: number[] | Float32Array | Uint8Array | Int32Array,
  dims: number[],
  type: TensorDataType = 'float32'
): TensorData {
  return {
    data: toTypedArray(data, type),
    dims,
    type,
  };
}

/**
 * 将图像 Buffer 转换为 NCHW 格式的 Float32Array
 * 假设输入是 RGB 格式的原始像素数据
 */
export function imageToNCHW(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: {
    normalize?:
      | 'imagenet'
      | 'zero-one'
      | { mean: [number, number, number]; std: [number, number, number] };
    colorFormat?: 'rgb' | 'bgr';
  } = {}
): Float32Array {
  const { normalize = 'zero-one', colorFormat = 'rgb' } = options;

  const channels = 3;
  const result = new Float32Array(channels * height * width);

  // ImageNet 标准化参数
  let mean = [0, 0, 0];
  let std = [1, 1, 1];

  if (normalize === 'imagenet') {
    mean = [0.485, 0.456, 0.406];
    std = [0.229, 0.224, 0.225];
  } else if (typeof normalize === 'object') {
    mean = normalize.mean;
    std = normalize.std;
  }

  // 转换为 NCHW 格式
  for (let c = 0; c < channels; c++) {
    const channelIndex = colorFormat === 'bgr' ? 2 - c : c;
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        const srcIdx = (h * width + w) * channels + channelIndex;
        const dstIdx = c * height * width + h * width + w;
        let value = pixels[srcIdx] / 255.0;

        if (normalize !== 'zero-one') {
          value = (value - mean[c]) / std[c];
        }

        result[dstIdx] = value;
      }
    }
  }

  return result;
}

/**
 * 将图像 Buffer 转换为 NHWC 格式的 Float32Array
 */
export function imageToNHWC(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: {
    normalize?:
      | 'imagenet'
      | 'zero-one'
      | { mean: [number, number, number]; std: [number, number, number] };
    colorFormat?: 'rgb' | 'bgr';
  } = {}
): Float32Array {
  const { normalize = 'zero-one', colorFormat = 'rgb' } = options;

  const channels = 3;
  const result = new Float32Array(height * width * channels);

  let mean = [0, 0, 0];
  let std = [1, 1, 1];

  if (normalize === 'imagenet') {
    mean = [0.485, 0.456, 0.406];
    std = [0.229, 0.224, 0.225];
  } else if (typeof normalize === 'object') {
    mean = normalize.mean;
    std = normalize.std;
  }

  for (let h = 0; h < height; h++) {
    for (let w = 0; w < width; w++) {
      for (let c = 0; c < channels; c++) {
        const channelIndex = colorFormat === 'bgr' ? 2 - c : c;
        const srcIdx = (h * width + w) * channels + channelIndex;
        const dstIdx = (h * width + w) * channels + c;
        let value = pixels[srcIdx] / 255.0;

        if (normalize !== 'zero-one') {
          value = (value - mean[c]) / std[c];
        }

        result[dstIdx] = value;
      }
    }
  }

  return result;
}
