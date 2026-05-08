import { getUnknownErrorMessage } from '../../../utils/error-message';
import { redactSensitiveText } from '../../../utils/redaction';
import { IpcError, type IpcErrorCode } from '../errors';

export interface DatasetRouteErrorResult {
  success: false;
  error: string;
  code: IpcErrorCode;
}

const DATASET_ERROR_CODE_PATTERNS: Array<{ pattern: RegExp; code: IpcErrorCode }> = [
  { pattern: /\b(not found|no such|does not exist)\b|不存在/i, code: 'NOT_FOUND' },
  { pattern: /\b(already exists|duplicate)\b|已存在/i, code: 'ALREADY_EXISTS' },
  { pattern: /\b(permission denied|access denied|eacces|eperm)\b/i, code: 'PERMISSION_DENIED' },
  { pattern: /\b(resource busy|busy|locked|ebusy)\b/i, code: 'RESOURCE_BUSY' },
  { pattern: /\b(timeout|timed out)\b/i, code: 'TIMEOUT' },
  {
    pattern:
      /\b(base64|invalid|required|unsupported|unknown column|unknown field|missing|empty)\b|无效|非法|不支持/i,
    code: 'INVALID_INPUT',
  },
];

export function inferDatasetRouteErrorCode(
  message: string,
  fallbackCode: IpcErrorCode = 'INTERNAL_ERROR'
): IpcErrorCode {
  return (
    DATASET_ERROR_CODE_PATTERNS.find(({ pattern }) => pattern.test(message))?.code || fallbackCode
  );
}

export function createDatasetRouteErrorResult(
  error: unknown,
  fallbackCode: IpcErrorCode = 'INTERNAL_ERROR'
): DatasetRouteErrorResult {
  if (error instanceof IpcError) {
    return {
      success: false,
      error: redactSensitiveText(error.message),
      code: error.code,
    };
  }

  const message = getUnknownErrorMessage(error);
  return {
    success: false,
    error: redactSensitiveText(message),
    code: inferDatasetRouteErrorCode(message, fallbackCode),
  };
}
