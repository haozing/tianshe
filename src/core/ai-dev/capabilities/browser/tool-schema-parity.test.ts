import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS, type PublicBrowserToolName } from './tool-definitions';
import { safeValidateToolParams } from './tool-contracts';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const expectSchemaParity = (
  toolName: PublicBrowserToolName,
  args: Record<string, unknown>,
  expected: 'valid' | 'invalid'
): void => {
  const validator = ajv.compile(BROWSER_TOOLS[toolName].inputSchema);
  const schemaValid = validator(args);
  const runtimeValid = safeValidateToolParams(toolName, args).success;

  if (expected === 'valid') {
    expect(schemaValid, `${toolName} transport schema should accept ${JSON.stringify(args)}`).toBe(true);
    expect(runtimeValid, `${toolName} runtime parser should accept ${JSON.stringify(args)}`).toBe(true);
    return;
  }

  expect(schemaValid, `${toolName} transport schema should reject ${JSON.stringify(args)}`).toBe(false);
  expect(runtimeValid, `${toolName} runtime parser should reject ${JSON.stringify(args)}`).toBe(false);
};

describe('browser tool schema parity', () => {
  it('keeps browser_act transport and runtime validation aligned', () => {
    expectSchemaParity(
      'browser_act',
      {
        action: 'click',
        target: { kind: 'element', selector: 'button[type=submit]' },
        verify: { kind: 'text', text: 'Done' },
      },
      'valid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'type',
        target: { kind: 'element', ref: 'element-1' },
        text: 'airpa',
      },
      'valid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'press',
        target: { kind: 'key', key: 'Enter', modifiers: ['control'] },
      },
      'valid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'click',
        target: { kind: 'text', text: 'Submit', exactMatch: true },
      },
      'valid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'click',
        target: { kind: 'element', selector: 'button', unexpected: true },
      },
      'invalid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'type',
        target: { kind: 'element', selector: 'input[name=q]' },
      },
      'invalid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'press',
        target: { kind: 'key' },
      },
      'invalid'
    );
    expectSchemaParity(
      'browser_act',
      {
        action: 'click',
        target: { kind: 'text', text: 'Submit' },
        extraTopLevel: true,
      },
      'invalid'
    );
  });

  it('rejects unknown fields and invalid wait combinations for canonical browser tools', () => {
    expectSchemaParity(
      'browser_observe',
      {
        url: 'https://example.com',
        wait: { kind: 'element', selector: 'main' },
      },
      'valid'
    );
    expectSchemaParity(
      'browser_observe',
      {
        wait: { kind: 'text', text: 'Ready' },
        waitSelector: 'main',
      },
      'invalid'
    );
    expectSchemaParity(
      'browser_observe',
      {
        wait: { kind: 'element', ref: 'element-1' },
        unexpected: true,
      },
      'invalid'
    );

    expectSchemaParity(
      'browser_wait_for',
      {
        condition: { kind: 'element', ref: 'element-1' },
        timeoutMs: 3000,
      },
      'valid'
    );
    expectSchemaParity('browser_wait_for', {}, 'invalid');
    expectSchemaParity(
      'browser_wait_for',
      {
        condition: { kind: 'element', selector: 'main' },
        unknown: 'x',
      },
      'invalid'
    );

    expectSchemaParity(
      'browser_search',
      {
        query: 'submit button',
        limit: 5,
        exactMatch: false,
      },
      'valid'
    );
    expectSchemaParity(
      'browser_search',
      {
        roleFilter: 'button',
      },
      'invalid'
    );

    expectSchemaParity(
      'browser_debug_state',
      {
        includeConsole: true,
        includeNetwork: true,
        captureMode: 'viewport',
      },
      'valid'
    );
    expectSchemaParity(
      'browser_debug_state',
      {
        includeConsole: true,
        unknown: true,
      },
      'invalid'
    );
  });
});
