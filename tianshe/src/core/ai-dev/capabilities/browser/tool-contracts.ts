import { z } from 'zod';
import {
  browserAct,
  browserClickAt,
  browserConsoleGet,
  browserConsoleStart,
  browserCookiesSet,
  browserDebugState,
  browserDragTo,
  browserEvaluate,
  browserFindText,
  browserHoverAt,
  browserNativeKey,
  browserNativeType,
  browserNetworkEntries,
  browserNetworkStart,
  browserObserve,
  browserScreenshot,
  browserScrollAt,
  browserSearch,
  browserSnapshot,
  browserValidateSelector,
  browserWaitFor,
} from './tool-definitions';

export const SCHEMA_BACKED_BROWSER_TOOLS = {
  browser_observe: browserObserve,
  browser_snapshot: browserSnapshot,
  browser_wait_for: browserWaitFor,
  browser_act: browserAct,
  browser_evaluate: browserEvaluate,
  browser_search: browserSearch,
  browser_network_start: browserNetworkStart,
  browser_network_entries: browserNetworkEntries,
  browser_screenshot: browserScreenshot,
  browser_debug_state: browserDebugState,
  browser_cookies_set: browserCookiesSet,
  browser_click_at: browserClickAt,
  browser_scroll_at: browserScrollAt,
  browser_drag_to: browserDragTo,
  browser_hover_at: browserHoverAt,
  browser_native_type: browserNativeType,
  browser_native_key: browserNativeKey,
  browser_find_text: browserFindText,
  browser_console_start: browserConsoleStart,
  browser_console_get: browserConsoleGet,
  browser_validate_selector: browserValidateSelector,
} as const;

export type SchemaBackedBrowserToolName = keyof typeof SCHEMA_BACKED_BROWSER_TOOLS;

type SchemaBackedTool<T extends SchemaBackedBrowserToolName> =
  (typeof SCHEMA_BACKED_BROWSER_TOOLS)[T];

type InferToolSchema<T extends SchemaBackedBrowserToolName> = SchemaBackedTool<T>['schema'];

export class SchemaValidationError extends Error {
  constructor(
    public toolName: string,
    public zodError: z.ZodError
  ) {
    const issues = zodError.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    super(`Parameter validation failed for '${toolName}':\n${issues}`);
    this.name = 'SchemaValidationError';
  }

  get paramName(): string {
    return this.zodError.issues[0]?.path.join('.') || 'unknown';
  }
}

export class ParamValidationError extends Error {
  constructor(
    public paramName: string,
    message: string
  ) {
    super(`Invalid parameter '${paramName}': ${message}`);
    this.name = 'ParamValidationError';
  }
}

export function validateToolParams<T extends SchemaBackedBrowserToolName>(
  toolName: T,
  args: Record<string, unknown>
): z.infer<InferToolSchema<T>> {
  const schema = SCHEMA_BACKED_BROWSER_TOOLS[toolName].schema;
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new SchemaValidationError(toolName, result.error);
  }
  return result.data as z.infer<InferToolSchema<T>>;
}

export function safeValidateToolParams<T extends SchemaBackedBrowserToolName>(
  toolName: T,
  args: Record<string, unknown>
):
  | { success: true; data: z.infer<InferToolSchema<T>> }
  | { success: false; error: z.ZodError } {
  return SCHEMA_BACKED_BROWSER_TOOLS[toolName].schema.safeParse(args) as
    | { success: true; data: z.infer<InferToolSchema<T>> }
    | { success: false; error: z.ZodError };
}

function createParser<T extends SchemaBackedBrowserToolName>(toolName: T) {
  const schema = SCHEMA_BACKED_BROWSER_TOOLS[toolName].schema;
  return (args: Record<string, unknown>): z.infer<InferToolSchema<T>> => {
    const result = schema.safeParse(args);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      throw new ParamValidationError(
        firstIssue?.path.join('.') || 'unknown',
        firstIssue?.message || 'validation failed'
      );
    }
    return result.data as z.infer<InferToolSchema<T>>;
  };
}

export const parseObserveParams = createParser('browser_observe');
export const parseSnapshotParams = createParser('browser_snapshot');
export const parseWaitForParams = createParser('browser_wait_for');
export const parseActParams = createParser('browser_act');
export const parseEvaluateParams = createParser('browser_evaluate');
export const parseSearchParams = createParser('browser_search');
export const parseNetworkStartParams = createParser('browser_network_start');
export const parseNetworkEntriesParams = createParser('browser_network_entries');
export const parseScreenshotParams = createParser('browser_screenshot');
export const parseDebugStateParams = createParser('browser_debug_state');
export const parseCookieSetParams = createParser('browser_cookies_set');
export const parseClickAtParams = createParser('browser_click_at');
export const parseScrollAtParams = createParser('browser_scroll_at');
export const parseDragToParams = createParser('browser_drag_to');
export const parseHoverAtParams = createParser('browser_hover_at');
export const parseNativeTypeParams = createParser('browser_native_type');
export const parseNativeKeyParams = createParser('browser_native_key');
export const parseFindTextParams = createParser('browser_find_text');
export const parseConsoleStartParams = createParser('browser_console_start');
export const parseConsoleGetParams = createParser('browser_console_get');
export const parseValidateSelectorParams = createParser('browser_validate_selector');
