import { createLogger } from '../../../core/logger';

const logger = createLogger('DatasetIPCRoutes');

function normalizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { raw: String(error) };
}

export function logDatasetRouteError(
  message: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  logger.error(message, {
    ...fields,
    error: normalizeErrorForLog(error),
  });
}

export function logDatasetRouteWarning(
  message: string,
  fields: Record<string, unknown> = {}
): void {
  logger.warn(message, fields);
}
