import type { BrowserToolName } from '../tool-definitions';
import type { ToolHandler } from './types';
import { consoleDiagnosticsHandlers } from './console-diagnostics';
import { coordinateHandlers } from './coordinates';
import { cookieHandlers } from './cookies';
import { navigationHandlers } from './navigation';
import { networkHandlers } from './network';
import { observationHandlers } from './observation';
import { selectorValidationHandlers } from './selector-validation';
import { textOcrHandlers } from './text-ocr';
import { workflowHandlers } from './workflow';

export * from './navigation';
export * from './observation';
export * from './interaction';
export * from './network';
export * from './cookies';
export * from './coordinates';
export * from './text-ocr';
export * from './console-diagnostics';
export * from './selector-validation';
export * from './workflow';

export const browserHandlers: Record<BrowserToolName, ToolHandler> = {
  ...navigationHandlers,
  ...observationHandlers,
  ...workflowHandlers,
  ...networkHandlers,
  ...cookieHandlers,
  ...coordinateHandlers,
  ...textOcrHandlers,
  ...consoleDiagnosticsHandlers,
  ...selectorValidationHandlers,
} as Record<BrowserToolName, ToolHandler>;
