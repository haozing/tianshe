/**
 * Image Search Types
 *
 * 图像搜索模块类型定义
 */

/**
 * 向量索引空间类型
 */
export type SpaceType = 'cosine' | 'l2' | 'ip';

/**
 * 特征提取器配置
 */
export interface FeatureExtractorConfig {
  /** 模型路径 */
  modelPath: string;
  /** 输入尺寸 [width, height] */
  inputSize: [number, number];
  /** 输入张量名称 */
  inputName: string;
  /** 输出张量名称（特征层） */
  outputName: string;
  /** 特征维度 */
  featureDim: number;
  /** 是否 L2 归一化输出 */
  normalizeOutput: boolean;
}

/**
 * HNSW 索引配置
 */
export interface HNSWIndexConfig {
  /** 向量空间类型 */
  spaceType: SpaceType;
  /** 向量维度 */
  dim: number;
  /** 最大元素数量 */
  maxElements: number;
  /** 每层连接数（影响精度和速度） */
  M?: number;
  /** 构建时的 ef 参数 */
  efConstruction?: number;
}

/**
 * 搜索选项
 */
export interface SearchOptions {
  /** 返回前 K 个结果 */
  topK?: number;
  /** 相似度阈值 (0-1)，低于此值的结果会被过滤 */
  threshold?: number;
  /** 搜索时的 ef 参数（影响精度） */
  efSearch?: number;
}

/**
 * 模板信息
 */
export interface TemplateInfo {
  /** 模板 ID */
  id: string;
  /** 模板名称（可选） */
  name?: string;
  /** 图像路径（可选） */
  imagePath?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 添加时间 */
  addedAt: number;
}

/**
 * 搜索结果
 */
export interface SearchResult {
  /** 模板 ID */
  templateId: string;
  /** 相似度分数 (0-1) */
  similarity: number;
  /** 模板信息（如果可用） */
  template?: TemplateInfo;
}

/**
 * 批量添加结果
 */
export interface BatchAddResult {
  /** 成功数量 */
  success: number;
  /** 失败数量 */
  failed: number;
  /** 失败详情 */
  errors: Array<{ id: string; error: string }>;
}

/**
 * 索引统计信息
 */
export interface IndexStats {
  /** 当前元素数量 */
  count: number;
  /** 最大容量 */
  maxElements: number;
  /** 向量维度 */
  dim: number;
  /** 空间类型 */
  spaceType: SpaceType;
  /** 索引文件大小（字节） */
  indexSize?: number;
}

/**
 * 图像搜索服务配置
 */
export interface ImageSearchServiceConfig {
  /** 模型目录路径 */
  modelsDir: string;
  /** 索引存储路径 */
  indexPath?: string;
  /** 是否自动加载索引 */
  autoLoadIndex?: boolean;
  /** 最大模板数量 */
  maxTemplates?: number;
  /** 执行提供者 */
  executionProvider?: 'cpu' | 'cuda' | 'directml';
}

/**
 * 模型下载进度
 */
export interface DownloadProgress {
  /** 当前下载字节 */
  downloaded: number;
  /** 总字节数 */
  total: number;
  /** 进度百分比 */
  percent: number;
}

/**
 * 模型信息
 */
export interface ModelInfo {
  /** 模型名称 */
  name: string;
  /** 模型版本 */
  version: string;
  /** 文件大小（字节） */
  size: number;
  /** 下载 URL */
  url: string;
  /** 备用下载 URL 列表 */
  urls?: string[];
  /** SHA256 校验和 */
  sha256: string;
  /** 特征维度 */
  featureDim: number;
  /** 输入尺寸 */
  inputSize: [number, number];
}

/**
 * 预置模型列表
 */
export const PRESET_MODELS: Record<string, ModelInfo> = {
  'mobilenetv3-small': {
    name: 'MobileNetV3-Small',
    version: '0.47.0',
    size: 9_421_334,
    url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/mobilenet_v3_small/releases/v0.47.0/mobilenet_v3_small-onnx-float.zip',
    sha256: '3e9d154fc4a716dfa901b43a194acad042eec3477cd753a16d1dc15c37d9dd9a',
    featureDim: 576,
    inputSize: [224, 224],
  },
};
