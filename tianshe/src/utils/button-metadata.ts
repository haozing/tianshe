export type ButtonVariant = 'default' | 'primary' | 'success' | 'danger';

export interface ParameterBindingLike {
  parameterName?: string;
  bindingType?: 'field' | 'fixed' | 'rowid' | 'datasetId' | string;
  fieldName?: string;
  fixedValue?: unknown;
}

export interface ReturnBindingLike {
  returnField?: string;
  targetColumn?: string;
  updateCondition?: 'always' | 'on_success' | 'on_change' | string;
}

export interface ButtonMetadataLike extends Record<string, unknown> {
  pluginId?: unknown;
  methodId?: unknown;
  buttonLabel?: unknown;
  buttonIcon?: unknown;
  buttonColor?: unknown;
  buttonVariant?: unknown;
  confirmMessage?: unknown;
  showResult?: unknown;
  timeout?: unknown;
  automationId?: unknown;
  parameterMapping?: unknown;
  parameterBindings?: unknown;
  returnBindings?: unknown;
  triggerChain?: unknown;
}

export interface NormalizedButtonMetadata {
  pluginId?: string;
  methodId?: string;
  buttonLabel?: string;
  buttonIcon?: string;
  buttonVariant: ButtonVariant;
  confirmMessage?: string;
  showResult: boolean;
  timeout?: number;
  parameterBindings: ParameterBindingLike[];
  returnBindings: ReturnBindingLike[];
  triggerChain?: unknown;
  hasLegacyAutomation: boolean;
  isConfigured: boolean;
  mappingCount: number;
}

const BUTTON_VARIANTS = new Set<ButtonVariant>(['default', 'primary', 'success', 'danger']);

const LEGACY_BUTTON_COLOR_TO_VARIANT: Record<string, ButtonVariant> = {
  black: 'default',
  blue: 'primary',
  cyan: 'primary',
  orange: 'primary',
  pink: 'primary',
  purple: 'primary',
  green: 'success',
  red: 'danger',
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeButtonVariant(
  buttonVariant: unknown,
  buttonColor?: unknown
): ButtonVariant {
  if (typeof buttonVariant === 'string' && BUTTON_VARIANTS.has(buttonVariant as ButtonVariant)) {
    return buttonVariant as ButtonVariant;
  }

  const legacyColor = typeof buttonColor === 'string' ? buttonColor.toLowerCase() : '';
  return LEGACY_BUTTON_COLOR_TO_VARIANT[legacyColor] ?? 'primary';
}

export function normalizeButtonMetadata(
  metadata: ButtonMetadataLike | null | undefined
): NormalizedButtonMetadata {
  const normalizedMetadata = metadata ?? {};
  const pluginId = asNonEmptyString(normalizedMetadata.pluginId);
  const methodId = asNonEmptyString(normalizedMetadata.methodId);
  const hasLegacyAutomation = asNonEmptyString(normalizedMetadata.automationId) != null;
  const parameterBindings = Array.isArray(normalizedMetadata.parameterBindings)
    ? (normalizedMetadata.parameterBindings as ParameterBindingLike[])
    : [];
  const returnBindings = Array.isArray(normalizedMetadata.returnBindings)
    ? (normalizedMetadata.returnBindings as ReturnBindingLike[])
    : [];
  const legacyParameterMapping = isRecord(normalizedMetadata.parameterMapping)
    ? normalizedMetadata.parameterMapping
    : undefined;

  return {
    pluginId,
    methodId,
    buttonLabel: asNonEmptyString(normalizedMetadata.buttonLabel),
    buttonIcon: asNonEmptyString(normalizedMetadata.buttonIcon),
    buttonVariant: normalizeButtonVariant(
      normalizedMetadata.buttonVariant,
      normalizedMetadata.buttonColor
    ),
    confirmMessage: asNonEmptyString(normalizedMetadata.confirmMessage),
    showResult:
      typeof normalizedMetadata.showResult === 'boolean' ? normalizedMetadata.showResult : true,
    timeout: asNumber(normalizedMetadata.timeout),
    parameterBindings,
    returnBindings,
    triggerChain: normalizedMetadata.triggerChain,
    hasLegacyAutomation,
    isConfigured: Boolean((pluginId && methodId) || hasLegacyAutomation),
    mappingCount:
      parameterBindings.length > 0
        ? parameterBindings.length
        : legacyParameterMapping
          ? Object.keys(legacyParameterMapping).length
          : 0,
  };
}

export function buildButtonMetadataForPersistence<T extends ButtonMetadataLike>(
  metadata: T | null | undefined
): T {
  const normalized = normalizeButtonMetadata(metadata);
  const persisted: Record<string, unknown> = { ...(metadata ?? {}) };

  delete persisted.automationId;
  delete persisted.buttonColor;
  delete persisted.parameterMapping;

  persisted.buttonVariant = normalized.buttonVariant;
  persisted.showResult = normalized.showResult;

  if (normalized.pluginId) {
    persisted.pluginId = normalized.pluginId;
  } else {
    delete persisted.pluginId;
  }

  if (normalized.methodId) {
    persisted.methodId = normalized.methodId;
  } else {
    delete persisted.methodId;
  }

  if (normalized.buttonLabel) {
    persisted.buttonLabel = normalized.buttonLabel;
  } else {
    delete persisted.buttonLabel;
  }

  if (normalized.buttonIcon) {
    persisted.buttonIcon = normalized.buttonIcon;
  } else {
    delete persisted.buttonIcon;
  }

  if (normalized.confirmMessage) {
    persisted.confirmMessage = normalized.confirmMessage;
  } else {
    delete persisted.confirmMessage;
  }

  if (normalized.timeout !== undefined) {
    persisted.timeout = normalized.timeout;
  } else {
    delete persisted.timeout;
  }

  if (normalized.parameterBindings.length > 0) {
    persisted.parameterBindings = normalized.parameterBindings;
  } else {
    delete persisted.parameterBindings;
  }

  if (normalized.returnBindings.length > 0) {
    persisted.returnBindings = normalized.returnBindings;
  } else {
    delete persisted.returnBindings;
  }

  if (normalized.triggerChain !== undefined) {
    persisted.triggerChain = normalized.triggerChain;
  } else {
    delete persisted.triggerChain;
  }

  return persisted as T;
}
