import { describe, expect, it } from 'vitest';
import type { OrchestrationCapabilityDefinition } from '../orchestration/types';
import {
  listCanonicalAssistantFlowCapabilityNames,
  listCanonicalPublicCapabilityNames,
} from './assistant-surface-manifest';

const createCapability = (
  name: string,
  options: {
    publicMcp?: boolean;
    surfaceTier?: 'canonical' | 'advanced' | 'legacy';
    gettingStartedOrder?: number;
    sessionReuseOrder?: number;
    pageDebugOrder?: number;
  } = {}
): OrchestrationCapabilityDefinition => ({
  name,
  title: name,
  description: `${name} description`,
  version: '1.0.0',
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  idempotent: true,
  retryPolicy: {
    retryable: true,
    maxAttempts: 1,
  },
  requiredScopes: ['browser.read'],
  assistantSurface: {
    ...(typeof options.publicMcp === 'boolean' ? { publicMcp: options.publicMcp } : {}),
    ...(options.surfaceTier ? { surfaceTier: options.surfaceTier } : {}),
    ...(options.gettingStartedOrder
      ? { gettingStartedOrder: options.gettingStartedOrder }
      : {}),
    ...(options.sessionReuseOrder ? { sessionReuseOrder: options.sessionReuseOrder } : {}),
    ...(options.pageDebugOrder ? { pageDebugOrder: options.pageDebugOrder } : {}),
  },
});

describe('assistant surface manifest', () => {
  const capabilities = [
    createCapability('session_prepare', {
      publicMcp: true,
      surfaceTier: 'canonical',
      gettingStartedOrder: 30,
      sessionReuseOrder: 30,
    }),
    createCapability('browser_snapshot', {
      publicMcp: true,
      surfaceTier: 'canonical',
      gettingStartedOrder: 50,
      pageDebugOrder: 30,
    }),
    createCapability('legacy_browser_tool', {
      publicMcp: false,
      surfaceTier: 'legacy',
      pageDebugOrder: 60,
    }),
    createCapability('profile_get', {
      publicMcp: false,
      surfaceTier: 'advanced',
    }),
  ];

  it('lists canonical public capabilities without leaking full-only compatibility tools', () => {
    expect(listCanonicalPublicCapabilityNames(capabilities)).toEqual([
      'session_prepare',
      'browser_snapshot',
    ]);
  });

  it('selects canonical assistant flows from the canonical public helper', () => {
    expect(listCanonicalAssistantFlowCapabilityNames('getting_started', capabilities)).toEqual([
      'session_prepare',
      'browser_snapshot',
    ]);
    expect(listCanonicalAssistantFlowCapabilityNames('page_debug', capabilities)).toEqual([
      'browser_snapshot',
    ]);
  });
});
