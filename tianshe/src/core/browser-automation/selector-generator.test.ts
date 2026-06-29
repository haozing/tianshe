import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { getSelectorEngineScript, getSnapshotScript } from './selector-generator';

function createDom(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    url: 'https://example.test/',
  });

  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 8,
        y: 8,
        width: 120,
        height: 24,
        top: 8,
        right: 128,
        bottom: 32,
        left: 8,
      };
    },
  });

  return dom;
}

describe('selector-generator', () => {
  it('snapshot all keeps placeholder-only inputs and emits usable selectors', () => {
    const dom = createDom(`
      <input id="name" placeholder="Your name" />
      <button id="go">Go</button>
    `);

    const snapshot = dom.window.eval(getSnapshotScript('all')) as {
      elements: Array<{ tag: string; placeholder?: string; preferredSelector?: string }>;
    };

    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'input',
          placeholder: 'Your name',
          preferredSelector: '#name',
        }),
        expect.objectContaining({
          tag: 'button',
          preferredSelector: '#go',
        }),
      ])
    );
  });

  it('selector engine supports :has-text selectors used by snapshot output', () => {
    const dom = createDom('<button id="go">Go</button>');

    dom.window.eval(getSelectorEngineScript());
    const matchCount = dom.window.eval(
      'window.__selectorEngine.querySelectorAll(\'button:has-text("Go")\').length'
    ) as number;

    expect(matchCount).toBe(1);
  });
});
