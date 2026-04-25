/**
 * OpenAI Service
 *
 * 提供 OpenAI API 能力的服务层
 * 支持 OpenAI、Azure OpenAI 和自定义端点
 *
 * 从 js-plugin/namespaces/openai.ts 提取
 */

import OpenAI from 'openai';
import { AzureOpenAI } from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { OpenAIError } from './errors';

// Re-export all types from the centralized types file
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
} from '../../types/openai';

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
  OpenAIUsage,
} from '../../types/openai';

/**
 * API Key 提供者接口
 */
export interface APIKeyProvider {
  getConfig(key: string): Promise<string | null>;
}

/**
 * OpenAI 服务配置
 */
export interface OpenAIServiceConfig {
  /** 调用者标识 */
  callerId?: string;
  /** API Key 提供者（可选，用于从配置存储获取 key） */
  apiKeyProvider?: APIKeyProvider;
}

/**
 * OpenAI 服务
 *
 * 提供 OpenAI API 的完整能力：
 * - 对话补全（Chat Completions）
 * - 文本嵌入（Embeddings）
 * - 图像生成（Images）
 * - 语音处理（Audio）
 * - 内容审核（Moderations）
 * - 批量处理（Batch API）
 * - 文件管理（Files）
 *
 * @example
 * const service = new OpenAIService({ callerId: 'my-app' });
 * service.setApiKey('sk-xxx');
 * const response = await service.chat({
 *   messages: [{ role: 'user', content: '你好' }]
 * });
 */
