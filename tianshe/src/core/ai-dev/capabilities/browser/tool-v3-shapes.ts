import { z } from 'zod';

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const cloneInputSchema = <T extends Record<string, unknown>>(schema: T): T =>
  JSON.parse(JSON.stringify(schema)) as T;

const createStrictInputSchema = (
  properties: Record<string, unknown>,
  options: {
    required?: string[];
    anyOf?: Record<string, unknown>[];
    oneOf?: Record<string, unknown>[];
  } = {}
) => ({
  type: 'object' as const,
  additionalProperties: false,
  properties,
  ...(options.required?.length ? { required: options.required } : {}),
  ...(options.anyOf?.length ? { anyOf: options.anyOf } : {}),
  ...(options.oneOf?.length ? { oneOf: options.oneOf } : {}),
});

export const SELECTOR_SCHEMA_DESCRIPTION =
  'Airpa selector syntax. Supports CSS plus :has-text("...") and :visible.';
export const ELEMENT_REF_DESCRIPTION =
  'Opaque elementRef returned by browser_snapshot/browser_search. Prefer this over selector when available.';

export const textRegionSchema = strictObject({
  x: z.number().describe('Region origin X'),
  y: z.number().describe('Region origin Y'),
  width: z.number().positive().describe('Region width'),
  height: z.number().positive().describe('Region height'),
  space: z.enum(['normalized', 'viewport']).optional().describe('Coordinate space. Default: normalized'),
});

export const textRegionInputSchema = createStrictInputSchema(
  {
    x: { type: 'number', description: 'Region origin X' },
    y: { type: 'number', description: 'Region origin Y' },
    width: { type: 'number', exclusiveMinimum: 0, description: 'Region width' },
    height: { type: 'number', exclusiveMinimum: 0, description: 'Region height' },
    space: {
      type: 'string',
      enum: ['normalized', 'viewport'],
      description: 'Coordinate space. Default: normalized',
    },
  },
  { required: ['x', 'y', 'width', 'height'] }
);

export type TextRegionV3 = z.infer<typeof textRegionSchema>;

export const elementWaitConditionV3Schema = strictObject({
  kind: z.literal('element'),
  selector: z.string().optional().describe(SELECTOR_SCHEMA_DESCRIPTION),
  ref: z.string().optional().describe(ELEMENT_REF_DESCRIPTION),
  state: z
    .enum(['attached', 'visible'])
    .optional()
    .describe('Match mode for kind=element. Default: attached'),
}).refine((value) => Boolean(value.selector || value.ref), {
  message: 'selector or ref is required',
});

const textWaitConditionBaseSchema = strictObject({
  text: z.string().min(1).describe('Target text'),
  strategy: z
    .enum(['auto', 'dom', 'ocr'])
    .optional()
    .describe('Lookup strategy. auto = DOM then OCR, dom = DOM only, ocr = OCR only'),
  exactMatch: z.boolean().optional().describe('Whether to require an exact text match. Default: false'),
  region: textRegionSchema.optional().describe('Optional search region'),
});

export const textWaitConditionV3Schema = textWaitConditionBaseSchema.extend({
  kind: z.literal('text'),
});

export const textAbsentWaitConditionV3Schema = textWaitConditionBaseSchema.extend({
  kind: z.literal('text_absent'),
});

export const urlWaitConditionV3Schema = strictObject({
  kind: z.literal('url'),
  urlIncludes: z.string().min(1).describe('Substring that must appear in the current URL'),
});

export const waitConditionV3Schema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    elementWaitConditionV3Schema,
    textWaitConditionV3Schema,
    textAbsentWaitConditionV3Schema,
    urlWaitConditionV3Schema,
    strictObject({
      kind: z.literal('all'),
      conditions: z.array(waitConditionV3Schema).min(1).describe('All nested wait conditions must match'),
    }),
    strictObject({
      kind: z.literal('any'),
      conditions: z.array(waitConditionV3Schema).min(1).describe('Any nested wait condition may match'),
    }),
  ])
);

