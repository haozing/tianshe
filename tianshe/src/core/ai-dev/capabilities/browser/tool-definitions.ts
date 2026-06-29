import { z } from 'zod';
import { createNoParamTool, createTool } from './tool-factory';
import { optionalBoolean, optionalNumber, optionalString, urlSchema } from './schema-primitives';
import {
  ELEMENT_REF_DESCRIPTION,
  elementActionTargetV3Schema,
  elementActionTargetV3InputSchema,
  keyActionTargetV3Schema,
  keyActionTargetV3InputSchema,
  SELECTOR_SCHEMA_DESCRIPTION,
  textActionTargetV3Schema,
  textActionTargetV3InputSchema,
  textRegionInputSchema,
  textRegionSchema,
  waitConditionV3InputSchema,
  waitConditionV3Schema,
} from './tool-v3-shapes';

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const cloneInputSchema = <T extends Record<string, unknown>>(schema: T): T =>
  JSON.parse(JSON.stringify(schema)) as T;

const createStrictInputSchema = (
  properties: Record<string, unknown>,
  options: {
    required?: string[];
    anyOf?: Record<string, unknown>[];
    oneOf?: Record<string, unknown>[];
    allOf?: Record<string, unknown>[];
  } = {}
) => ({
  type: 'object' as const,
  additionalProperties: false,
  properties,
  ...(options.required?.length ? { required: options.required } : {}),
  ...(options.anyOf?.length ? { anyOf: options.anyOf } : {}),
  ...(options.oneOf?.length ? { oneOf: options.oneOf } : {}),
  ...(options.allOf?.length ? { allOf: options.allOf } : {}),
});

const elementRefSchema = optionalString.describe(
  'Opaque elementRef returned by browser_snapshot/browser_search. Prefer this over selector when available.'
);

const selectorSchemaDescription = SELECTOR_SCHEMA_DESCRIPTION;
const selectorInputSchema = {
  type: 'string',
  description: selectorSchemaDescription,
};
const elementRefInputSchema = {
  type: 'string',
  description: ELEMENT_REF_DESCRIPTION,
};
const screenshotCaptureModeSchema = z
  .enum(['auto', 'viewport', 'full_page'])
  .optional()
  .describe(
    'Screenshot strategy. auto = host-appropriate default, viewport = current viewport only, full_page = full-page capture when supported.'
  );

const textLookupSchema = strictObject({
  text: z.string().min(1).describe('Target text'),
  strategy: z
    .enum(['auto', 'dom', 'ocr'])
    .optional()
    .describe('Lookup strategy. auto = DOM then OCR, dom = DOM only, ocr = OCR only'),
  exactMatch: optionalBoolean.describe('Whether to require an exact text match. Default: false'),
  timeoutMs: optionalNumber.describe('Wait timeout in milliseconds'),
  region: textRegionSchema.optional().describe('Optional search region'),
});

