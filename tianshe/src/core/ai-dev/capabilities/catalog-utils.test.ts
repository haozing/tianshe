import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { createStructuredEnvelopeSchema } from './catalog-utils';
import { createStructuredResult } from './result-utils';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const EXAMPLE_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
} as const;

describe('createStructuredSuccessSchema', () => {
  it('accepts successful structured results with a null reasonCode', () => {
    const result = createStructuredResult({
      summary: 'ready',
      data: { id: 'tool-1' },
    });
    const validate = ajv.compile(createStructuredEnvelopeSchema(EXAMPLE_DATA_SCHEMA));

    expect(validate(result.structuredContent), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts successful structured results with a non-null reasonCode', () => {
    const result = createStructuredResult({
      summary: 'ready',
      data: { id: 'tool-1' },
      reasonCode: 'partial_success',
    });
    const validate = ajv.compile(createStructuredEnvelopeSchema(EXAMPLE_DATA_SCHEMA));

    expect(validate(result.structuredContent), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});
