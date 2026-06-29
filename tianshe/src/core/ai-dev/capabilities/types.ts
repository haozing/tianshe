import type { StructuredError } from '../../../types/error-codes';

/**
 * 通用能力返回内容
 */
export interface CapabilityContentAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
  lastModified?: string;
}

export interface CapabilityContentBase {
  annotations?: CapabilityContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface CapabilityTextContentItem extends CapabilityContentBase {
  type: 'text';
  text: string;
}

export interface CapabilityImageContentItem extends CapabilityContentBase {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface CapabilityResourceLinkContentItem extends CapabilityContentBase {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type CapabilityContentItem =
  | CapabilityTextContentItem
  | CapabilityImageContentItem
  | CapabilityResourceLinkContentItem;

/**
 * 通用能力执行结果（协议无关）
 */
export interface CapabilityCallResult {
  content: CapabilityContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: {
    error?: StructuredError;
    [key: string]: unknown;
  };
}

/**
 * 通用能力处理器签名
 */
export interface CapabilityHandlerExecutionContext {
  capability: string;
  traceId?: string;
  signal?: AbortSignal;
}

export type CapabilityHandler<TDeps = unknown> = (
  args: Record<string, unknown>,
  deps: TDeps,
  context: CapabilityHandlerExecutionContext
) => Promise<CapabilityCallResult>;
