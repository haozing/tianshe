import type {
  BrowserScreenshotResult,
  ScreenshotOptions,
} from '../../types/browser-interface';

export type BrowserScreenshotFormat = BrowserScreenshotResult['format'];
export type BrowserScreenshotCaptureMode = BrowserScreenshotResult['captureMode'];
export type BrowserScreenshotMimeType = BrowserScreenshotResult['mimeType'];

export function normalizeScreenshotFormat(
  options?: Pick<ScreenshotOptions, 'format'>
): BrowserScreenshotFormat {
  return options?.format === 'jpeg' ? 'jpeg' : 'png';
}

export function normalizeScreenshotCaptureMode(
  options?: Pick<ScreenshotOptions, 'captureMode' | 'fullPage'>
): BrowserScreenshotCaptureMode {
  if (options?.captureMode === 'full_page' || options?.fullPage === true) {
    return 'full_page';
  }
  return 'viewport';
}

export function getMimeTypeForScreenshotFormat(
  format: BrowserScreenshotFormat
): BrowserScreenshotMimeType {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}
