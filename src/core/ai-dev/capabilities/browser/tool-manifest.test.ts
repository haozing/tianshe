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

  it('keeps canonical core and optional browser groups disjoint while covering the public surface', () => {
    const coreNames = Object.keys(PUBLIC_BROWSER_CORE_TOOLS).sort();
    const optionalNames = Object.keys(PUBLIC_BROWSER_OPTIONAL_TOOLS).sort();
    expect(coreNames.filter((name) => optionalNames.includes(name))).toEqual([]);
    expect([...coreNames, ...optionalNames].sort()).toEqual(Object.keys(BROWSER_TOOLS).sort());
  });
});
