import * as koffi from 'koffi';
import type { FFIIsolatedCallRequest, FunctionSignature } from './types';
import { FFI_TYPE_MAP } from './types';

interface WorkerErrorMessage {
  type: 'error';
  message: string;
  code?: string;
  stack?: string;
}

interface WorkerResultMessage {
  type: 'result';
  result: unknown;
}

type WorkerResponseMessage = WorkerErrorMessage | WorkerResultMessage;

function send(message: WorkerResponseMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function mapFFIType(type: string): string {
  return FFI_TYPE_MAP[type] || type;
}

function buildKoffiSignature(signature: FunctionSignature): string[] {
  return signature.args.map((type) => mapFFIType(type));
}

function isRequest(value: unknown): value is FFIIsolatedCallRequest {
  const request = value as Partial<FFIIsolatedCallRequest> | null;
  return Boolean(
    request &&
      typeof request.libPath === 'string' &&
      typeof request.functionName === 'string' &&
      request.signature &&
      Array.isArray(request.signature.args) &&
      typeof request.signature.returns === 'string' &&
      Array.isArray(request.args)
  );
}

function toWorkerError(error: unknown): WorkerErrorMessage {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    return {
      type: 'error',
      message: error.message,
      code: typeof maybeCode === 'string' ? maybeCode : 'CALL_FAILED',
      stack: error.stack,
    };
  }

  return {
    type: 'error',
    message: String(error),
    code: 'CALL_FAILED',
  };
}

process.once('message', (message: unknown) => {
  try {
    if (!isRequest(message)) {
      throw new Error('Invalid isolated FFI request');
    }

    const library = koffi.load(message.libPath);
    const fn = (library as any).func(
      message.functionName,
      buildKoffiSignature(message.signature),
      message.signature.returns
    );
    const result = fn(...message.args);
    send({ type: 'result', result });
  } catch (error: unknown) {
    send(toWorkerError(error));
  } finally {
    setImmediate(() => process.exit(0));
  }
});
