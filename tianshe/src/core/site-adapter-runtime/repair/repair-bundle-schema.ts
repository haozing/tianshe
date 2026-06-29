import Ajv from 'ajv';

export const SITE_ADAPTER_REPAIR_BUNDLE_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'adapterId',
    'fixtureName',
    'sideEffectLevel',
    'repairEvidence',
    'diagnostics',
    'verifierResults',
    'actionTrace',
    'transitions',
  ],
  properties: {
    adapterId: { type: 'string', minLength: 1 },
    fixtureName: { type: 'string', minLength: 1 },
    sideEffectLevel: { enum: ['read-only', 'low', 'high'] },
    repairEvidence: {
      type: 'object',
      additionalProperties: true,
      required: [
        'adapterId',
        'fixtureName',
        'selectorDiagnostics',
        'fieldDiagnostics',
        'fixture',
        'expected',
        'before',
        'after',
        'changedFiles',
        'repairScopeDecisions',
      ],
      properties: {
        adapterId: { type: 'string', minLength: 1 },
        fixtureName: { type: 'string', minLength: 1 },
        selectorDiagnostics: { type: 'array', minItems: 1, items: { $ref: '#/$defs/diagnostic' } },
        fieldDiagnostics: { type: 'array', minItems: 1, items: { $ref: '#/$defs/diagnostic' } },
        fixture: { type: 'object', additionalProperties: true },
        expected: { type: 'object', additionalProperties: true },
        before: { type: 'object', additionalProperties: true },
        after: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
        changedFiles: { type: 'array', items: { type: 'string' } },
        repairScopeDecisions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    diagnostics: { type: 'array', minItems: 1, items: { $ref: '#/$defs/diagnostic' } },
    verifierResults: { type: 'array', items: { type: 'object', additionalProperties: true } },
    actionTrace: { type: 'array', items: { type: 'object', additionalProperties: true } },
    transitions: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  $defs: {
    diagnostic: {
      type: 'object',
      additionalProperties: true,
      required: ['path', 'ok', 'expected', 'actual'],
      properties: {
        path: { type: 'string', minLength: 1 },
        ok: { type: 'boolean' },
        expected: {},
        actual: {},
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRepairBundleData = ajv.compile(SITE_ADAPTER_REPAIR_BUNDLE_DATA_SCHEMA);

export function assertSiteAdapterRepairBundleData(value: unknown): asserts value is Record<string, unknown> {
  if (validateRepairBundleData(value)) {
    return;
  }

  throw new Error(
    `Site adapter repair bundle data failed schema validation: ${ajv.errorsText(validateRepairBundleData.errors)}`
  );
}
