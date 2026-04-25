import { describe, expect, it } from 'vitest';
import { LayoutCalculator } from '../layout-calculator';
import {
  buildPluginLayoutInfo,
  calculateDockedPluginPageBounds,
  calculateMainWindowPluginLayout,
  getMainWindowContentTopInset,
  getRendererViewTopInset,
} from '../plugin-layout';

describe('plugin-layout', () => {
  it('uses the full titlebar inset on Windows and renderer inset elsewhere', () => {
    expect(getRendererViewTopInset()).toBe(1);
    expect(getMainWindowContentTopInset('win32')).toBe(45);
    expect(getMainWindowContentTopInset('darwin')).toBe(1);
  });

  it('places plugin pages below the full Windows titlebar', () => {
    const layout = calculateMainWindowPluginLayout(
      { x: 0, y: 0, width: 1400, height: 900 },
      160,
      'win32'
    );

    expect(layout.fullBounds).toEqual({
      x: 160,
      y: 1,
      width: 1240,
      height: 899,
    });
    expect(layout.pluginBounds).toEqual({
      x: 160,
      y: 45,
      width: 1240,
      height: 855,
    });
  });

  it('keeps plugin pages below the titlebar after window resize', () => {
    const layout = calculateMainWindowPluginLayout(
      { x: 0, y: 0, width: 1600, height: 960 },
      160,
      'win32'
    );

    expect(layout.pluginBounds).toEqual({
      x: 160,
      y: 45,
      width: 1440,
      height: 915,
    });
  });

  it('only shifts the plugin primary pane when a right dock is visible', () => {
    const layout = calculateMainWindowPluginLayout(
      { x: 0, y: 0, width: 1400, height: 900 },
      160,
      'win32'
    );
    const split = LayoutCalculator.calculateSplitLayout(
      { mode: 'split-right', size: '40%' },
      layout.fullBounds
    );

    const dockedPluginBounds = calculateDockedPluginPageBounds(
      split.primary,
      layout.rendererTopInset,
      layout.contentTopInset
    );

    expect(split.secondary).toEqual({
      x: 904,
      y: 1,
      width: 496,
      height: 899,
    });
    expect(dockedPluginBounds).toEqual({
      x: 160,
      y: 45,
      width: 744,
      height: 855,
    });
  });

  it('builds layout info from the real plugin viewport size', () => {
    const layout = calculateMainWindowPluginLayout(
      { x: 0, y: 0, width: 1400, height: 900 },
      160,
      'win32'
    );

    expect(
      buildPluginLayoutInfo({
        windowInfo: layout.windowInfo,
        pluginBounds: layout.pluginBounds,
        contentTopInset: layout.contentTopInset,
      })
    ).toEqual({
      activityBarWidth: 160,
      availableWidth: 1240,
      availableHeight: 855,
      windowWidth: 1400,
      windowHeight: 900,
      contentTopInset: 45,
    });
  });
});
