/**
 * OpenAI API 类型定义
 *
 * 提供 OpenAI API 的完整类型支持，包括：
 * - Chat Completions（对话补全）
 * - Embeddings（文本嵌入）
 * - Images（图像生成）
 * - Audio（语音处理）
 * - Moderations（内容审核）
 * - Batch API（批量处理）
 * - Function Calling（工具调用）
 */

// ========== Provider 配置 ==========

/**
 * OpenAI 服务提供商类型
 */
export type OpenAIProvider = 'openai' | 'azure' | 'custom';

/**
 * OpenAI 客户端配置
 */
export interface OpenAIConfig {
  /** API Key */
  apiKey?: string;
  /** 服务提供商 */
  provider?: OpenAIProvider;
  /** 基础 URL（自定义端点）*/
  baseUrl?: string;
  /** 组织 ID（OpenAI）*/
  organization?: string;
  /** 默认模型 */
  defaultModel?: string;
  /** 默认超时时间（毫秒）*/
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;

  // Azure 特有配置
  /** Azure 资源名称 */
  azureResourceName?: string;
  /** Azure 部署名称 */
  azureDeploymentName?: string;
  /** Azure API 版本 */
  azureApiVersion?: string;
}

// ========== Chat Completions ==========

/**
 * 消息内容部分（多模态）
 */
export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * 聊天消息
 */
export interface OpenAIChatMessage {
  /** 角色 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 内容（文本或多模态内容）*/
  content: string | OpenAIContentPart[] | null;
  /** 名称（可选）*/
  name?: string;
  /** 工具调用（assistant 消息）*/
  tool_calls?: OpenAIToolCall[];
  /** 工具调用 ID（tool 消息）*/
  tool_call_id?: string;
}

/**
 * 聊天补全选项
 */
export interface OpenAIChatOptions {
  /** 消息列表 */
  messages: OpenAIChatMessage[];
  /** 模型（默认 'gpt-4o-mini'）*/
  model?: string;
  /** 温度（0-2）*/
  temperature?: number;
  /** 最大生成 token 数 */
  max_tokens?: number;
  /** Top P 采样 */
  top_p?: number;
  /** 频率惩罚（-2 到 2）*/
  frequency_penalty?: number;
  /** 存在惩罚（-2 到 2）*/
  presence_penalty?: number;
  /** 停止序列 */
  stop?: string | string[];
  /** 工具定义 */
  tools?: OpenAITool[];
  /** 工具选择策略 */
  tool_choice?: 'auto' | 'none' | 'required' | OpenAIToolChoice;
  /** 响应格式 */
  response_format?: OpenAIResponseFormat;
  /** 随机种子 */
  seed?: number;
  /** 超时时间（毫秒）*/
  timeout?: number;
  /** 用户标识 */
  user?: string;
  /** 日志概率 */
  logprobs?: boolean;
  /** Top 日志概率数量 */
  top_logprobs?: number;
}

/**
 * 响应格式
 */
export interface OpenAIResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    description?: string;
    schema: Record<string, any>;
    strict?: boolean;
  };
}

/**
 * 聊天补全响应
 */
export interface OpenAIChatResponse {
  /** 响应 ID */
  id: string;
  /** 生成的内容 */
  content: string;
  /** 角色 */
  role: 'assistant';
  /** 工具调用 */
  tool_calls?: OpenAIToolCall[];
  /** 完成原因 */
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  /** Token 使用情况 */
  usage: OpenAIUsage;
  /** 使用的模型 */
  model: string;
  /** 系统指纹 */
  system_fingerprint?: string;
}

/**
 * 流式聊天块
 */
export interface OpenAIChatChunk {
  /** 内容增量 */
  content: string;
  /** 完成原因 */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  /** 工具调用增量 */
  tool_calls?: Partial<OpenAIToolCall>[];
}

/**
 * 流式回调事件
 */
export interface OpenAIStreamCallbacks {
  /** 收到内容增量时 */
  onToken?: (token: string) => void;
  /** 收到完整消息时 */
  onMessage?: (message: string) => void;
  /** 收到工具调用时 */
  onToolCall?: (toolCall: OpenAIToolCall) => void;
  /** 完成时 */
  onFinish?: (response: OpenAIChatResponse) => void;
  /** 发生错误时 */
  onError?: (error: Error) => void;
}

// ========== Tools (Function Calling) ==========

/**
 * 工具定义
 */
export interface OpenAITool {
  type: 'function';
  function: OpenAIFunctionDefinition;
}

/**
 * 函数定义
 */
