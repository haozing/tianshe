import { describe, expect, it } from 'vitest';
import type { OrchestrationCapabilityDefinition } from '../core/ai-dev/orchestration';
import { shouldPreAcquireBrowserForCapability } from './mcp-http-adapter';

function definition(
  patch: Partial<OrchestrationCapabilityDefinition>
): OrchestrationCapabilityDefinition {
  return {
    name: 'browser_snapshot',
    description: 'test',
    version: '1.0.0',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    requiredScopes: ['browser.read'],
    requires: [],
    ...patch,
  };
}

describe('mcp http adapter browser pre-acquire policy', () => {
  it('pre-acquires browsers for generic browser capabilities', () => {
    expect(
      shouldPreAcquireBrowserForCapability(
        definition({
          name: 'browser_snapshot',
          requires: ['browser', 'sessionBrowser'],
        })
      )
    ).toBe(true);
  });

  it('lets business site capabilities acquire after handler-level session preparation', () => {
    expect(
      shouldPreAcquireBrowserForCapability(
        definition({
          name: 'books_to_scrape.extract_product',
          requires: ['browser', 'sessionBrowser'],
        })
      )
    ).toBe(false);
  });
});
