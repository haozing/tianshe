/**
 * OpenAI Namespace
 *
 * 提供 OpenAI API 能力的命名空间接口
 * 基于 core/ai-service/OpenAIService 的插件层封装
 *
 * @example
 * // 设置 API Key
 * helpers.openai.setApiKey('sk-xxx');
 *
 * // 简单对话
 * const response = await helpers.openai.chat({
 *   messages: [{ role: 'user', content: '你好' }]
 * });
 *
 * // 流式对话（AsyncGenerator）
 * for await (const chunk of helpers.openai.chatStream({
 *   messages: [{ role: 'user', content: '写一首诗' }]
 * })) {
 *   process.stdout.write(chunk.content);
 * }
 *
 * // 流式对话（回调模式）
 * await helpers.openai.chatWithCallbacks({
 *   messages: [{ role: 'user', content: '写一首诗' }]
 * }, {
 *   onToken: (token) => process.stdout.write(token),
 *   onFinish: (response) => console.log('完成:', response.usage)
 * });
 */

import { OpenAIService, type APIKeyProvider } from '../../ai-service';
import type { StorageNamespace } from './storage';

// Re-export all types from centralized types
export type {
  OpenAIConfig,
  OpenAIProvider,
  OpenAIChatOptions,
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIStreamCallbacks,
  OpenAIEmbedOptions,
  OpenAIImageOptions,
  OpenAIImageEditOptions,
  OpenAIImageResponse,
  OpenAITranscribeOptions,
  OpenAITranscription,
  OpenAISpeechOptions,
  OpenAIModerationResult,
  OpenAIBatchOptions,
  OpenAIBatch,
  OpenAIBatchResponseItem,
  OpenAIFile,
  OpenAIFilePurpose,
  OpenAIModel,
  OpenAIUsage,
} from '../../../types/openai';

import type {
  OpenAIConfig,
  OpenAIProvider,
  OpenAIChatOptions,
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIStreamCallbacks,
  OpenAIEmbedOptions,
  OpenAIImageOptions,
  OpenAIImageEditOptions,
  OpenAIImageResponse,
  OpenAITranscribeOptions,
  OpenAITranscription,
  OpenAISpeechOptions,
  OpenAIModerationResult,
  OpenAIBatchOptions,
  OpenAIBatch,
  OpenAIBatchResponseItem,
  OpenAIFile,
  OpenAIFilePurpose,
  OpenAIModel,
} from '../../../types/openai';

/**
 * Storage adapter that implements APIKeyProvider interface
 */
class StorageAPIKeyProvider implements APIKeyProvider {
  constructor(private storage: StorageNamespace) {}

  async getConfig(key: string): Promise<string | null> {
    const value = await this.storage.getConfig(key);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }
}

/**
 * OpenAI 命名空间
 *
 * 提供 OpenAI API 的完整能力：
 * - 对话补全（Chat Completions）
 * - 文本嵌入（Embeddings）
 * - 图像生成（Images）
 * - 语音处理（Audio）
 * - 内容审核（Moderations）
 * - 批量处理（Batch API）
 * - 文件管理（Files）
 */
export class OpenAINamespace {
  private service: OpenAIService;

  constructor(
    private pluginId: string,
    private storage: StorageNamespace
  ) {
    this.service = new OpenAIService({
      callerId: `Plugin:${pluginId}`,
      apiKeyProvider: new StorageAPIKeyProvider(storage),
    });
  }

  // ========== 配置管理 ==========

  /**
   * 设置 API Key
   *
   * @param apiKey - OpenAI API Key
   *
   * @example
   * helpers.openai.setApiKey('sk-xxxxxxxxxxxx');
   */
  setApiKey(apiKey: string): void {
    this.service.setApiKey(apiKey);
  }

  /**
   * 设置服务提供商
   *
   * @param provider - 提供商类型
   *
   * @example
   * // 使用 Azure OpenAI
   * helpers.openai.setProvider('azure');
   * helpers.openai.setAzureConfig({
   *   resourceName: 'my-resource',
   *   deploymentName: 'gpt-4o',
   *   apiVersion: '2024-02-01'
   * });
   */
  setProvider(provider: OpenAIProvider): void {
    this.service.setProvider(provider);
  }

  /**
   * 设置基础 URL（用于自定义端点或代理）
   *
   * @param baseUrl - 基础 URL
   *
   * @example
   * // 使用代理
   * helpers.openai.setBaseUrl('https://my-proxy.com/v1');
   */
  setBaseUrl(baseUrl: string): void {
    this.service.setBaseUrl(baseUrl);
  }

  /**
   * 设置默认模型
   *
   * @param model - 模型名称
   *
   * @example
   * helpers.openai.setDefaultModel('gpt-4o');
   */
  setDefaultModel(model: string): void {
    this.service.setDefaultModel(model);
  }

  /**
   * 设置组织 ID
   *
   * @param organization - 组织 ID
   */
  setOrganization(organization: string): void {
    this.service.setOrganization(organization);
  }