const createWaitConditionInputSchema = (depth = 3): Record<string, unknown> => {
  const properties = {
    selector: {
      ...selectorInputSchema,
      description:
        `${selectorSchemaDescription} Default selector wait mode is attached. Append :visible when visibility is required.`,
    },
    ref: elementRefInputSchema,
    state: {
      type: 'string',
      enum: ['attached', 'visible'],
      description: 'Match mode for selector/ref wait conditions. Default: attached',
    },
    text: { type: 'string', description: 'Text that must appear' },
    textGone: { type: 'string', description: 'Text that must disappear' },
    strategy: {
      type: 'string',
      enum: ['auto', 'dom', 'ocr'],
      description: 'Lookup strategy. auto = DOM then OCR, dom = DOM only, ocr = OCR only',
    },
    exactMatch: {
      type: 'boolean',
      description: 'Whether to require an exact text match. Default: false',
    },
    region: {
      ...textRegionInputSchema,
      description: 'Optional search region',
    },
    urlIncludes: {
      type: 'string',
      description: 'Substring that must appear in the current URL',
    },
  };

  const simpleSchema = createStrictInputSchema(properties, {
    oneOf: [
      { required: ['selector'] },
      { required: ['ref'] },
      { required: ['text'] },
      { required: ['textGone'] },
      { required: ['urlIncludes'] },
    ],
  });

  if (depth <= 0) {
    return simpleSchema;
  }

  const nested = createWaitConditionInputSchema(depth - 1);
  return {
    anyOf: [
      cloneInputSchema(simpleSchema),
      createStrictInputSchema(
        {
          allOf: {
            type: 'array',
            minItems: 1,
            items: cloneInputSchema(nested),
            description: 'All nested wait conditions must match',
          },
        },
        { required: ['allOf'] }
      ),
      createStrictInputSchema(
        {
          anyOf: {
            type: 'array',
            minItems: 1,
            items: cloneInputSchema(nested),
            description: 'Any nested wait condition may match',
          },
        },
        { required: ['anyOf'] }
      ),
    ],
  };
};
const browserObserveBaseSchema = strictObject({
  url: urlSchema.optional().describe('Optional target URL. When omitted, observe the current page.'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .describe('Navigation wait event when url is provided. Default: domcontentloaded'),
  navigationTimeout: optionalNumber.describe('Navigation timeout in milliseconds. Default: 30000'),
  waitTimeoutMs: optionalNumber.describe('Wait timeout in milliseconds. Default: 5000'),
  maxElements: optionalNumber.describe('Maximum number of elements to return. Default: 50'),
  elementsFilter: z
    .enum(['all', 'interactive'])
    .optional()
    .describe('Element filter mode. all = semantic nodes, interactive = actionable nodes'),
});
const browserObserveSchema = browserObserveBaseSchema.extend({
  wait: waitConditionV3Schema.optional().describe('Optional wait condition that must match before snapshotting.'),
});
const browserObserveInputSchema = createStrictInputSchema({
  url: {
    type: 'string',
    description: 'Optional target URL. When omitted, observe the current page.',
  },
  waitUntil: {
    type: 'string',
    enum: ['load', 'domcontentloaded', 'networkidle'],
    description: 'Navigation wait event when url is provided. Default: domcontentloaded',
  },
  navigationTimeout: { type: 'number', description: 'Navigation timeout in milliseconds. Default: 30000' },
  waitTimeoutMs: { type: 'number', description: 'Wait timeout in milliseconds. Default: 5000' },
  maxElements: { type: 'number', description: 'Maximum number of elements to return. Default: 50' },
  elementsFilter: {
    type: 'string',
    enum: ['all', 'interactive'],
    description: 'Element filter mode. all = semantic nodes, interactive = actionable nodes',
  },
  wait: {
    ...waitConditionV3InputSchema,
    description: 'Optional wait condition that must match before snapshotting.',
  },
});
const browserWaitForSchema = strictObject({
  timeoutMs: optionalNumber.describe('Overall timeout in milliseconds. Default: 5000'),
  pollIntervalMs: optionalNumber.describe('Polling interval in milliseconds. Default: 150'),
  condition: waitConditionV3Schema.describe('Wait condition that must match before returning.'),
});
const browserWaitForInputSchema = createStrictInputSchema(
  {
    timeoutMs: { type: 'number', description: 'Overall timeout in milliseconds. Default: 5000' },
    pollIntervalMs: { type: 'number', description: 'Polling interval in milliseconds. Default: 150' },
    condition: {
      ...waitConditionV3InputSchema,
      description: 'Wait condition that must match before returning.',
    },
  },
  {
    required: ['condition'],
  }
);
const browserActClickTargetSchema = z.union([
  elementActionTargetV3Schema,
  textActionTargetV3Schema,
]);
const browserActClickTargetInputSchema = {
  oneOf: [elementActionTargetV3InputSchema, textActionTargetV3InputSchema],
};
const browserActSchema = z.discriminatedUnion('action', [
  strictObject({
    action: z.literal('click').describe('Action to execute'),
    target: browserActClickTargetSchema.describe('Target for the selected action'),
    verify: waitConditionV3Schema.optional().describe('Optional post-action verification condition.'),
    timeoutMs: optionalNumber.describe('Verification timeout in milliseconds. Default: 5000'),
  }),
  strictObject({
    action: z.literal('type').describe('Action to execute'),
    target: elementActionTargetV3Schema.describe('Target for the selected action'),
    text: z.string().describe('Text to type when action=type'),
    clear: optionalBoolean.describe('Clear the field before typing. Default: true'),
    submit: optionalBoolean.describe('Press Enter after typing when action=type. Default: false'),
    verify: waitConditionV3Schema.optional().describe('Optional post-action verification condition.'),
    timeoutMs: optionalNumber.describe('Verification timeout in milliseconds. Default: 5000'),
  }),
  strictObject({
    action: z.literal('press').describe('Action to execute'),
    target: keyActionTargetV3Schema.describe('Target for the selected action'),
    verify: waitConditionV3Schema.optional().describe('Optional post-action verification condition.'),
    timeoutMs: optionalNumber.describe('Verification timeout in milliseconds. Default: 5000'),
  }),
]);
const browserActInputSchema = {
  oneOf: [
    createStrictInputSchema(
      {
        action: { type: 'string', enum: ['click'], description: 'Action to execute' },
        target: browserActClickTargetInputSchema,
        verify: {
          ...waitConditionV3InputSchema,
          description: 'Optional post-action verification condition.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Verification timeout in milliseconds. Default: 5000',
        },
      },
      { required: ['action', 'target'] }
    ),
    createStrictInputSchema(
      {
        action: { type: 'string', enum: ['type'], description: 'Action to execute' },
        target: elementActionTargetV3InputSchema,
        text: { type: 'string', description: 'Text to type when action=type' },
        clear: { type: 'boolean', description: 'Clear the field before typing. Default: true' },
        submit: { type: 'boolean', description: 'Press Enter after typing when action=type. Default: false' },
        verify: {
          ...waitConditionV3InputSchema,
          description: 'Optional post-action verification condition.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Verification timeout in milliseconds. Default: 5000',
        },
      },
      { required: ['action', 'target', 'text'] }
    ),
    createStrictInputSchema(
      {
        action: { type: 'string', enum: ['press'], description: 'Action to execute' },
        target: keyActionTargetV3InputSchema,
        verify: {
          ...waitConditionV3InputSchema,
          description: 'Optional post-action verification condition.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Verification timeout in milliseconds. Default: 5000',
        },
      },
      { required: ['action', 'target'] }
    ),
  ],
};
const browserValidateSelectorInputSchema = createStrictInputSchema(
  {
    selector: selectorInputSchema,
    ref: elementRefInputSchema,
    expectUnique: {
      type: 'boolean',
      description: 'Whether a unique match is expected. Default: true',
    },
  },
  {
    anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
  }
);
export const browserSnapshot = createTool(
  'browser_snapshot',
  'Capture a page snapshot with semantic elements, optional summary, network data, and console data',
  strictObject({
    includeSummary: optionalBoolean.describe('Include semantic page summary. Default: true'),
    includeNetwork: z
      .union([z.boolean(), z.literal('smart')])
      .optional()
      .describe('Include network info. true = all, smart = API-focused summary, false = none'),
    includeConsole: optionalBoolean.describe('Include captured console messages. Default: false'),
    maxElements: optionalNumber.describe('Maximum number of elements to return. Default: 50'),
    elementsFilter: z
      .enum(['all', 'interactive'])
      .optional()
      .describe('Element filter mode. all = semantic nodes, interactive = actionable nodes'),
  })
);

export const browserObserve = createTool(
  'browser_observe',
  'Optionally navigate, optionally wait for one condition, then capture a page snapshot in one step',
  browserObserveSchema,
  { inputSchemaOverride: browserObserveInputSchema }
);

export const browserWaitFor = createTool(
  'browser_wait_for',
  'Wait for a structured condition before continuing',
  browserWaitForSchema,
  { inputSchemaOverride: browserWaitForInputSchema }
);

export const browserAct = createTool(
  'browser_act',
  'Perform one high-level browser action with a structured target and optional verification',
  browserActSchema,
  { inputSchemaOverride: browserActInputSchema }
);

export const browserEvaluate = createTool(
  'browser_evaluate',
  'Execute JavaScript on the current page',
  strictObject({
    script: z.string().min(1).describe('JavaScript source code to execute'),
  })
);

export const browserSearch = createTool(
  'browser_search',
  'Search for semantic page elements by keyword',
  strictObject({
    query: z.string().min(1).describe('Search query'),
    roleFilter: optionalString.describe('Optional role filter, for example button, link, or textbox'),
    limit: optionalNumber.describe('Maximum number of results to return. Default: 10'),
    exactMatch: optionalBoolean.describe('Whether to require an exact match. Default: false'),
  })
);

export const browserScreenshot = createTool(
  'browser_screenshot',
  'Capture a page or element screenshot',
  strictObject({
    fullPage: optionalBoolean.describe(
      'Deprecated alias for captureMode="full_page". Prefer captureMode.'
    ),
    captureMode: screenshotCaptureModeSchema,
    selector: optionalString.describe(selectorSchemaDescription),
    ref: elementRefSchema,
    format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default: png'),
    quality: z.number().min(0).max(100).optional().describe('JPEG quality from 0 to 100'),
  })
);

export const browserDebugState = createTool(
  'browser_debug_state',
  'Collect a compact debug bundle with snapshot, screenshot, console preview, and network summary',
  strictObject({
    includeScreenshot: optionalBoolean.describe('Include a screenshot. Default: true'),
    includeConsole: optionalBoolean.describe('Include console preview. Default: true'),
    includeNetwork: optionalBoolean.describe('Include network summary. Default: true'),
    captureMode: screenshotCaptureModeSchema,
    format: z.enum(['png', 'jpeg']).optional().describe('Screenshot image format. Default: png'),
    quality: z.number().min(0).max(100).optional().describe('JPEG quality from 0 to 100'),
    elementsFilter: z
      .enum(['all', 'interactive'])
      .optional()
      .describe('Snapshot element filter mode. Default: interactive'),
    maxElements: optionalNumber.describe('Maximum number of snapshot elements. Default: 25'),
    consoleLimit: optionalNumber.describe('Maximum number of console messages to preview. Default: 10'),
  })
);

export const browserNetworkStart = createTool(
  'browser_network_start',
  'Start network capture',
  strictObject({
    urlFilter: optionalString.describe('Optional URL pattern filter'),
    captureBody: optionalBoolean.describe('Capture request and response bodies when available'),
    maxEntries: optionalNumber.describe('Maximum number of captured entries to retain'),
    clearExisting: optionalBoolean.describe('Clear previous capture state before starting'),
  })
);

export const browserNetworkStop = createNoParamTool('browser_network_stop', 'Stop network capture');

export const browserNetworkEntries = createTool(
  'browser_network_entries',
  'Read captured network entries',
  strictObject({
    type: z
      .enum(['all', 'document', 'api', 'static', 'media', 'other'])
      .optional()
      .describe('Resource type filter'),
    method: optionalString.describe('HTTP method filter'),
    status: z.union([z.number(), z.array(z.number())]).optional().describe('HTTP status filter'),
    minDuration: optionalNumber.describe('Minimum request duration in milliseconds'),
    urlPattern: optionalString.describe('URL pattern filter'),
  })
);

export const browserNetworkSummary = createNoParamTool(
  'browser_network_summary',
  'Read a summary of captured network activity'
);

export const browserCookiesGet = createNoParamTool('browser_cookies_get', 'Read current cookies');

export const browserCookiesSet = createTool(
  'browser_cookies_set',
  'Set a cookie',
  strictObject({
    name: z.string().min(1).describe('Cookie name'),
    value: z.string().describe('Cookie value'),
    domain: optionalString.describe('Cookie domain'),
    path: optionalString.describe('Cookie path'),
  })
);

export const browserCookiesClear = createNoParamTool('browser_cookies_clear', 'Clear all cookies');

export const browserBack = createNoParamTool('browser_back', 'Navigate back');
export const browserForward = createNoParamTool('browser_forward', 'Navigate forward');
export const browserReload = createNoParamTool('browser_reload', 'Reload the current page');
export const browserGetUrl = createNoParamTool('browser_get_url', 'Get the current page URL');
export const browserGetTitle = createNoParamTool('browser_get_title', 'Get the current page title');

export const browserClickAt = createTool(
  'browser_click_at',
  'Click at normalized viewport coordinates',
  strictObject({
    x: z.number().min(0).max(100).describe('X coordinate from 0 to 100'),
    y: z.number().min(0).max(100).describe('Y coordinate from 0 to 100'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default: left'),
    clickCount: z.number().min(1).max(3).optional().describe('Click count. 2 means double click'),
  })
);

export const browserScrollAt = createTool(
  'browser_scroll_at',
  'Scroll at normalized viewport coordinates',
  strictObject({
    x: z.number().min(0).max(100).describe('X coordinate from 0 to 100'),
    y: z.number().min(0).max(100).describe('Y coordinate from 0 to 100'),
    deltaY: z.number().describe('Vertical scroll delta in pixels'),
    deltaX: z.number().optional().describe('Horizontal scroll delta in pixels'),
    smooth: optionalBoolean.describe('Use smooth scrolling. Default: false'),
  })
);

export const browserDragTo = createTool(
  'browser_drag_to',
  'Drag between two normalized viewport coordinates',
  strictObject({
    fromX: z.number().min(0).max(100).describe('Start X coordinate from 0 to 100'),
    fromY: z.number().min(0).max(100).describe('Start Y coordinate from 0 to 100'),
    toX: z.number().min(0).max(100).describe('Target X coordinate from 0 to 100'),
    toY: z.number().min(0).max(100).describe('Target Y coordinate from 0 to 100'),
    steps: optionalNumber.describe('Drag step count. Higher values are smoother'),
  })
);

export const browserHoverAt = createTool(
  'browser_hover_at',
  'Move the mouse to normalized viewport coordinates',
  strictObject({
    x: z.number().min(0).max(100).describe('X coordinate from 0 to 100'),
    y: z.number().min(0).max(100).describe('Y coordinate from 0 to 100'),
  })
);

export const browserNativeType = createTool(
  'browser_native_type',
  'Send native keyboard typing without relying on focused selectors',
  strictObject({
    text: z.string().describe('Text to type'),
    delay: optionalNumber.describe('Delay between characters in milliseconds. Default: 50'),
  })
);

export const browserNativeKey = createTool(
  'browser_native_key',
  'Send a native keyboard key or key chord',
  strictObject({
    key: z.string().describe('Key name, for example Enter, Tab, Escape, ArrowDown, a, or A'),
    modifiers: z
      .array(z.enum(['shift', 'control', 'alt', 'meta']))
      .optional()
      .describe('Optional modifier keys'),
  })
);

export const browserFindText = createTool(
  'browser_find_text',
  'Find text bounds via DOM/OCR text lookup',
  textLookupSchema
);

export const browserConsoleStart = createTool(
  'browser_console_start',
  'Start console capture',
  strictObject({
    level: z
      .enum(['all', 'error', 'warning', 'info', 'verbose'])
      .optional()
      .describe('Console capture level. Default: all'),
  })
);

export const browserConsoleStop = createNoParamTool('browser_console_stop', 'Stop console capture');

export const browserConsoleGet = createTool(
  'browser_console_get',
  'Read captured console messages',
  strictObject({
    level: z
      .enum(['all', 'error', 'warning', 'info', 'verbose'])
      .optional()
      .describe('Console level filter. Default: all'),
    limit: optionalNumber.describe('Maximum number of messages to return. Default: 100'),
    since: optionalNumber.describe('Only return messages after this timestamp in milliseconds'),
  })
);

export const browserConsoleClear = createNoParamTool('browser_console_clear', 'Clear captured console messages');

export const browserValidateSelector = createTool(
  'browser_validate_selector',
  'Validate a selector or elementRef against the current page',
  strictObject({
      selector: optionalString.describe(selectorSchemaDescription),
      ref: elementRefSchema,
      expectUnique: optionalBoolean.describe('Whether a unique match is expected. Default: true'),
    })
    .refine((value) => Boolean(value.selector || value.ref), 'selector or ref is required'),
  { inputSchemaOverride: browserValidateSelectorInputSchema }
);

export const PUBLIC_BROWSER_CORE_TOOLS = {
  browser_observe: browserObserve,
  browser_snapshot: browserSnapshot,
  browser_search: browserSearch,
  browser_wait_for: browserWaitFor,
  browser_act: browserAct,
} as const;

export const PUBLIC_BROWSER_OPTIONAL_TOOLS = {
  browser_debug_state: browserDebugState,
} as const;

export const BROWSER_TOOLS = {
  ...PUBLIC_BROWSER_CORE_TOOLS,
  ...PUBLIC_BROWSER_OPTIONAL_TOOLS,
} as const;

export const INTERNAL_ONLY_BROWSER_TOOLS = {
  browser_evaluate: browserEvaluate,
  browser_screenshot: browserScreenshot,
  browser_network_start: browserNetworkStart,
  browser_network_stop: browserNetworkStop,
  browser_network_entries: browserNetworkEntries,
  browser_network_summary: browserNetworkSummary,
  browser_cookies_get: browserCookiesGet,
  browser_cookies_set: browserCookiesSet,
  browser_cookies_clear: browserCookiesClear,
  browser_back: browserBack,
  browser_forward: browserForward,
  browser_reload: browserReload,
  browser_get_url: browserGetUrl,
  browser_get_title: browserGetTitle,
  browser_click_at: browserClickAt,
  browser_scroll_at: browserScrollAt,
  browser_drag_to: browserDragTo,
  browser_hover_at: browserHoverAt,
  browser_native_type: browserNativeType,
  browser_native_key: browserNativeKey,
  browser_find_text: browserFindText,
  browser_console_start: browserConsoleStart,
  browser_console_stop: browserConsoleStop,
  browser_console_get: browserConsoleGet,
  browser_console_clear: browserConsoleClear,
  browser_validate_selector: browserValidateSelector,
} as const;

export const ALL_TOOLS = {
  ...BROWSER_TOOLS,
  ...INTERNAL_ONLY_BROWSER_TOOLS,
} as const;

export type PublicBrowserToolName = keyof typeof BROWSER_TOOLS;
export type BrowserToolName = keyof typeof ALL_TOOLS;
export type ToolName = keyof typeof ALL_TOOLS;
