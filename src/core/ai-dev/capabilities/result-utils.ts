import type {
  CapabilityCallResult,
  CapabilityContentItem,
  CapabilityResourceLinkContentItem,
} from './types';
import {
  createStructuredErrorPayload,
  formatStructuredErrorText,
  type StructuredError,
} from '../../../types/error-codes';

export interface StructuredCapabilityPayload<TData extends Record<string, unknown>> {
  summary: string;
  data: TData;
  truncated?: boolean;
  nextActionHints?: string[];
  reasonCode?: string;
  retryable?: boolean;
  recommendedNextTools?: string[];
  authoritativeFields?: string[];
}

export interface StructuredCapabilitySuccessPayload<TData extends Record<string, unknown>>
  extends Record<string, unknown> {
  ok: true;
  summary: string;
  data: TData;
  truncated: boolean;
  nextActionHints: string[];
  reasonCode: string | null;
  retryable: boolean;
  recommendedNextTools: string[];
  authoritativeFields: string[];
}

export interface CapabilityResourceLink {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

const asTrimmedText = (value: unknown): string => String(value == null ? '' : value).trim();

export const toJsonText = (value: unknown): string => JSON.stringify(value, null, 2);

export const createResourceLinkItem = (
  resource: CapabilityResourceLink
): CapabilityResourceLinkContentItem => ({
  type: 'resource_link',
  uri: asTrimmedText(resource.uri),
  name: asTrimmedText(resource.name),
  ...(asTrimmedText(resource.title) ? { title: asTrimmedText(resource.title) } : {}),
  ...(asTrimmedText(resource.description)
    ? { description: asTrimmedText(resource.description) }
    : {}),
  ...(asTrimmedText(resource.mimeType) ? { mimeType: asTrimmedText(resource.mimeType) } : {}),
});

export function createStructuredResult<TData extends Record<string, unknown>>(
  payload: StructuredCapabilityPayload<TData>,
  options: {
    includeJsonInText?: boolean;
    title?: string;
    resourceLinks?: CapabilityResourceLink[];
  } = {}
): CapabilityCallResult {
  const normalized: StructuredCapabilitySuccessPayload<TData> = {
    ok: true,
    summary: asTrimmedText(payload.summary),
    data: payload.data,
    truncated: payload.truncated === true,
    nextActionHints: (payload.nextActionHints || []).map((item) => asTrimmedText(item)).filter(Boolean),
    reasonCode: asTrimmedText(payload.reasonCode) || null,
    retryable: payload.retryable === true,
    recommendedNextTools: (payload.recommendedNextTools || [])
      .map((item) => asTrimmedText(item))
      .filter(Boolean),
    authoritativeFields: (payload.authoritativeFields || [])
      .map((item) => asTrimmedText(item))
      .filter(Boolean),
  };

  const title = asTrimmedText(options.title);
  const includeJsonInText = options.includeJsonInText === true || (!title && !normalized.summary);
  const textParts = [title, normalized.summary].filter(Boolean);

  if (includeJsonInText) {
    textParts.push(toJsonText(normalized));
  }

  const content: CapabilityContentItem[] = [
    {
      type: 'text',
      text: textParts.join('\n\n') || toJsonText(normalized),
    },
  ];

  for (const resourceLink of options.resourceLinks || []) {
    content.push(createResourceLinkItem(resourceLink));
  }

  return {
    content,
    structuredContent: normalized,
  };
}

export function createStructuredErrorResult(
  error: StructuredError,
  options: {
    resourceLinks?: CapabilityResourceLink[];
  } = {}
): CapabilityCallResult {
  const structured = createStructuredErrorPayload(error);
  const content: CapabilityContentItem[] = [
    {
      type: 'text',
      text: formatStructuredErrorText(error),
    },
  ];

  for (const resourceLink of options.resourceLinks || []) {
    content.push(createResourceLinkItem(resourceLink));
  }

  return {
    content,
    structuredContent: structured as Record<string, unknown>,
    isError: true,
    _meta: { error },
  };
}
