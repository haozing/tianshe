import { describe, expect, it } from 'vitest';
import { renderBackgroundScript } from './extension-control-extension-background';

describe('extension background script render', () => {
  it('uses Input.insertText for extension typing and does not emit legacy char events', () => {
    const script = renderBackgroundScript();
    const insertTextBlockMatch = script.match(
      /async function insertText\(tabId, text, delay\) \{[\s\S]*?\n\}\n\nasync function startNetworkCapture/
    );

    expect(insertTextBlockMatch?.[0]).toBeTruthy();
    const insertTextBlock = insertTextBlockMatch?.[0] || '';

    expect(insertTextBlock).toContain("Input.insertText");
    expect(insertTextBlock).not.toContain("type: 'char'");
    expect(insertTextBlock).not.toContain('isPrintableAsciiChar');
  });

  it('requires a bound tab target for relay commands instead of falling back to the active tab', () => {
    const script = renderBackgroundScript();
    const resolveCommandTabBlockMatch = script.match(
      /async function resolveCommandTab\(target\) \{[\s\S]*?\n\}\n\nasync function emitClientStateFromTab/
    );

    expect(resolveCommandTabBlockMatch?.[0]).toBeTruthy();
    const resolveCommandTabBlock = resolveCommandTabBlockMatch?.[0] || '';

    expect(resolveCommandTabBlock).toContain('Bound target tabId is required for extension commands');
    expect(resolveCommandTabBlock).not.toContain('return getActiveTab();');
  });

  it('uses runtime relay config messaging and batches noisy relay events', () => {
    const script = renderBackgroundScript();

    expect(script).toContain('const AIRPA_RUNTIME_CONFIG =');
    expect(script).not.toContain("runtime-config.json");
    expect(script).toContain('function queueRelayEvent(payload)');
    expect(script).toContain('events: batch');
    expect(script).toContain("type === 'airpa-get-relay-config'");
  });

  it('renders intercept command handlers through the Fetch domain', () => {
    const script = renderBackgroundScript();

    expect(script).toContain("case 'network.intercept.enable'");
    expect(script).toContain("case 'network.intercept.continue'");
    expect(script).toContain("case 'network.intercept.fulfill'");
    expect(script).toContain("case 'network.intercept.fail'");
    expect(script).toContain("method !== 'Fetch.requestPaused'");
    expect(script).toContain("'Fetch.enable'");
  });

  it('renders runtime emulation handlers without promoting them to startup fingerprint logic', () => {
    const script = renderBackgroundScript();

    expect(script).toContain("case 'emulation.identity.set'");
    expect(script).toContain("case 'emulation.viewport.set'");
    expect(script).toContain("case 'emulation.clear'");
    expect(script).toContain('function createEmulationState()');
    expect(script).toContain('async function ensureEmulationBaseline(tabId)');
  });

  it('falls back to the bound tab url when cookies.set omits explicit url and domain', () => {
    const script = renderBackgroundScript();

    expect(script).toContain('async function setCookie(cookie, fallbackUrl)');
    expect(script).toContain('const resolved = new URL(String(fallbackUrl));');
    expect(script).toContain("await setCookie(params.cookie || {}, tab.url || '');");
    expect(script).toContain("throw new Error('Cookie url or domain is required');");
  });

  it('never renders an invalid maxTouchPoints=0 payload for touch emulation updates', () => {
    const script = renderBackgroundScript();

    expect(script).toContain('function buildTouchEmulationPayload(enabled)');
    expect(script).toContain('buildTouchEmulationPayload(');
    expect(script).not.toContain('maxTouchPoints: 0');
  });
});