  /**
   * 设置 Azure 配置
   *
   * @param azureConfig - Azure 配置
   *
   * @example
   * helpers.openai.setProvider('azure');
   * helpers.openai.setAzureConfig({
   *   resourceName: 'my-azure-resource',
   *   deploymentName: 'gpt-4o-deployment',
   *   apiVersion: '2024-08-01-preview'
   * });
   */
  setAzureConfig(azureConfig: {
    resourceName: string;
    deploymentName: string;
    apiVersion?: string;
  }): void {
    this.service.setAzureConfig(azureConfig);
  }

  /**
   * 设置超时时间
   *
   * @param timeout - 超时时间（毫秒）
   */
  setTimeout(timeout: number): void {
    this.service.setTimeout(timeout);
  }

  /**
   * 设置最大重试次数
   *
   * @param maxRetries - 重试次数
   */
  setMaxRetries(maxRetries: number): void {
    this.service.setMaxRetries(maxRetries);
  }

  /**
   * 配置 OpenAI（一次性设置多个选项）
   *
   * @param config - 配置对象
   *
   * @example
   * helpers.openai.configure({
   *   apiKey: 'sk-xxx',
   *   defaultModel: 'gpt-4o',
   *   timeout: 30000
   * });
   */
  configure(config: Partial<OpenAIConfig>): void {
    this.service.configure(config);
  }

  // ========== Chat Completions ==========

  /**
   * 聊天补全
   *
   * @param options - 聊天选项
   * @returns 聊天响应
   *
   * @example
   * const response = await helpers.openai.chat({
   *   messages: [
   *     { role: 'system', content: '你是一个专业的电商助手' },
   *     { role: 'user', content: '如何优化产品标题？' }
   *   ],
   *   model: 'gpt-4o',
   *   temperature: 0.7
   * });
   * console.log(response.content);
   */
  async chat(options: OpenAIChatOptions): Promise<OpenAIChatResponse> {
    return this.service.chat(options);
  }

  /**
   * 流式聊天补全（AsyncGenerator 模式）
   *
   * @param options - 聊天选项
   * @yields 聊天块
   *
   * @example
   * for await (const chunk of helpers.openai.chatStream({
   *   messages: [{ role: 'user', content: '写一首诗' }]
   * })) {
   *   process.stdout.write(chunk.content);
   * }
   */
  async *chatStream(options: OpenAIChatOptions): AsyncGenerator<OpenAIChatChunk> {
    yield* this.service.chatStream(options);
  }

  /**
   * 流式聊天补全（回调模式）
   *
   * @param options - 聊天选项
   * @param callbacks - 回调函数
   * @returns 完整响应
   *
   * @example
   * const response = await helpers.openai.chatWithCallbacks({
   *   messages: [{ role: 'user', content: '写一首诗' }]
   * }, {
   *   onToken: (token) => process.stdout.write(token),
   *   onToolCall: (call) => console.log('Tool call:', call),
   *   onFinish: (response) => console.log('Done:', response.usage)
   * });
   */
  async chatWithCallbacks(
    options: OpenAIChatOptions,
    callbacks: OpenAIStreamCallbacks
  ): Promise<OpenAIChatResponse> {
    return this.service.chatWithCallbacks(options, callbacks);
  }

  // ========== Embeddings ==========

  /**
   * 生成文本嵌入向量
   *
   * @param input - 输入文本（单个或数组）
   * @param options - 嵌入选项
   * @returns 嵌入向量数组
   *
   * @example
   * // 单个文本
   * const [embedding] = await helpers.openai.embed('产品描述文本');
   *
   * // 多个文本
   * const embeddings = await helpers.openai.embed(['文本1', '文本2', '文本3']);
   *
   * // 指定维度
   * const embeddings = await helpers.openai.embed('文本', {
   *   model: 'text-embedding-3-large',
   *   dimensions: 1024
   * });
   */
  async embed(input: string | string[], options?: OpenAIEmbedOptions): Promise<number[][]> {
    return this.service.embed(input, options);
  }

  // ========== Images ==========

  /**
   * 生成图像
   *
   * @param prompt - 图像描述
   * @param options - 生成选项
   * @returns 图像响应
   *
   * @example
   * const result = await helpers.openai.generateImage('一只可爱的猫咪', {
   *   model: 'dall-e-3',
   *   size: '1024x1024',
   *   quality: 'hd'
   * });
   * console.log(result.data[0].url);
   */
  async generateImage(prompt: string, options?: OpenAIImageOptions): Promise<OpenAIImageResponse> {
    return this.service.generateImage(prompt, options);
  }

  /**
   * 编辑图像
   *
   * @param image - 原图像（Buffer 或 base64 字符串）
   * @param prompt - 编辑描述
   * @param options - 编辑选项
   * @returns 图像响应
   *
   * @example
   * const imageBuffer = fs.readFileSync('image.png');
   * const result = await helpers.openai.editImage(
   *   imageBuffer,
   *   '把背景改成海滩'
   * );
   */
  async editImage(
    image: Buffer | string,
    prompt: string,
    options?: OpenAIImageEditOptions
  ): Promise<OpenAIImageResponse> {
    return this.service.editImage(image, prompt, options);
  }