export interface OpenAIFunctionDefinition {
  /** 函数名称 */
  name: string;
  /** 函数描述 */
  description?: string;
  /** 参数 JSON Schema */
  parameters?: Record<string, any>;
  /** 是否严格模式 */
  strict?: boolean;
}

/**
 * 工具调用
 */
export interface OpenAIToolCall {
  /** 调用 ID */
  id: string;
  /** 类型 */
  type: 'function';
  /** 函数调用 */
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 工具选择
 */
export interface OpenAIToolChoice {
  type: 'function';
  function: {
    name: string;
  };
}

// ========== Embeddings ==========

/**
 * 嵌入选项
 */
export interface OpenAIEmbedOptions {
  /** 模型（默认 'text-embedding-3-small'）*/
  model?: string;
  /** 输出维度 */
  dimensions?: number;
  /** 编码格式 */
  encoding_format?: 'float' | 'base64';
  /** 用户标识 */
  user?: string;
}

/**
 * 嵌入响应
 */
export interface OpenAIEmbedResponse {
  /** 嵌入向量列表 */
  embeddings: number[][];
  /** 使用的模型 */
  model: string;
  /** Token 使用情况 */
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ========== Images ==========

/**
 * 图像生成选项
 */
export interface OpenAIImageOptions {
  /** 模型 */
  model?: 'dall-e-2' | 'dall-e-3' | 'gpt-image-1';
  /** 尺寸 */
  size?: '256x256' | '512x512' | '1024x1024' | '1024x1792' | '1792x1024';
  /** 质量 */
  quality?: 'standard' | 'hd';
  /** 风格 */
  style?: 'vivid' | 'natural';
  /** 生成数量 */
  n?: number;
  /** 响应格式 */
  response_format?: 'url' | 'b64_json';
  /** 用户标识 */
  user?: string;
}

/**
 * 图像编辑选项
 */
export interface OpenAIImageEditOptions extends Omit<OpenAIImageOptions, 'style' | 'quality'> {
  /** 遮罩图像 */
  mask?: Buffer | string;
}

/**
 * 图像响应
 */
export interface OpenAIImageResponse {
  /** 创建时间 */
  created: number;
  /** 图像数据 */
  data: OpenAIImageData[];
}

/**
 * 图像数据
 */
export interface OpenAIImageData {
  /** 图像 URL */
  url?: string;
  /** Base64 编码 */
  b64_json?: string;
  /** 修改后的提示词 */
  revised_prompt?: string;
}

// ========== Audio ==========

/**
 * 转录选项
 */
export interface OpenAITranscribeOptions {
  /** 模型（默认 'whisper-1'）*/
  model?: string;
  /** 语言（ISO-639-1 格式）*/
  language?: string;
  /** 提示词 */
  prompt?: string;
  /** 响应格式 */
  response_format?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
  /** 温度 */
  temperature?: number;
  /** 时间戳粒度 */
  timestamp_granularities?: ('word' | 'segment')[];
}

/**
 * 转录结果
 */
export interface OpenAITranscription {
  /** 转录文本 */
  text: string;
  /** 检测到的语言 */
  language?: string;
  /** 音频时长（秒）*/
  duration?: number;
  /** 词级时间戳 */
  words?: OpenAITranscriptionWord[];
  /** 段落级时间戳 */
  segments?: OpenAITranscriptionSegment[];
}

/**
 * 转录词
 */
export interface OpenAITranscriptionWord {
  word: string;
  start: number;
  end: number;
}

/**
 * 转录段落
 */
export interface OpenAITranscriptionSegment {
  id: number;
  text: string;
  start: number;
  end: number;
  tokens?: number[];
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

/**
 * 语音合成选项
 */
export interface OpenAISpeechOptions {
  /** 模型 */
  model?: 'tts-1' | 'tts-1-hd';
  /** 声音 */
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  /** 响应格式 */
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  /** 语速（0.25 - 4.0）*/
  speed?: number;
}

// ========== Moderations ==========

/**
 * 审核结果
 */
export interface OpenAIModerationResult {
  /** 结果 ID */
  id: string;
  /** 使用的模型 */
  model: string;
  /** 审核结果列表 */
  results: OpenAIModerationItem[];
}

/**
 * 审核项
 */
export interface OpenAIModerationItem {
  /** 是否被标记 */
  flagged: boolean;
  /** 分类结果 */
  categories: OpenAIModerationCategories;
  /** 分类得分 */
  category_scores: OpenAIModerationCategoryScores;
}

/**
 * 审核分类
 */
export interface OpenAIModerationCategories {
  hate: boolean;
  'hate/threatening': boolean;
  harassment: boolean;
  'harassment/threatening': boolean;
  'self-harm': boolean;
  'self-harm/intent': boolean;
  'self-harm/instructions': boolean;
  sexual: boolean;
  'sexual/minors': boolean;
  violence: boolean;
  'violence/graphic': boolean;
}

/**
 * 审核分类得分
 */
export interface OpenAIModerationCategoryScores {
  hate: number;
  'hate/threatening': number;
  harassment: number;
  'harassment/threatening': number;
  'self-harm': number;
  'self-harm/intent': number;
  'self-harm/instructions': number;
  sexual: number;
  'sexual/minors': number;
  violence: number;
  'violence/graphic': number;
}

// ========== Batch API ==========

/**
 * 批量请求
 */
export interface OpenAIBatchRequest {
  /** 自定义 ID */
  custom_id: string;
  /** 请求方法 */
  method: 'POST';
  /** 请求 URL */
  url: '/v1/chat/completions' | '/v1/embeddings';
  /** 请求体 */
  body: OpenAIChatOptions | { model: string; input: string | string[] };
}

/**
 * 批量任务选项
 */
export interface OpenAIBatchOptions {
  /** 请求列表 */
  requests: OpenAIBatchRequest[];
  /** 完成窗口（默认 '24h'）*/
  completion_window?: '24h';
  /** 元数据 */
  metadata?: Record<string, string>;
}

/**
 * 批量任务状态
 */
export type OpenAIBatchStatus =
  | 'validating'
  | 'failed'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

/**
 * 批量任务
 */
export interface OpenAIBatch {
  /** 任务 ID */
  id: string;
  /** 对象类型 */
  object: 'batch';
  /** 端点 */
  endpoint: string;
  /** 状态 */
  status: OpenAIBatchStatus;
  /** 输入文件 ID */
  input_file_id: string;
  /** 输出文件 ID */
  output_file_id?: string;
  /** 错误文件 ID */
  error_file_id?: string;
  /** 创建时间 */
  created_at: number;
  /** 进行中时间 */
  in_progress_at?: number;
  /** 完成时间 */
  completed_at?: number;
  /** 失败时间 */
  failed_at?: number;
  /** 过期时间 */
  expires_at?: number;
  /** 取消中时间 */
  cancelling_at?: number;
  /** 取消时间 */
  cancelled_at?: number;
  /** 请求计数 */
  request_counts?: {
    total: number;
    completed: number;
    failed: number;
  };
  /** 元数据 */
  metadata?: Record<string, string>;
  /** 错误信息 */
  errors?: {
    object: 'list';
    data: Array<{
      code: string;
      message: string;
      param?: string;
      line?: number;
    }>;
  };
}

/**
 * 批量响应项
 */
export interface OpenAIBatchResponseItem {
  /** 自定义 ID */
  custom_id: string;
  /** 响应 */
  response?: {
    status_code: number;
    body: OpenAIChatResponse | OpenAIEmbedResponse;
  };
  /** 错误 */
  error?: {
    code: string;
    message: string;
  };
}

// ========== Files ==========

/**
 * 文件用途
 */
export type OpenAIFilePurpose =
  | 'assistants'
  | 'assistants_output'
  | 'batch'
  | 'batch_output'
  | 'fine-tune'
  | 'fine-tune-results'
  | 'vision';

/**
 * 文件对象
 */
export interface OpenAIFile {
  /** 文件 ID */
  id: string;
  /** 对象类型 */
  object: 'file';
  /** 文件大小（字节）*/
  bytes: number;
  /** 创建时间 */
  created_at: number;
  /** 文件名 */
  filename: string;
  /** 用途 */
  purpose: OpenAIFilePurpose;
  /** 状态 */
  status?: 'uploaded' | 'processed' | 'error';
  /** 状态详情 */
  status_details?: string;
}

// ========== Models ==========

/**
 * 模型对象
 */
export interface OpenAIModel {
  /** 模型 ID */
  id: string;
  /** 对象类型 */
  object: 'model';
  /** 创建时间 */
  created: number;
  /** 所有者 */
  owned_by: string;
}

// ========== Usage ==========

/**
 * Token 使用情况
 */
export interface OpenAIUsage {
  /** 提示词 token 数 */
  prompt_tokens: number;
  /** 补全 token 数 */
  completion_tokens: number;
  /** 总 token 数 */
  total_tokens: number;
  /** 缓存 token 数（新版 API）*/
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  /** 补全 token 详情 */
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

// ========== 错误类型 ==========
// 注：OpenAI 错误详情已在 src/core/js-plugin/errors.ts 的 OpenAIError 类中定义
// 避免重复定义，统一使用 OpenAIError.details