export class OpenAIService {
  private config: OpenAIConfig = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    timeout: 60000,
    maxRetries: 2,
  };

  private client: OpenAI | AzureOpenAI | null = null;
  private callerId: string;
  private apiKeyProvider?: APIKeyProvider;

  constructor(serviceConfig?: OpenAIServiceConfig) {
    this.callerId = serviceConfig?.callerId || 'OpenAIService';
    this.apiKeyProvider = serviceConfig?.apiKeyProvider;
  }

  // ========== 配置管理 ==========

  setApiKey(apiKey: string): void {
    this.validateString(apiKey, 'apiKey');
    this.config.apiKey = apiKey;
    this.client = null;
  }

  setProvider(provider: OpenAIProvider): void {
    this.validateEnum(provider, 'provider', ['openai', 'azure', 'custom']);
    this.config.provider = provider;
    this.client = null;
  }

  setBaseUrl(baseUrl: string): void {
    this.validateURL(baseUrl, 'baseUrl');
    this.config.baseUrl = baseUrl;
    this.client = null;
  }

  setDefaultModel(model: string): void {
    this.validateString(model, 'model');
    this.config.defaultModel = model;
  }

  setOrganization(organization: string): void {
    this.validateString(organization, 'organization');
    this.config.organization = organization;
    this.client = null;
  }

  setAzureConfig(azureConfig: {
    resourceName: string;
    deploymentName: string;
    apiVersion?: string;
  }): void {
    this.validateString(azureConfig.resourceName, 'resourceName');
    this.validateString(azureConfig.deploymentName, 'deploymentName');
    this.config.azureResourceName = azureConfig.resourceName;
    this.config.azureDeploymentName = azureConfig.deploymentName;
    this.config.azureApiVersion = azureConfig.apiVersion || '2024-08-01-preview';
    this.client = null;
  }

  setTimeout(timeout: number): void {
    this.validateNumber(timeout, 'timeout', { min: 1000 });
    this.config.timeout = timeout;
  }

  setMaxRetries(maxRetries: number): void {
    this.validateNumber(maxRetries, 'maxRetries', { min: 0, max: 10 });
    this.config.maxRetries = maxRetries;
    this.client = null;
  }

  configure(config: Partial<OpenAIConfig>): void {
    if (config.apiKey) this.setApiKey(config.apiKey);
    if (config.provider) this.setProvider(config.provider);
    if (config.baseUrl) this.setBaseUrl(config.baseUrl);
    if (config.defaultModel) this.setDefaultModel(config.defaultModel);
    if (config.organization) this.setOrganization(config.organization);
    if (config.timeout) this.setTimeout(config.timeout);
    if (config.maxRetries !== undefined) this.setMaxRetries(config.maxRetries);
    if (config.azureResourceName && config.azureDeploymentName) {
      this.setAzureConfig({
        resourceName: config.azureResourceName,
        deploymentName: config.azureDeploymentName,
        apiVersion: config.azureApiVersion,
      });
    }
  }

  // ========== 私有方法 ==========

  private async getApiKey(): Promise<string> {
    if (this.config.apiKey) {
      return this.config.apiKey;
    }

    if (this.apiKeyProvider) {
      try {
        const stored = await this.apiKeyProvider.getConfig('openai_api_key');
        if (stored) {
          return stored;
        }
      } catch {
        // 忽略存储读取错误
      }
    }

    throw new OpenAIError('OpenAI API key not configured', {
      errorType: 'config',
      hint: "Use service.setApiKey('sk-xxx') to configure the API key",
    });
  }

  private async getClient(): Promise<OpenAI | AzureOpenAI> {
    if (this.client) {
      return this.client;
    }

    const apiKey = await this.getApiKey();

    if (this.config.provider === 'azure') {
      if (!this.config.azureResourceName || !this.config.azureDeploymentName) {
        throw new OpenAIError('Azure configuration incomplete', {
          errorType: 'config',
          hint: 'Use service.setAzureConfig({ resourceName, deploymentName })',
        });
      }

      this.client = new AzureOpenAI({
        apiKey,
        endpoint: `https://${this.config.azureResourceName}.openai.azure.com`,
        apiVersion: this.config.azureApiVersion || '2024-08-01-preview',
        maxRetries: this.config.maxRetries,
        timeout: this.config.timeout,
      });
    } else {
      this.client = new OpenAI({
        apiKey,
        baseURL: this.config.baseUrl,
        organization: this.config.organization,
        maxRetries: this.config.maxRetries,
        timeout: this.config.timeout,
      });
    }

    return this.client;
  }

  private handleError(error: any): never {
    if (error instanceof OpenAIError) {
      throw error;
    }

    if (error instanceof OpenAI.APIError) {
      const statusCode = error.status;
      let errorType:
        | 'auth'
        | 'rate_limit'
        | 'invalid_request'
        | 'server'
        | 'timeout'
        | 'network'
        | 'config' = 'server';
      let message = error.message;

      if (statusCode === 401) {
        errorType = 'auth';
        message = 'Invalid API key or unauthorized access';
      } else if (statusCode === 429) {
        errorType = 'rate_limit';
        message = 'Rate limit exceeded. Please retry after some time.';
      } else if (statusCode === 400) {
        errorType = 'invalid_request';
      } else if (statusCode && statusCode >= 500) {
        errorType = 'server';
        message = 'OpenAI server error. Please retry later.';
      }

      throw new OpenAIError(
        message,
        {
          statusCode,
          errorType,
          errorCode: error.code || undefined,
          requestId: error.headers?.['x-request-id'],
        },
        error
      );
    }

    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      throw new OpenAIError(
        'Request timed out',
        { errorType: 'timeout', timeout: this.config.timeout },
        error
      );
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new OpenAIError(
        'Network error: Unable to connect to OpenAI API',
        { errorType: 'network' },
        error
      );
    }

    throw new OpenAIError(error.message || 'Unknown OpenAI error', { errorType: 'server' }, error);
  }

  // ========== 验证辅助方法 ==========

  private validateString(value: any, name: string): void {
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      throw new OpenAIError(`${name} must be a non-empty string`, {
        errorType: 'invalid_request',
      });
    }
  }

  private validateNumber(value: any, name: string, options?: { min?: number; max?: number }): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new OpenAIError(`${name} must be a number`, { errorType: 'invalid_request' });
    }
    if (options?.min !== undefined && value < options.min) {
      throw new OpenAIError(`${name} must be at least ${options.min}`, {
        errorType: 'invalid_request',
      });
    }
    if (options?.max !== undefined && value > options.max) {
      throw new OpenAIError(`${name} must be at most ${options.max}`, {
        errorType: 'invalid_request',
      });
    }
  }

  private validateEnum(value: any, name: string, allowed: string[]): void {
    if (!allowed.includes(value)) {
      throw new OpenAIError(`${name} must be one of: ${allowed.join(', ')}`, {
        errorType: 'invalid_request',
      });
    }
  }

  private validateURL(value: any, name: string): void {
    try {
      new URL(value);
    } catch {
      throw new OpenAIError(`${name} must be a valid URL`, { errorType: 'invalid_request' });
    }
  }

  private validateArray(value: any, name: string): void {
    if (!Array.isArray(value)) {
      throw new OpenAIError(`${name} must be an array`, { errorType: 'invalid_request' });
    }
  }

  private validateChatOptions(options: OpenAIChatOptions): void {
    this.validateArray(options.messages, 'messages');
    if (options.messages.length === 0) {
      throw new OpenAIError('messages array cannot be empty', { errorType: 'invalid_request' });
    }
  }

  private buildChatRequestParams(options: OpenAIChatOptions, model: string) {
    return {
      model: this.config.provider === 'azure' ? this.config.azureDeploymentName! : model,
      messages: options.messages as any,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      stop: options.stop,
      tools: options.tools as any,
      tool_choice: options.tool_choice as any,
      response_format: options.response_format as any,
      seed: options.seed,
      user: options.user,
    };
  }

  // ========== Chat Completions ==========

  async chat(options: OpenAIChatOptions): Promise<OpenAIChatResponse> {
    this.validateChatOptions(options);

    const client = await this.getClient();
    const model = options.model || this.config.defaultModel || 'gpt-4o-mini';

    console.log(
      `[${this.callerId}] OpenAI chat request (${options.messages.length} messages, model: ${model})`
    );

    try {
      const response = await client.chat.completions.create({
        ...this.buildChatRequestParams(options, model),
        logprobs: options.logprobs,
        top_logprobs: options.top_logprobs,
      });

      const choice = response.choices[0];

      return {
        id: response.id,
        content: choice.message.content || '',
        role: 'assistant',
        tool_calls: choice.message.tool_calls as any,
        finish_reason: choice.finish_reason as any,
        usage: response.usage as OpenAIUsage,
        model: response.model,
        system_fingerprint: response.system_fingerprint || undefined,
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async *chatStream(options: OpenAIChatOptions): AsyncGenerator<OpenAIChatChunk> {
    this.validateChatOptions(options);

    const client = await this.getClient();
    const model = options.model || this.config.defaultModel || 'gpt-4o-mini';

    console.log(
      `[${this.callerId}] OpenAI chat stream request (${options.messages.length} messages, model: ${model})`
    );

    try {
      const stream = (await client.chat.completions.create({
        ...this.buildChatRequestParams(options, model),
        stream: true,
      })) as Stream<ChatCompletionChunk>;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield {
            content: delta.content,
            finish_reason: chunk.choices[0]?.finish_reason as any,
          };
        }
        if (delta?.tool_calls) {
          yield {
            content: '',
            tool_calls: delta.tool_calls as any,
            finish_reason: chunk.choices[0]?.finish_reason as any,
          };
        }
      }
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async chatWithCallbacks(
    options: OpenAIChatOptions,
    callbacks: OpenAIStreamCallbacks
  ): Promise<OpenAIChatResponse> {
    this.validateChatOptions(options);

    const client = await this.getClient();
    const model = options.model || this.config.defaultModel || 'gpt-4o-mini';

    let fullContent = '';
    const toolCalls: any[] = [];
    let finishReason: string | null = null;
    let responseId = '';
    let responseModel = model;

    try {
      const stream = (await client.chat.completions.create({
        ...this.buildChatRequestParams(options, model),
        stream: true,
        stream_options: { include_usage: true },
      })) as Stream<ChatCompletionChunk>;

      let usage: OpenAIUsage | undefined;

      for await (const chunk of stream) {
        responseId = chunk.id;
        responseModel = chunk.model;

        const choice = chunk.choices[0];
        if (choice) {
          const delta = choice.delta;

          if (delta?.content) {
            fullContent += delta.content;
            callbacks.onToken?.(delta.content);
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) toolCalls[tc.index].id = tc.id;
                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                if (tc.function?.arguments)
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        if (chunk.usage) {
          usage = chunk.usage as OpenAIUsage;
        }
      }

      for (const tc of toolCalls) {
        if (tc && tc.id) {
          callbacks.onToolCall?.(tc);
        }
      }

      callbacks.onMessage?.(fullContent);

      const response: OpenAIChatResponse = {
        id: responseId,
        content: fullContent,
        role: 'assistant',
        tool_calls: toolCalls.filter((tc) => tc && tc.id),
        finish_reason: finishReason as any,
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: responseModel,
      };

      callbacks.onFinish?.(response);

      return response;
    } catch (error: any) {
      callbacks.onError?.(error);
      this.handleError(error);
    }
  }

  // ========== Embeddings ==========

  async embed(input: string | string[], options?: OpenAIEmbedOptions): Promise<number[][]> {
    if (typeof input === 'string') {
      this.validateString(input, 'input');
    } else {
      this.validateArray(input, 'input');
    }

    const client = await this.getClient();
    const model = options?.model || 'text-embedding-3-small';

    console.log(`[${this.callerId}] OpenAI embed request (model: ${model})`);

    try {
      const response = await client.embeddings.create({
        model,
        input,
        dimensions: options?.dimensions,
        encoding_format: options?.encoding_format,
        user: options?.user,
      });

      return response.data.map((item) => item.embedding);
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Images ==========

  async generateImage(prompt: string, options?: OpenAIImageOptions): Promise<OpenAIImageResponse> {
    this.validateString(prompt, 'prompt');

    const client = await this.getClient();
    const model = options?.model || 'dall-e-3';

    console.log(`[${this.callerId}] OpenAI image generation (model: ${model})`);

    try {
      const response = await client.images.generate({
        model,
        prompt,
        size: options?.size || '1024x1024',
        quality: options?.quality,
        style: options?.style,
        n: options?.n || 1,
        response_format: options?.response_format || 'url',
        user: options?.user,
      });

      return {
        created: response.created,
        data: (response.data || []).map((item) => ({
          url: item.url,
          b64_json: item.b64_json,
          revised_prompt: item.revised_prompt,
        })),
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async editImage(
    image: Buffer | string,
    prompt: string,
    options?: OpenAIImageEditOptions
  ): Promise<OpenAIImageResponse> {
    this.validateString(prompt, 'prompt');

    const client = await this.getClient();

    console.log(`[${this.callerId}] OpenAI image edit`);

    try {
      const imageBuffer = Buffer.isBuffer(image) ? image : Buffer.from(image, 'base64');
      const imageFile = new File([new Uint8Array(imageBuffer)], 'image.png', { type: 'image/png' });

      let maskFile: File | undefined;
      if (options?.mask) {
        const maskBuffer = Buffer.isBuffer(options.mask)
          ? options.mask
          : Buffer.from(options.mask, 'base64');
        maskFile = new File([new Uint8Array(maskBuffer)], 'mask.png', { type: 'image/png' });
      }

      const response = await client.images.edit({
        image: imageFile,
        prompt,
        mask: maskFile,
        model: options?.model || 'dall-e-2',
        size: options?.size as any,
        n: options?.n || 1,
        response_format: options?.response_format || 'url',
        user: options?.user,
      });

      return {
        created: response.created,
        data: (response.data || []).map((item) => ({
          url: item.url,
          b64_json: item.b64_json,
          revised_prompt: item.revised_prompt,
        })),
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Audio ==========

  async transcribe(
    audio: Buffer | string,
    options?: OpenAITranscribeOptions
  ): Promise<OpenAITranscription> {
    const client = await this.getClient();
    const model = options?.model || 'whisper-1';

    console.log(`[${this.callerId}] OpenAI transcribe (model: ${model})`);

    try {
      let audioBuffer: Buffer;
      let filename = 'audio.mp3';
      let mimeType = 'audio/mpeg';

      if (Buffer.isBuffer(audio)) {
        audioBuffer = audio;
      } else if (typeof audio === 'string') {
        const fs = await import('fs');
        const path = await import('path');
        audioBuffer = fs.readFileSync(audio);
        filename = path.basename(audio);

        const ext = path.extname(audio).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.mp3': 'audio/mpeg',
          '.mp4': 'audio/mp4',
          '.m4a': 'audio/mp4',
          '.wav': 'audio/wav',
          '.webm': 'audio/webm',
          '.ogg': 'audio/ogg',
          '.flac': 'audio/flac',
        };
        mimeType = mimeTypes[ext] || 'audio/mpeg';
      } else {
        throw new OpenAIError('audio must be a Buffer or file path', {
          errorType: 'invalid_request',
        });
      }

      const audioFile = new File([new Uint8Array(audioBuffer)], filename, { type: mimeType });

      const response = await client.audio.transcriptions.create({
        file: audioFile,
        model,
        language: options?.language,
        prompt: options?.prompt,
        response_format: options?.response_format || 'verbose_json',
        temperature: options?.temperature,
        timestamp_granularities: options?.timestamp_granularities,
      });

      if (typeof response === 'string') {
        return { text: response };
      }

      return {
        text: response.text,
        language: (response as any).language,
        duration: (response as any).duration,
        words: (response as any).words,
        segments: (response as any).segments,
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async speak(text: string, options?: OpenAISpeechOptions): Promise<Buffer> {
    this.validateString(text, 'text');

    const client = await this.getClient();
    const model = options?.model || 'tts-1';

    console.log(`[${this.callerId}] OpenAI TTS (model: ${model})`);

    try {
      const response = await client.audio.speech.create({
        model,
        voice: options?.voice || 'alloy',
        input: text,
        response_format: options?.response_format || 'mp3',
        speed: options?.speed,
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Moderations ==========

  async moderate(input: string | string[]): Promise<OpenAIModerationResult> {
    if (typeof input === 'string') {
      this.validateString(input, 'input');
    } else {
      this.validateArray(input, 'input');
    }

    const client = await this.getClient();

    console.log(`[${this.callerId}] OpenAI moderation`);

    try {
      const response = await client.moderations.create({
        input,
        model: 'omni-moderation-latest',
      });

      return {
        id: response.id,
        model: response.model,
        results: response.results as any,
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Batch API ==========

  async createBatch(options: OpenAIBatchOptions): Promise<OpenAIBatch> {
    this.validateArray(options.requests, 'requests');

    const client = await this.getClient();

    console.log(`[${this.callerId}] Creating batch (${options.requests.length} requests)`);

    try {
      const jsonlContent = options.requests.map((req) => JSON.stringify(req)).join('\n');
      const file = new File([jsonlContent], 'batch_input.jsonl', { type: 'application/jsonl' });
      const uploadedFile = await client.files.create({
        file,
        purpose: 'batch',
      });

      const batch = await client.batches.create({
        input_file_id: uploadedFile.id,
        endpoint: '/v1/chat/completions',
        completion_window: options.completion_window || '24h',
        metadata: options.metadata,
      });

      return batch as unknown as OpenAIBatch;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async getBatch(batchId: string): Promise<OpenAIBatch> {
    this.validateString(batchId, 'batchId');

    const client = await this.getClient();

    try {
      const batch = await client.batches.retrieve(batchId);
      return batch as unknown as OpenAIBatch;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async cancelBatch(batchId: string): Promise<OpenAIBatch> {
    this.validateString(batchId, 'batchId');

    const client = await this.getClient();

    try {
      const batch = await client.batches.cancel(batchId);
      return batch as unknown as OpenAIBatch;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async listBatches(limit?: number): Promise<OpenAIBatch[]> {
    const client = await this.getClient();

    try {
      const response = await client.batches.list({ limit });
      return response.data as unknown as OpenAIBatch[];
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async getBatchResults(batchId: string): Promise<OpenAIBatchResponseItem[]> {
    this.validateString(batchId, 'batchId');

    const client = await this.getClient();

    try {
      const batch = await client.batches.retrieve(batchId);

      if (batch.status !== 'completed') {
        throw new OpenAIError(`Batch is not completed. Status: ${batch.status}`, {
          errorType: 'invalid_request',
        });
      }

      if (!batch.output_file_id) {
        throw new OpenAIError('Batch has no output file', { errorType: 'invalid_request' });
      }

      const fileResponse = await client.files.content(batch.output_file_id);
      const content = await fileResponse.text();

      const results: OpenAIBatchResponseItem[] = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      return results;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Files ==========

  async uploadFile(
    file: Buffer,
    filename: string,
    purpose: OpenAIFilePurpose
  ): Promise<OpenAIFile> {
    this.validateString(filename, 'filename');
    this.validateString(purpose, 'purpose');

    const client = await this.getClient();

    console.log(`[${this.callerId}] Uploading file: ${filename} (purpose: ${purpose})`);

    try {
      const fileObj = new File([new Uint8Array(file)], filename);
      const response = await client.files.create({
        file: fileObj,
        purpose: purpose as any,
      });

      return response as OpenAIFile;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async listFiles(purpose?: OpenAIFilePurpose): Promise<OpenAIFile[]> {
    const client = await this.getClient();

    try {
      const response = await client.files.list({ purpose: purpose as any });
      return response.data as OpenAIFile[];
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    this.validateString(fileId, 'fileId');

    const client = await this.getClient();

    try {
      await client.files.delete(fileId);
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async getFileContent(fileId: string): Promise<string> {
    this.validateString(fileId, 'fileId');

    const client = await this.getClient();

    try {
      const response = await client.files.content(fileId);
      return await response.text();
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // ========== Models ==========

  async listModels(): Promise<OpenAIModel[]> {
    const client = await this.getClient();

    try {
      const response = await client.models.list();
      return response.data as OpenAIModel[];
    } catch (error: any) {
      this.handleError(error);
    }
  }

  async getModel(modelId: string): Promise<OpenAIModel> {
    this.validateString(modelId, 'modelId');

    const client = await this.getClient();

    try {
      const response = await client.models.retrieve(modelId);
      return response as OpenAIModel;
    } catch (error: any) {
      this.handleError(error);
    }
  }
}
