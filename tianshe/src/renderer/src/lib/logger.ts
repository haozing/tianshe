import { redactSensitiveText, redactSensitiveValue } from '../../../utils/redaction';

type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RendererLogFields {
  operation?: string;
  outcome?: 'success' | 'failure' | 'blocked' | 'noop';
  [key: string]: unknown;
}

export interface RendererLogger {
  debug: (message: string, fields?: RendererLogFields) => void;
  info: (message: string, fields?: RendererLogFields) => void;
  warn: (message: string, fields?: RendererLogFields) => void;
  error: (message: string, fields?: RendererLogFields) => void;
}

function emitRendererLog(
  context: string,
  level: RendererLogLevel,
  message: string,
  fields?: RendererLogFields
): void {
  const consoleRef = globalThis.console;
  const writer = consoleRef?.[level] ?? consoleRef?.log;
  if (!consoleRef || typeof writer !== 'function') {
    return;
  }

  const safeMessage = `[${context}] ${redactSensitiveText(message)}`;
  if (fields === undefined) {
    writer.call(consoleRef, safeMessage);
    return;
  }

  writer.call(consoleRef, safeMessage, redactSensitiveValue(fields));
}

export function createRendererLogger(context: string): RendererLogger {
  return {
    debug: (message, fields) => emitRendererLog(context, 'debug', message, fields),
    info: (message, fields) => emitRendererLog(context, 'info', message, fields),
    warn: (message, fields) => emitRendererLog(context, 'warn', message, fields),
    error: (message, fields) => emitRendererLog(context, 'error', message, fields),
  };
}
