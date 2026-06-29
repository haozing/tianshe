import type { Rectangle } from 'electron';
import {
  MIN_VIEW_SIZE,
  RENDERER_TOP_INSET,
  WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
} from '../constants/layout';
import { LayoutCalculator, type ViewBounds, type WindowInfo } from './layout-calculator';

export interface PluginLayoutInfo {
  activityBarWidth: number;
  availableWidth: number;
  availableHeight: number;
  windowWidth: number;
  windowHeight: number;
  contentTopInset: number;
}

export interface MainWindowPluginLayout {
  windowInfo: WindowInfo;
  fullBounds: ViewBounds;
  pluginBounds: ViewBounds;
  rendererTopInset: number;
  contentTopInset: number;
}

function normalizeInset(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

export function getRendererViewTopInset(): number {
  return normalizeInset(RENDERER_TOP_INSET);
}

export function getMainWindowContentTopInset(platform: string = process.platform): number {
  const rendererTopInset = getRendererViewTopInset();
  return platform === 'win32'
    ? rendererTopInset + WINDOWS_TITLEBAR_OVERLAY_HEIGHT
    : rendererTopInset;
}

export function applyViewTopInset(bounds: ViewBounds, inset: number): ViewBounds {
  const normalizedInset = normalizeInset(inset);
  if (normalizedInset === 0) {
    return bounds;
  }

  return {
    ...bounds,
    y: bounds.y + normalizedInset,
    height: Math.max(bounds.height - normalizedInset, MIN_VIEW_SIZE),
  };
}

export function calculateMainWindowPluginLayout(
  windowBounds: Rectangle,
  activityBarWidth: number,
  platform: string = process.platform
): MainWindowPluginLayout {
  const windowInfo = LayoutCalculator.getWindowInfo(windowBounds, activityBarWidth);
  const baseBounds = LayoutCalculator.calculateFullBounds(windowInfo);
  const rendererTopInset = getRendererViewTopInset();
  const contentTopInset = getMainWindowContentTopInset(platform);

  return {
    windowInfo,
    fullBounds: applyViewTopInset(baseBounds, rendererTopInset),
    pluginBounds: applyViewTopInset(baseBounds, contentTopInset),
    rendererTopInset,
    contentTopInset,
  };
}

export function calculateDockedPluginPageBounds(
  primaryBounds: ViewBounds,
  rendererTopInset: number,
  contentTopInset: number
): ViewBounds {
  const extraTopInset = Math.max(
    0,
    normalizeInset(contentTopInset) - normalizeInset(rendererTopInset)
  );
  return applyViewTopInset(primaryBounds, extraTopInset);
}

export function buildPluginLayoutInfo(layout: {
  windowInfo: WindowInfo;
  pluginBounds: ViewBounds;
  contentTopInset: number;
}): PluginLayoutInfo {
  return {
    activityBarWidth: layout.windowInfo.activityBarWidth,
    availableWidth: layout.pluginBounds.width,
    availableHeight: layout.pluginBounds.height,
    windowWidth: layout.windowInfo.width,
    windowHeight: layout.windowInfo.height,
    contentTopInset: layout.contentTopInset,
  };
}