const createWaitConditionV3InputSchema = (depth = 3): Record<string, unknown> => {
  const nested =
    depth <= 0
      ? {
          oneOf: [
            createStrictInputSchema(
              {
                kind: { type: 'string', enum: ['element'], description: 'Wait condition kind' },
                selector: {
                  type: 'string',
                  description: SELECTOR_SCHEMA_DESCRIPTION,
                },
                ref: {
                  type: 'string',
                  description: ELEMENT_REF_DESCRIPTION,
                },
                state: {
                  type: 'string',
                  enum: ['attached', 'visible'],
                  description: 'Match mode for kind=element. Default: attached',
                },
              },
              {
                required: ['kind'],
                anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
              }
            ),
            createStrictInputSchema(
              {
                kind: { type: 'string', enum: ['text'], description: 'Wait condition kind' },
                text: { type: 'string', minLength: 1, description: 'Target text' },
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
              },
              { required: ['kind', 'text'] }
            ),
            createStrictInputSchema(
              {
                kind: { type: 'string', enum: ['text_absent'], description: 'Wait condition kind' },
                text: { type: 'string', minLength: 1, description: 'Target text' },
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
              },
              { required: ['kind', 'text'] }
            ),
            createStrictInputSchema(
              {
                kind: { type: 'string', enum: ['url'], description: 'Wait condition kind' },
                urlIncludes: {
                  type: 'string',
                  minLength: 1,
                  description: 'Substring that must appear in the current URL',
                },
              },
              { required: ['kind', 'urlIncludes'] }
            ),
          ],
        }
      : createWaitConditionV3InputSchema(depth - 1);
  return {
    oneOf: [
      createStrictInputSchema(
        {
          kind: { type: 'string', enum: ['element'], description: 'Wait condition kind' },
          selector: {
            type: 'string',
            description: SELECTOR_SCHEMA_DESCRIPTION,
          },
          ref: {
            type: 'string',
            description: ELEMENT_REF_DESCRIPTION,
          },
          state: {
            type: 'string',
            enum: ['attached', 'visible'],
            description: 'Match mode for kind=element. Default: attached',
          },
        },
        {
          required: ['kind'],
          anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
        }
      ),
      createStrictInputSchema(
        {
          kind: { type: 'string', enum: ['text'], description: 'Wait condition kind' },
          text: { type: 'string', minLength: 1, description: 'Target text' },
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
        },
        { required: ['kind', 'text'] }
      ),
      createStrictInputSchema(
        {
          kind: { type: 'string', enum: ['text_absent'], description: 'Wait condition kind' },
          text: { type: 'string', minLength: 1, description: 'Target text' },
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
        },
        { required: ['kind', 'text'] }
      ),
      createStrictInputSchema(
        {
          kind: { type: 'string', enum: ['url'], description: 'Wait condition kind' },
          urlIncludes: {
            type: 'string',
            minLength: 1,
            description: 'Substring that must appear in the current URL',
          },
        },
        { required: ['kind', 'urlIncludes'] }
      ),
      createStrictInputSchema(
        {
          kind: { type: 'string', enum: ['all'], description: 'Wait condition kind' },
          conditions: {
            type: 'array',
            minItems: 1,
            items: cloneInputSchema(nested),
            description: 'All nested wait conditions must match',
          },
        },
        { required: ['kind', 'conditions'] }
      ),
      createStrictInputSchema(
            {
              kind: { type: 'string', enum: ['any'], description: 'Wait condition kind' },
              conditions: {
                type: 'array',
                minItems: 1,
                items: cloneInputSchema(nested),
                description: 'Any nested wait condition may match',
              },
            },
            { required: ['kind', 'conditions'] }
          ),
    ],
  };
};

export const waitConditionV3InputSchema = createWaitConditionV3InputSchema();

export type WaitConditionV3 = z.infer<typeof waitConditionV3Schema>;

export const elementActionTargetV3Schema = strictObject({
  kind: z.literal('element'),
  selector: z.string().optional().describe(SELECTOR_SCHEMA_DESCRIPTION),
  ref: z.string().optional().describe(ELEMENT_REF_DESCRIPTION),
}).refine((value) => Boolean(value.selector || value.ref), {
  message: 'selector or ref is required',
});

export const textActionTargetV3Schema = strictObject({
  kind: z.literal('text'),
  text: z.string().min(1).describe('Target text'),
  strategy: z
    .enum(['auto', 'dom', 'ocr'])
    .optional()
    .describe('Lookup strategy. auto = DOM then OCR, dom = DOM only, ocr = OCR only'),
  exactMatch: z.boolean().optional().describe('Whether to require an exact text match. Default: false'),
  region: textRegionSchema.optional().describe('Optional search region'),
});

export const keyActionTargetV3Schema = strictObject({
  kind: z.literal('key'),
  key: z.string().min(1).describe('Key name for kind=key'),
  modifiers: z
    .array(z.enum(['shift', 'control', 'alt', 'meta']))
    .optional()
    .describe('Optional modifier keys for kind=key'),
});

export const actionTargetV3Schema = z.union([
  elementActionTargetV3Schema,
  textActionTargetV3Schema,
  keyActionTargetV3Schema,
]);

export type ActionTargetV3 = z.infer<typeof actionTargetV3Schema>;

export const elementActionTargetV3InputSchema = createStrictInputSchema(
  {
    kind: { type: 'string', enum: ['element'], description: 'Target kind' },
    selector: { type: 'string', description: SELECTOR_SCHEMA_DESCRIPTION },
    ref: { type: 'string', description: ELEMENT_REF_DESCRIPTION },
  },
  {
    required: ['kind'],
    anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
  }
);

export const textActionTargetV3InputSchema = createStrictInputSchema(
  {
    kind: { type: 'string', enum: ['text'], description: 'Target kind' },
    text: { type: 'string', minLength: 1, description: 'Target text' },
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
  },
  { required: ['kind', 'text'] }
);

export const keyActionTargetV3InputSchema = createStrictInputSchema(
  {
    kind: { type: 'string', enum: ['key'], description: 'Target kind' },
    key: { type: 'string', minLength: 1, description: 'Key name for kind=key' },
    modifiers: {
      type: 'array',
      items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] },
      description: 'Optional modifier keys for kind=key',
    },
  },
  { required: ['kind', 'key'] }
);

export const actionTargetV3InputSchema = {
  oneOf: [
    elementActionTargetV3InputSchema,
    textActionTargetV3InputSchema,
    keyActionTargetV3InputSchema,
  ],
};
