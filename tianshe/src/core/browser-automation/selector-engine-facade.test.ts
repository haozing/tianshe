import { describe, expect, it, vi } from 'vitest';
import {
  evaluateWithSelectorEngine,
  focusSelectorElement,
  querySelectorElement,
  selectSelectorElementValue,
} from './selector-engine-facade';

describe('selector-engine-facade', () => {
  it('evaluateWithSelectorEngine separates injected IIFEs safely', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ok: true });

    await evaluateWithSelectorEngine(evaluate, '(function() { return { ok: true }; })()');

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [script] = evaluate.mock.calls[0];
    expect(script).toContain(';\n(function() { return { ok: true }; })()');
  });

  it('querySelectorElement uses viewport-safe nearest scrolling instead of centering', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      found: true,
      visible: true,
      interactable: true,
      bounds: { x: 10, y: 10, width: 20, height: 20 },
    });

    await querySelectorElement(evaluate, '#btn');

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [script] = evaluate.mock.calls[0];
    expect(script).toContain("block: 'nearest'");
    expect(script).toContain("inline: 'nearest'");
    expect(script).toContain('const viewportWidth = window.innerWidth');
    expect(script).toContain('const intersectsViewport =');
    expect(script).not.toContain("block: 'center'");
    expect(script).not.toContain("inline: 'center'");
  });

  it('focusSelectorElement only scrolls off-screen targets with nearest alignment', async () => {
    const evaluate = vi.fn().mockResolvedValue(true);

    await focusSelectorElement(evaluate, '#btn');

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [script] = evaluate.mock.calls[0];
    expect(script).toContain("block: 'nearest'");
    expect(script).toContain("inline: 'nearest'");
    expect(script).toContain('const viewportWidth = window.innerWidth');
    expect(script).toContain('const intersectsViewport =');
  });

  it('selectSelectorElementValue verifies the requested option exists before selecting it', async () => {
    const evaluate = vi.fn().mockResolvedValue(true);

    await selectSelectorElementValue(evaluate, '#country', 'CN');

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [script] = evaluate.mock.calls[0];
    expect(script).toContain('candidate.value === "CN"');
    expect(script).toContain("new Event('input'");
    expect(script).toContain("new Event('change'");
  });
});
