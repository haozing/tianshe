import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ErrorCode,
  RegistryErrorCode,
  createStructuredError,
  type StructuredError,
} from '../types/error-codes';
import { sendStructuredError } from './http-response-mapper';

const ERROR_CODE_STATUS_MAP: Record<string, number> = {
  [ErrorCode.INVALID_PARAMETER]: 400,
  [ErrorCode.MISSING_PARAMETER]: 400,
  [ErrorCode.PARAMETER_TYPE_MISMATCH]: 400,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [RegistryErrorCode.INVALID_PARAMS]: 400,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.DATASET_NOT_FOUND]: 404,
  [RegistryErrorCode.PLUGIN_NOT_FOUND]: 404,
  [RegistryErrorCode.API_NOT_FOUND]: 404,
  [RegistryErrorCode.COMMAND_NOT_FOUND]: 404,
  [ErrorCode.REQUEST_FAILED]: 429,
  [ErrorCode.TIMEOUT]: 408,
  [ErrorCode.WAIT_TIMEOUT]: 408,
};

export type AsyncHandler = (req: Request, res: Response) => Promise<void>;

export const mapErrorStatus = (code: string, fallback = 500): number => {
  return ERROR_CODE_STATUS_MAP[code] ?? fallback;
};

export const mapStructuredErrorStatus = (error: StructuredError, fallback = 500): number => {
  if (error.code === ErrorCode.REQUEST_FAILED && error.context?.reason === 'idempotency_conflict') {
    return 409;
  }
  if (error.context?.reason === 'session_closing' || error.context?.reason === 'invocation_aborted') {
    return 409;
  }
  return mapErrorStatus(error.code, fallback);
};

const isStructuredError = (error: unknown): error is StructuredError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as StructuredError).code === 'string' &&
    typeof (error as StructuredError).message === 'string'
  );
};

const inferErrorCodeFromMessage = (message: string): string => {
  const lower = message.toLowerCase();
  if (lower.includes('not found')) {
    return ErrorCode.NOT_FOUND;
  }
  if (lower.includes('permission') || lower.includes('unauthorized')) {
    return ErrorCode.PERMISSION_DENIED;
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return ErrorCode.TIMEOUT;
  }
  return ErrorCode.OPERATION_FAILED;
};

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');

export const toStructuredError = (error: unknown): StructuredError => {
  if (isStructuredError(error)) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return createStructuredError(ErrorCode.INVALID_PARAMETER, 'Request validation failed', {
      details: formatZodIssues(error),
    });
  }
  if (error instanceof Error) {
    return createStructuredError(inferErrorCodeFromMessage(error.message), error.message);
  }
  return createStructuredError(ErrorCode.OPERATION_FAILED, String(error));
};

interface LoggerLike {
  error(message: string, error?: unknown): void;
}

export const createAsyncHandler =
  (logger: LoggerLike) =>
  (handler: AsyncHandler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error: unknown) {
      logger.error(`REST handler failed: ${req.method} ${req.path}`, error);
      if (res.headersSent) {
        return;
      }
      const structured = toStructuredError(error);
      sendStructuredError(res, structured, mapErrorStatus(structured.code));
    }
  };
