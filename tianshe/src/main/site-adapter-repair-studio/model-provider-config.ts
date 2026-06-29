import {
  AIRPA_RUNTIME_CONFIG,
  type RepairStudioModelProviderConfig,
} from '../../constants/runtime-config';
import { redactSensitiveText } from '../../utils/redaction';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SiteAdapterRepairModelDiff,
  SiteAdapterRepairModelProvider,
  SiteAdapterRepairModelRequest,
  SiteAdapterRepairModelTask,
} from '../../core/site-adapter-repair-studio';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface OpenAICompatibleChatCompletion {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export interface ConfiguredRepairModelProviderOptions {
  config?: RepairStudioModelProviderConfig;
  fetchImpl?: FetchLike;
  credentialStore?: RepairStudioModelCredentialStore;
  credentialCodec?: RepairStudioModelCredentialCodec;
}

export interface RepairStudioModelCredentialInput {
  provider: RepairStudioModelProviderConfig['provider'];
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface RepairStudioStoredModelCredential {
  schemaVersion: 1;
  provider: RepairStudioModelProviderConfig['provider'];
  baseUrl: string;
  sealedApiKey: string;
  model: string;
  timeoutMs: number;
  keyVersion: number;
  updatedAt: string;
}

export interface RepairStudioModelCredentialStore {
  load(): RepairStudioStoredModelCredential | null;
  save(record: RepairStudioStoredModelCredential): void;
  clear(): void;
}

export interface RepairStudioModelCredentialCodec {
  seal(apiKey: string): string;
  unseal(sealedApiKey: string): string;
}

export type RepairStudioModelProviderTemplateId =
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'local-openai-compatible';

export interface RepairStudioModelProviderTemplate {
  id: RepairStudioModelProviderTemplateId;
  label: string;
  provider: RepairStudioModelProviderConfig['provider'];
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  env: {
    provider: string;
    baseUrl: string;
    apiKey: string[];
    model: string[];
    timeoutMs: string;
  };
}

export interface RepairStudioModelProviderConfigSummary {
  configured: boolean;
  provider: RepairStudioModelProviderConfig['provider'];
  activeTemplateId: RepairStudioModelProviderTemplateId | null;
  baseUrlConfigured: boolean;
  modelConfigured: boolean;
  apiKeyConfigured: boolean;
  credentialSource: 'env' | 'stored' | 'missing';
  storedCredential: {
    configured: boolean;
    keyVersion: number | null;
    updatedAt: string | null;
  };
  timeoutMs: number;
  missingEnv: string[];
  templates: RepairStudioModelProviderTemplate[];
}

const REPAIR_STUDIO_PROVIDER_ENV = 'TIANSHE_REPAIR_MODEL_PROVIDER';
const REPAIR_STUDIO_BASE_URL_ENV = 'TIANSHE_REPAIR_MODEL_BASE_URL';
const REPAIR_STUDIO_API_KEY_ENV_NAMES = ['TIANSHE_REPAIR_MODEL_API_KEY'];
const REPAIR_STUDIO_OPENAI_API_KEY_ENV_NAMES = [
  'TIANSHE_REPAIR_MODEL_API_KEY',
  'OPENAI_API_KEY',
];
const REPAIR_STUDIO_MODEL_ENV_NAMES = ['TIANSHE_REPAIR_MODEL', 'TIANSHE_REPAIR_MODEL_NAME'];
const REPAIR_STUDIO_TIMEOUT_ENV = 'TIANSHE_REPAIR_MODEL_TIMEOUT_MS';

export const REPAIR_STUDIO_MODEL_PROVIDER_TEMPLATES: RepairStudioModelProviderTemplate[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    env: {
      provider: REPAIR_STUDIO_PROVIDER_ENV,
      baseUrl: REPAIR_STUDIO_BASE_URL_ENV,
      apiKey: REPAIR_STUDIO_OPENAI_API_KEY_ENV_NAMES,
      model: REPAIR_STUDIO_MODEL_ENV_NAMES,
      timeoutMs: REPAIR_STUDIO_TIMEOUT_ENV,
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    provider: 'openai-compatible',
    defaultBaseUrl: '',
    requiresApiKey: true,
    env: {
      provider: REPAIR_STUDIO_PROVIDER_ENV,
      baseUrl: REPAIR_STUDIO_BASE_URL_ENV,
      apiKey: REPAIR_STUDIO_API_KEY_ENV_NAMES,
      model: REPAIR_STUDIO_MODEL_ENV_NAMES,
      timeoutMs: REPAIR_STUDIO_TIMEOUT_ENV,
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    env: {
      provider: REPAIR_STUDIO_PROVIDER_ENV,
      baseUrl: REPAIR_STUDIO_BASE_URL_ENV,
      apiKey: REPAIR_STUDIO_API_KEY_ENV_NAMES,
      model: REPAIR_STUDIO_MODEL_ENV_NAMES,
      timeoutMs: REPAIR_STUDIO_TIMEOUT_ENV,
    },
  },
  {
    id: 'local-openai-compatible',
    label: 'Local OpenAI-compatible',
    provider: 'openai-compatible',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: true,
    env: {
      provider: REPAIR_STUDIO_PROVIDER_ENV,
      baseUrl: REPAIR_STUDIO_BASE_URL_ENV,
      apiKey: REPAIR_STUDIO_API_KEY_ENV_NAMES,
      model: REPAIR_STUDIO_MODEL_ENV_NAMES,
      timeoutMs: REPAIR_STUDIO_TIMEOUT_ENV,
    },
  },
];

const DEFAULT_REPAIR_STUDIO_MODEL_TIMEOUT_MS = 60_000;

const DEFAULT_REPAIR_STUDIO_CREDENTIAL_CODEC: RepairStudioModelCredentialCodec = {
  seal(apiKey) {
    return Buffer.from(apiKey, 'utf8').toString('base64');
  },
  unseal(sealedApiKey) {
    return Buffer.from(sealedApiKey, 'base64').toString('utf8');
  },
};

function cloneStoredCredential(
  record: RepairStudioStoredModelCredential | null
): RepairStudioStoredModelCredential | null {
  return record ? { ...record } : null;
}

export class InMemoryRepairStudioModelCredentialStore
  implements RepairStudioModelCredentialStore
{
  private record: RepairStudioStoredModelCredential | null = null;

  load(): RepairStudioStoredModelCredential | null {
    return cloneStoredCredential(this.record);
  }

  save(record: RepairStudioStoredModelCredential): void {
    this.record = cloneStoredCredential(record);
  }

  clear(): void {
    this.record = null;
  }
}

export class FileRepairStudioModelCredentialStore implements RepairStudioModelCredentialStore {
  constructor(private readonly filePath: string) {}

  load(): RepairStudioStoredModelCredential | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!isStoredCredentialRecord(parsed)) {
      throw new RepairModelProviderConfigError('Stored repair model credential is invalid');
    }
    return parsed;
  }

  save(record: RepairStudioStoredModelCredential): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
  }
}

