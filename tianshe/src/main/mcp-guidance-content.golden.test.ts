import { describe, expect, it } from 'vitest';
import { buildGuideContent, buildInitializeInstructions } from './mcp-guidance-content';

describe('mcp guidance golden paths', () => {
  it('keeps the default MCP guidance on framework capabilities instead of raw page APIs', () => {
    const gettingStarted = buildGuideContent('getting_started');
    const initializeInstructions = buildInitializeInstructions();

    expect(gettingStarted).toContain('system_bootstrap');
    expect(gettingStarted).toContain('session_prepare');
    expect(gettingStarted).toContain('profile_ensure_logged_in');
    expect(`${gettingStarted}\n${initializeInstructions}`).not.toMatch(/Playwright|generic .*MCP|page\./i);
  });

  it('routes login exceptions through profile handoff instead of model-entered credentials', () => {
    const loginGuide = buildGuideContent('login_pages');

    expect(loginGuide).toContain('profile_ensure_logged_in');
    expect(loginGuide).toContain('human handoff');
    expect(loginGuide).not.toMatch(/action="type".*credential|username, password/i);
  });

  it('keeps read-only extraction and repair on the Site Adapter evidence path', () => {
    const gettingStarted = buildGuideContent('getting_started');
    const initializeInstructions = buildInitializeInstructions();
    const combined = `${gettingStarted}\n${initializeInstructions}`;

    expect(combined).toContain('Site Adapter');
    expect(combined).toContain('site_adapter_result');
    expect(combined).toContain('site_adapter_failure');
    expect(combined).toContain('site_adapter_repair_evidence');
    expect(combined).toContain('extractors, verifiers, fixtures, and expected outputs');
    expect(combined).toContain('do not repair framework core');
    expect(combined).not.toMatch(/page\.evaluate|raw evaluate/i);
  });
});
