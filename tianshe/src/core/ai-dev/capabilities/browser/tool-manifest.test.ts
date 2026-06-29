import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  BROWSER_TOOLS,
  PUBLIC_BROWSER_CORE_TOOLS,
  PUBLIC_BROWSER_OPTIONAL_TOOLS,
} from './tool-definitions';
import {
  BROWSER_TOOL_MANIFEST,
  INTERNAL_BROWSER_TOOL_NAMES,
  PUBLIC_BROWSER_TOOL_MANIFEST,
} from './tool-manifest';
import { BROWSER_CAPABILITY_NAMES } from '../../../../types/browser-interface';

describe('browser tool manifest', () => {
  it('covers every browser tool exactly once', () => {
    expect(Object.keys(BROWSER_TOOL_MANIFEST).sort()).toEqual(Object.keys(ALL_TOOLS).sort());
  });

  it('keeps the public browser surface aligned with the canonical tool list', () => {
    expect(Object.keys(PUBLIC_BROWSER_TOOL_MANIFEST).sort()).toEqual(
      Object.keys(BROWSER_TOOLS).sort()
    );
    expect(
      INTERNAL_BROWSER_TOOL_NAMES.filter((toolName) => Object.hasOwn(BROWSER_TOOLS, toolName))
    ).toEqual([]);
  });

  it('keeps cookie value tools off the public MCP surface', () => {
    expect(BROWSER_TOOL_MANIFEST.browser_cookies_get.publicMcp).toBe(false);
    expect(BROWSER_TOOL_MANIFEST.browser_cookies_set.publicMcp).toBe(false);
    expect(BROWSER_TOOL_MANIFEST.browser_cookies_clear.publicMcp).toBe(false);
    expect(PUBLIC_BROWSER_TOOL_MANIFEST).not.toHaveProperty('browser_cookies_get');
    expect(PUBLIC_BROWSER_TOOL_MANIFEST).not.toHaveProperty('browser_cookies_set');
    expect(PUBLIC_BROWSER_TOOL_MANIFEST).not.toHaveProperty('browser_cookies_clear');
  });

  it('keeps canonical core and optional browser groups disjoint while covering the public surface', () => {
    const coreNames = Object.keys(PUBLIC_BROWSER_CORE_TOOLS).sort();
    const optionalNames = Object.keys(PUBLIC_BROWSER_OPTIONAL_TOOLS).sort();
    expect(coreNames.filter((name) => optionalNames.includes(name))).toEqual([]);
    expect([...coreNames, ...optionalNames].sort()).toEqual(Object.keys(BROWSER_TOOLS).sort());
  });

  it('declares precise browserCapability requirements for every browser tool', () => {
    const validRequirements = new Set(
      BROWSER_CAPABILITY_NAMES.map((name) => `browserCapability:${name}`)
    );

    for (const [toolName, entry] of Object.entries(BROWSER_TOOL_MANIFEST)) {
      const browserCapabilityRequirements = (entry.metadata.requires || []).filter(
        (requirement) =>
          typeof requirement === 'string' && requirement.startsWith('browserCapability:')
      );
      expect(browserCapabilityRequirements, `${toolName} must declare browser capabilities`).not.toEqual([]);
      expect(
        browserCapabilityRequirements.every((requirement) => validRequirements.has(requirement))
      ).toBe(true);
    }
  });
});
