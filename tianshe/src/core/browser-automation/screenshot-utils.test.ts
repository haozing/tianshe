import { describe, expect, it } from 'vitest';
import {
  getMimeTypeForScreenshotFormat,
  normalizeScreenshotCaptureMode,
  normalizeScreenshotFormat,
} from './screenshot-utils';

describe('screenshot utils', () => {
  it('normalizes screenshot format defaults and mime types', () => {
    expect(normalizeScreenshotFormat()).toBe('png');
    expect(normalizeScreenshotFormat({ format: 'png' })).toBe('png');
    expect(normalizeScreenshotFormat({ format: 'jpeg' })).toBe('jpeg');
    expect(getMimeTypeForScreenshotFormat('png')).toBe('image/png');
    expect(getMimeTypeForScreenshotFormat('jpeg')).toBe('image/jpeg');
  });

  it('normalizes capture mode from fullPage compatibility options', () => {
    expect(normalizeScreenshotCaptureMode()).toBe('viewport');
    expect(normalizeScreenshotCaptureMode({ captureMode: 'viewport' })).toBe('viewport');
    expect(normalizeScreenshotCaptureMode({ captureMode: 'full_page' })).toBe('full_page');
    expect(normalizeScreenshotCaptureMode({ fullPage: true })).toBe('full_page');
  });
});
