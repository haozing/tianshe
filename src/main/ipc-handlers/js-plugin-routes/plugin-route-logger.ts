import { createLogger } from '../../../core/logger';

const logger = createLogger('JSPluginIPCRoutes');

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

export function logPluginRouteInfo(
  message: string,
  fields: Record<string, unknown> = {}
): void {
  logger.info(message, fields);
}

export function logPluginRouteWarning(
  message: string,
  fields: Record<string, unknown> = {}
): void {
  logger.warn(message, fields);
}

export function logPluginRouteError(
  message: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  logger.error(message, {
    ...fields,
    error: normalizeErrorForLog(error),
  });
}