export class RepairModelProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairModelProviderConfigError';
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const candidate = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!candidate) {
    throw new RepairModelProviderConfigError('Repair model provider baseUrl is required');
  }
  return candidate;
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) {
    return fetchImpl;
  }
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new RepairModelProviderConfigError('globalThis.fetch is not available');
}

function createTimeoutSignal(
  timeoutMs: number,
  upstreamSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error('Repair model provider request timed out'));
  }, Math.max(1, timeoutMs));

  const abortFromUpstream = (): void => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredCredentialRecord(value: unknown): value is RepairStudioStoredModelCredential {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.provider === 'openai' || value.provider === 'openai-compatible') &&
    typeof value.baseUrl === 'string' &&
    typeof value.sealedApiKey === 'string' &&
    typeof value.model === 'string' &&
    typeof value.timeoutMs === 'number' &&
    typeof value.keyVersion === 'number' &&
    typeof value.updatedAt === 'string'
  );
}

function isCompleteRepairModelProviderConfig(config: RepairStudioModelProviderConfig): boolean {
  return Boolean(config.provider && config.baseUrl && config.apiKey && config.model);
}

function normalizeCredentialInput(
  input: RepairStudioModelCredentialInput
): RepairStudioModelProviderConfig {
  if (input.provider !== 'openai' && input.provider !== 'openai-compatible') {
    throw new RepairModelProviderConfigError('Repair model provider is required');
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  if (!apiKey) {
    throw new RepairModelProviderConfigError('Repair model provider API key is required');
  }
  if (!model) {
    throw new RepairModelProviderConfigError('Repair model provider model is required');
  }
  const timeoutMs =
    Number.isInteger(input.timeoutMs) && input.timeoutMs && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, 600_000)
      : DEFAULT_REPAIR_STUDIO_MODEL_TIMEOUT_MS;

  return {
    provider: input.provider,
    baseUrl,
    apiKey,
    model,
    timeoutMs,
  };
}

function configFromStoredCredential(
  record: RepairStudioStoredModelCredential,
  codec: RepairStudioModelCredentialCodec
): RepairStudioModelProviderConfig {
  return {
    provider: record.provider,
    baseUrl: record.baseUrl,
    apiKey: codec.unseal(record.sealedApiKey),
    model: record.model,
    timeoutMs: record.timeoutMs,
  };
}

