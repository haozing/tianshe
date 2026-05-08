export function getUnknownErrorMessage(
  error: unknown,
  fallback = 'Unknown error occurred'
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as Record<string, unknown>).message);
  }

  return fallback;
}

export function getUnknownErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }

  if (error && typeof error === 'object' && 'stack' in error) {
    const stack = (error as Record<string, unknown>).stack;
    return typeof stack === 'string' ? stack : undefined;
  }

  return undefined;
}

export function getUnknownErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }

  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as Record<string, unknown>).name;
    return typeof name === 'string' ? name : undefined;
  }

  return undefined;
}

export function getUnknownErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  }

  return undefined;
}

export function toError(error: unknown, fallback = 'Unknown error occurred'): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(getUnknownErrorMessage(error, fallback));
}

export function toOptionalError(
  error: unknown,
  fallback = 'Unknown error occurred'
): Error | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }

  return toError(error, fallback);
}
