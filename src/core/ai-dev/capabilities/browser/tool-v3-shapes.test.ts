import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  actionTargetV3InputSchema,
  actionTargetV3Schema,
  waitConditionV3InputSchema,
  waitConditionV3Schema,
} from './tool-v3-shapes';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

function expectSchemaAgreement(
  schemaName: 'waitConditionV3' | 'actionTargetV3',
  input: Record<string, unknown>,
  expected: 'valid' | 'invalid'
): void {
  const runtimeValid =
    schemaName === 'waitConditionV3'
      ? waitConditionV3Schema.safeParse(input).success
      : actionTargetV3Schema.safeParse(input).success;
  const transportValid =
    schemaName === 'waitConditionV3'
      ? ajv.compile(waitConditionV3InputSchema)(input)
      : ajv.compile(actionTargetV3InputSchema)(input);

  if (expected === 'valid') {
    expect(runtimeValid).toBe(true);
    expect(transportValid).toBe(true);
    return;
  }

  expect(runtimeValid).toBe(false);
  expect(transportValid).toBe(false);
}

describe('browser v3 shared schema primitives', () => {
  it('accepts nested wait conditions with v3 kinds', () => {
    expectSchemaAgreement(
      'waitConditionV3',
      {
        kind: 'all',
        conditions: [
          { kind: 'element', ref: 'airpa_el:submit', state: 'visible' },
          { kind: 'text', text: 'Dashboard', exactMatch: true },
          { kind: 'url', urlIncludes: '/dashboard' },
        ],
      },
      'valid'
    );
  });

  it('rejects malformed wait conditions', () => {
    expectSchemaAgreement(
      'waitConditionV3',
      {
        kind: 'element',
      },
      'invalid'
    );
  });

  it('accepts structured action targets for text and key actions', () => {
    expectSchemaAgreement(
      'actionTargetV3',
      {
        kind: 'text',
        text: 'Continue',
        strategy: 'auto',
      },
      'valid'
    );
    expectSchemaAgreement(
      'actionTargetV3',
      {
        kind: 'key',
        key: 'Enter',
        modifiers: ['shift'],
      },
      'valid'
    );
  });

  it('rejects malformed element action targets', () => {
    expectSchemaAgreement(
      'actionTargetV3',
      {
        kind: 'element',
      },
      'invalid'
    );
  });
});