  // ========== Audio ==========

  /**
   * 语音转文字（Whisper）
   *
   * @param audio - 音频数据（Buffer 或文件路径）
   * @param options - 转录选项
   * @returns 转录结果
   *
   * @example
   * const audioBuffer = fs.readFileSync('audio.mp3');
   * const result = await helpers.openai.transcribe(audioBuffer, {
   *   language: 'zh',
   *   timestamp_granularities: ['word', 'segment']
   * });
   * console.log(result.text);
   */
  async transcribe(
    audio: Buffer | string,
    options?: OpenAITranscribeOptions
  ): Promise<OpenAITranscription> {
    return this.service.transcribe(audio, options);
  }

  /**
   * 文字转语音（TTS）
   *
   * @param text - 要转换的文本
   * @param options - 语音选项
   * @returns 音频数据 Buffer
   *
   * @example
   * const audioBuffer = await helpers.openai.speak('欢迎使用我们的产品', {
   *   voice: 'alloy',
   *   model: 'tts-1-hd'
   * });
   * fs.writeFileSync('output.mp3', audioBuffer);
   */
  async speak(text: string, options?: OpenAISpeechOptions): Promise<Buffer> {
    return this.service.speak(text, options);
  }

  // ========== Moderations ==========

  /**
   * 内容审核
   *
   * @param input - 要审核的文本（单个或数组）
   * @returns 审核结果
   *
   * @example
   * const result = await helpers.openai.moderate('要审核的文本');
   * if (result.results[0].flagged) {
   *   console.log('内容被标记:', result.results[0].categories);
   * }
   */
  async moderate(input: string | string[]): Promise<OpenAIModerationResult> {
    return this.service.moderate(input);
  }

  // ========== Batch API ==========

  /**
   * 创建批量任务
   *
   * @param options - 批量选项
   * @returns 批量任务
   *
   * @example
   * const batch = await helpers.openai.createBatch({
   *   requests: [
   *     {
   *       custom_id: 'request-1',
   *       method: 'POST',
   *       url: '/v1/chat/completions',
   *       body: {
   *         model: 'gpt-4o-mini',
   *         messages: [{ role: 'user', content: '你好' }]
   *       }
   *     },
   *     // ... 更多请求
   *   ]
   * });
   * console.log('Batch ID:', batch.id);
   */
  async createBatch(options: OpenAIBatchOptions): Promise<OpenAIBatch> {
    return this.service.createBatch(options);
  }

  /**
   * 获取批量任务状态
   *
   * @param batchId - 批量任务 ID
   * @returns 批量任务
   */
  async getBatch(batchId: string): Promise<OpenAIBatch> {
    return this.service.getBatch(batchId);
  }

  /**
   * 取消批量任务
   *
   * @param batchId - 批量任务 ID
   * @returns 批量任务
   */
  async cancelBatch(batchId: string): Promise<OpenAIBatch> {
    return this.service.cancelBatch(batchId);
  }

  /**
   * 列出批量任务
   *
   * @param limit - 返回数量限制
   * @returns 批量任务列表
   */
  async listBatches(limit?: number): Promise<OpenAIBatch[]> {
    return this.service.listBatches(limit);
  }

  /**
   * 获取批量任务结果
   *
   * @param batchId - 批量任务 ID
   * @returns 结果列表
   */
  async getBatchResults(batchId: string): Promise<OpenAIBatchResponseItem[]> {
    return this.service.getBatchResults(batchId);
  }

  // ========== Files ==========

  /**
   * 上传文件
   *
   * @param file - 文件内容（Buffer）
   * @param filename - 文件名
   * @param purpose - 文件用途
   * @returns 文件对象
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    purpose: OpenAIFilePurpose
  ): Promise<OpenAIFile> {
    return this.service.uploadFile(file, filename, purpose);
  }

  /**
   * 列出文件
   *
   * @param purpose - 过滤用途（可选）
   * @returns 文件列表
   */
  async listFiles(purpose?: OpenAIFilePurpose): Promise<OpenAIFile[]> {
    return this.service.listFiles(purpose);
  }

  /**
   * 删除文件
   *
   * @param fileId - 文件 ID
   */
  async deleteFile(fileId: string): Promise<void> {
    return this.service.deleteFile(fileId);
  }

  /**
   * 获取文件内容
   *
   * @param fileId - 文件 ID
   * @returns 文件内容
   */
  async getFileContent(fileId: string): Promise<string> {
    return this.service.getFileContent(fileId);
  }

  // ========== Models ==========

  /**
   * 列出可用模型
   *
   * @returns 模型列表
   *
   * @example
   * const models = await helpers.openai.listModels();
   * console.log(models.map(m => m.id));
   */
  async listModels(): Promise<OpenAIModel[]> {
    return this.service.listModels();
  }

  /**
   * 获取模型信息
   *
   * @param modelId - 模型 ID
   * @returns 模型信息
   */
  async getModel(modelId: string): Promise<OpenAIModel> {
    return this.service.getModel(modelId);
  }
}
