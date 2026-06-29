/**
 * AI Service Module
 *
 * 独立的 AI 服务模块，提供 OpenAI API 能力
 * 从 js-plugin/namespaces 提取，遵循高内聚低耦合原则
 *
 * 使用方式：
 * 1. 直接使用：import { OpenAIService } from '@core/ai-service'
 * 2. 通过 js-plugin：helpers.openai.*
 */

// === OpenAI 服务 ===
export { OpenAIService, type APIKeyProvider } from './openai';
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
} from './openai';

// === 错误类型 ===
export { AIServiceError, OpenAIError } from './errors';
