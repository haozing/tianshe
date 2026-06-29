import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../../../../../types/error-codes';

type SurfaceErrorOptions = {
  code?: string;
  details?: string;
  suggestion?: string;
  context?: Record<string, unknown>;
};

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createFeatureUnavailableError(
  featureName: string,
  options: Omit<SurfaceErrorOptions, 'code'> = {}
): StructuredError {
  return createStructuredError(
    ErrorCode.NOT_FOUND,
    `${featureName} is not available on the current browser implementation`,
    {
      details:
        options.details || `The current browser implementation does not support ${featureName}.`,
      suggestion:
        options.suggestion ||
        'Confirm that the browser runtime is initialized correctly, or switch to an implementation that supports this feature.',
      ...(options.context ? { context: options.context } : {}),
    }
  );
}

export function createBrowserNotReadyError(): StructuredError {
  return createStructuredError(ErrorCode.BROWSER_NOT_READY, 'Browser is not ready', {
    suggestion: 'Create or acquire a browser instance before calling this tool.',
  });
}

export function createNamespaceUnavailableError(
  namespace: string,
  options: Omit<SurfaceErrorOptions, 'code'> = {}
): StructuredError {
  return createStructuredError(ErrorCode.OPERATION_FAILED, `${namespace} namespace is unavailable`, {
    suggestion:
      options.suggestion ||
      'Confirm that the HTTP MCP server is configured with the required namespace dependencies.',
    ...(options.details ? { details: options.details } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
}

export function createOperationFailedError(
  operationLabel: string,
  error: unknown,
  options: SurfaceErrorOptions = {}
): StructuredError {
  const message = getErrorMessage(error);
  return createStructuredError(
    options.code || ErrorCode.OPERATION_FAILED,
    `${operationLabel} failed: ${message}`,
    {
      ...(options.details ? { details: options.details } : {}),
      ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      ...(options.context ? { context: options.context } : {}),
    }
  );
}

export function createTimedOutError(
  subjectLabel: string,
  options: SurfaceErrorOptions = {}
): StructuredError {
  return createStructuredError(options.code || ErrorCode.WAIT_TIMEOUT, `${subjectLabel} timed out`, {
    ...(options.details ? { details: options.details } : {}),
    ...(options.suggestion ? { suggestion: options.suggestion } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
}

export function createNotFoundError(
  subjectLabel: string,
  options: Omit<SurfaceErrorOptions, 'code'> = {}
): StructuredError {
  return createStructuredError(ErrorCode.ELEMENT_NOT_FOUND, `${subjectLabel} was not found`, {
    ...(options.details ? { details: options.details } : {}),
    ...(options.suggestion ? { suggestion: options.suggestion } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
}