export function saveRepairStudioModelProviderCredential(
  input: RepairStudioModelCredentialInput,
  store: RepairStudioModelCredentialStore,
  options: {
    credentialCodec?: RepairStudioModelCredentialCodec;
    now?: () => Date;
  } = {}
): RepairStudioStoredModelCredential {
  const config = normalizeCredentialInput(input);
  const current = store.load();
  const codec = options.credentialCodec || DEFAULT_REPAIR_STUDIO_CREDENTIAL_CODEC;
  const record: RepairStudioStoredModelCredential = {
    schemaVersion: 1,
    provider: config.provider,
    baseUrl: config.baseUrl,
    sealedApiKey: codec.seal(config.apiKey),
    model: config.model,
    timeoutMs: config.timeoutMs,
    keyVersion: (current?.keyVersion || 0) + 1,
    updatedAt: (options.now?.() || new Date()).toISOString(),
  };
  store.save(record);
  return { ...record, sealedApiKey: '[redacted]' };
}

export function clearRepairStudioModelProviderCredential(
  store: RepairStudioModelCredentialStore
): void {
  store.clear();
}

export function resolveRepairStudioModelProviderConfig(
  options: {
    config?: RepairStudioModelProviderConfig;
    credentialStore?: RepairStudioModelCredentialStore;
    credentialCodec?: RepairStudioModelCredentialCodec;
  } = {}
): { config: RepairStudioModelProviderConfig; credentialSource: 'env' | 'stored' | 'missing'; storedCredential: RepairStudioStoredModelCredential | null } {
  const envConfig = options.config || AIRPA_RUNTIME_CONFIG.repairStudio.modelProvider;
  const storedCredential = options.credentialStore?.load() || null;
  if (isCompleteRepairModelProviderConfig(envConfig)) {
    return { config: envConfig, credentialSource: 'env', storedCredential };
  }
  if (storedCredential) {
    return {
      config: configFromStoredCredential(
        storedCredential,
        options.credentialCodec || DEFAULT_REPAIR_STUDIO_CREDENTIAL_CODEC
      ),
      credentialSource: 'stored',
      storedCredential,
    };
  }
  return { config: envConfig, credentialSource: 'missing', storedCredential };
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (isRecord(part) && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseModelDiffFromText(text: string): SiteAdapterRepairModelDiff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new RepairModelProviderConfigError(
      `Repair model provider returned non-JSON content: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!isRecord(parsed)) {
    throw new RepairModelProviderConfigError('Repair model provider JSON must be an object');
  }

  const changes = parsed.changes;
  if (typeof parsed.summary !== 'string' || !Array.isArray(changes)) {
    throw new RepairModelProviderConfigError(
      'Repair model provider JSON must include summary and changes'
    );
  }

  return {
    summary: parsed.summary,
    generatedBy: typeof parsed.generatedBy === 'string' ? parsed.generatedBy : null,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
    changes: changes.map((change, index) => {
      if (!isRecord(change) || typeof change.path !== 'string' || typeof change.after !== 'string') {
        throw new RepairModelProviderConfigError(
          `Repair model provider change ${index} must include path and after`
        );
      }
      return {
        path: change.path,
        before: typeof change.before === 'string' ? change.before : undefined,
        after: change.after,
      };
    }),
  };
}

function summarizeRepairTask(task: SiteAdapterRepairModelTask): Record<string, unknown> {
  if (task.kind === 'read-only') {
    return {
      kind: task.kind,
      taskId: task.task.taskId,
      adapterId: task.task.adapterId,
      fixtureName: task.task.fixtureName,
      sideEffectLevel: task.task.sideEffectLevel,
      missingFields: task.task.missingFields,
      before: task.task.before,
      expected: task.task.expected,
      selectorDiagnostics: task.task.selectorDiagnostics,
      fixture: task.task.fixture,
      allowedChangeGlobs: task.task.allowedChangeGlobs,
      forbiddenScopes: task.task.forbiddenScopes,
      prompt: task.task.prompt,
    };
  }

  return {
    kind: task.kind,
    taskId: task.task.taskId,
    adapterId: task.task.adapterId,
    procedureId: task.task.procedureId,
    sideEffectLevel: task.task.sideEffectLevel,
    failedStepIds: task.task.failedStepIds,
    evidence: task.task.evidence,
    allowedChangeGlobs: task.task.allowedChangeGlobs,
    forbiddenScopes: task.task.forbiddenScopes,
    prompt: task.task.prompt,
  };
}

function buildRepairModelMessages(request: SiteAdapterRepairModelRequest): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  return [
    {
      role: 'system',
      content: [
        'You generate scoped code diffs for Tianshe Site Adapter Repair Studio.',
        'Return JSON only with this exact shape: {"summary":"...","changes":[{"path":"...","before":"optional","after":"full file or replacement content"}]}.',
        'Never change paths outside allowedChangeGlobs. Never include markdown.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(summarizeRepairTask(request), null, 2),
    },
  ];
}

function getChatCompletionContent(payload: OpenAICompatibleChatCompletion): string {
  const content = payload.choices?.[0]?.message?.content;
  const text = stringifyContent(content);
  if (!text.trim()) {
    throw new RepairModelProviderConfigError('Repair model provider response was empty');
  }
  return text;
}

function resolveActiveTemplateId(
  config: RepairStudioModelProviderConfig
): RepairStudioModelProviderTemplateId | null {
  if (!config.provider) {
    return null;
  }
  const normalizedBaseUrl = String(config.baseUrl || '').trim().toLowerCase();
  if (config.provider === 'openai') {
    return 'openai';
  }
  if (normalizedBaseUrl.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (
    normalizedBaseUrl.includes('127.0.0.1') ||
    normalizedBaseUrl.includes('localhost') ||
    normalizedBaseUrl.includes('0.0.0.0')
  ) {
    return 'local-openai-compatible';
  }
  return 'openai-compatible';
}

function getTemplateForConfig(
  config: RepairStudioModelProviderConfig
): RepairStudioModelProviderTemplate | null {
  const activeTemplateId = resolveActiveTemplateId(config);
  return (
    REPAIR_STUDIO_MODEL_PROVIDER_TEMPLATES.find(
      (template) => template.id === activeTemplateId
    ) || null
  );
}

export function getRepairStudioModelProviderConfigSummary(
  config: RepairStudioModelProviderConfig = AIRPA_RUNTIME_CONFIG.repairStudio.modelProvider,
  options: {
    credentialStore?: RepairStudioModelCredentialStore;
    credentialCodec?: RepairStudioModelCredentialCodec;
  } = {}
): RepairStudioModelProviderConfigSummary {
  const resolved = resolveRepairStudioModelProviderConfig({
    config,
    credentialStore: options.credentialStore,
    credentialCodec: options.credentialCodec,
  });
  const activeTemplate = getTemplateForConfig(resolved.config);
  const providerConfigured = Boolean(resolved.config.provider);
  const baseUrlConfigured = Boolean(resolved.config.baseUrl);
  const modelConfigured = Boolean(resolved.config.model);
  const apiKeyConfigured = Boolean(resolved.config.apiKey);
  const missingEnv = [
    providerConfigured ? null : REPAIR_STUDIO_PROVIDER_ENV,
    baseUrlConfigured ? null : REPAIR_STUDIO_BASE_URL_ENV,
    modelConfigured ? null : REPAIR_STUDIO_MODEL_ENV_NAMES.join(' or '),
    apiKeyConfigured
      ? null
      : (activeTemplate?.env.apiKey || REPAIR_STUDIO_API_KEY_ENV_NAMES).join(' or '),
  ].filter((item): item is string => Boolean(item));

  return {
    configured: providerConfigured && baseUrlConfigured && modelConfigured && apiKeyConfigured,
    provider: resolved.config.provider,
    activeTemplateId: activeTemplate?.id || null,
    baseUrlConfigured,
    modelConfigured,
    apiKeyConfigured,
    credentialSource: resolved.credentialSource,
    storedCredential: {
      configured: Boolean(resolved.storedCredential),
      keyVersion: resolved.storedCredential?.keyVersion ?? null,
      updatedAt: resolved.storedCredential?.updatedAt ?? null,
    },
    timeoutMs: resolved.config.timeoutMs,
    missingEnv,
    templates: REPAIR_STUDIO_MODEL_PROVIDER_TEMPLATES,
  };
}

export function createConfiguredSiteAdapterRepairModelProvider(
  options: ConfiguredRepairModelProviderOptions = {}
): SiteAdapterRepairModelProvider | null {
  const { config } = resolveRepairStudioModelProviderConfig({
    config: options.config,
    credentialStore: options.credentialStore,
    credentialCodec: options.credentialCodec,
  });
  if (!config.provider || !config.apiKey || !config.model || !config.baseUrl) {
    return null;
  }

  const fetchImpl = resolveFetch(options.fetchImpl);
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const providerId = `repair-studio:${config.provider}`;

  return {
    providerId,
    model: config.model,
    async generateRepairDiff(request) {
      const { signal, cleanup } = createTimeoutSignal(config.timeoutMs, request.signal);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages: buildRepairModelMessages(request),
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
          signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          const redactedBody = body ? redactSensitiveText(body).slice(0, 240) : '';
          throw new RepairModelProviderConfigError(
            `Repair model provider request failed: ${response.status} ${response.statusText}${
              redactedBody ? ` ${redactedBody}` : ''
            }`
          );
        }

        const payload = (await response.json()) as OpenAICompatibleChatCompletion;
        return parseModelDiffFromText(getChatCompletionContent(payload));
      } finally {
        cleanup();
      }
    },
  };
}
