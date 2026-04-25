import type { AutomationEngine } from '../../types/automation-engine';
import type { FingerprintConfig } from '../../types/profile';
import { getFingerprintRequiredPaths } from './fingerprint-engine-contracts';

export type FingerprintValidationResult = {
  valid: boolean;
  warnings: string[];
};

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function hasRequiredFingerprintValue(fingerprint: FingerprintConfig, path: string): boolean {
  const value = readPath(fingerprint, path);
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    if (path === 'identity.automationSignals.webdriver') {
      return value === 0 || value === 1;
    }
    return Number.isFinite(value) && value > 0;
  }
  return value !== null && value !== undefined;
}

function normalizeBrowserEngine(
  engine: AutomationEngine | undefined,
  fingerprint: FingerprintConfig
): 'electron' | 'extension' | 'ruyi' {
  if (engine === 'extension' || engine === 'ruyi' || engine === 'electron') {
    return engine;
  }
  if (fingerprint.identity.hardware.browserFamily === 'firefox') {
    return 'ruyi';
  }
  if (fingerprint.identity.hardware.browserFamily === 'electron') {
    return 'electron';
  }
  return 'extension';
}

function validateSpeechBundle(fingerprint: FingerprintConfig, warnings: string[]): void {
  const speech = fingerprint.identity.speech;
  if (!speech) {
    return;
  }

  const localNames = speech.localNames ?? [];
  const localLangs = speech.localLangs ?? [];
  const remoteNames = speech.remoteNames ?? [];
  const remoteLangs = speech.remoteLangs ?? [];

  if (localNames.length !== localLangs.length) {
    warnings.push('speech.local-names-langs-mismatch');
  }
  if (remoteNames.length !== remoteLangs.length) {
    warnings.push('speech.remote-names-langs-mismatch');
  }

  const combinedNames = [...localNames, ...remoteNames];
  const combinedLangs = [...localLangs, ...remoteLangs];
  if (speech.defaultName && !combinedNames.includes(speech.defaultName)) {
    warnings.push('speech.default-name-missing');
  }
  if (speech.defaultLang && !combinedLangs.includes(speech.defaultLang)) {
    warnings.push('speech.default-lang-missing');
  }
}

export function getFingerprintPreflightIssues(
  fingerprint: FingerprintConfig | undefined,
  engine?: AutomationEngine
): string[] {
  if (!fingerprint) {
    return [
      'missing:identity',
      'missing:source',
    ];
  }

  const issues: string[] = [];
  const identity = fingerprint.identity;
  const runtime = normalizeBrowserEngine(engine, fingerprint);
  const webgl = identity.graphics?.webgl;

  for (const path of getFingerprintRequiredPaths(runtime)) {
    if (!hasRequiredFingerprintValue(fingerprint, path)) {
      issues.push(`missing:${path}`);
    }
  }

  return issues;
}

export function validateFingerprintConfig(
  fingerprint: FingerprintConfig,
  engine?: AutomationEngine
): FingerprintValidationResult {
  const warnings = [...getFingerprintPreflightIssues(fingerprint, engine)];
  const identity = fingerprint.identity;
  const ua = identity.hardware.userAgent;
  const platform = identity.hardware.platform;
  const webgl = identity.graphics?.webgl;
  const languages = identity.region.languages;
  const runtime = normalizeBrowserEngine(engine, fingerprint);

  if (languages.length > 0 && identity.region.primaryLanguage !== languages[0]) {
    warnings.push('region.primaryLanguage-mismatch');
  }

  if (identity.hardware.osFamily === 'windows' && !/^Win/i.test(platform)) {
    warnings.push('hardware.platform-os-mismatch:windows');
  }
  if (identity.hardware.osFamily === 'macos' && platform !== 'MacIntel') {
    warnings.push('hardware.platform-os-mismatch:macos');
  }
  if (identity.hardware.osFamily === 'linux' && !/Linux/i.test(platform)) {
    warnings.push('hardware.platform-os-mismatch:linux');
  }

  if (identity.hardware.osFamily === 'windows' && !/Windows/i.test(ua)) {
    warnings.push('hardware.userAgent-os-mismatch:windows');
  }
  if (identity.hardware.osFamily === 'macos' && !/(Macintosh|Mac OS X)/i.test(ua)) {
    warnings.push('hardware.userAgent-os-mismatch:macos');
  }
  if (identity.hardware.osFamily === 'linux' && !/Linux/i.test(ua)) {
    warnings.push('hardware.userAgent-os-mismatch:linux');
  }

  if (runtime === 'ruyi' && !/Firefox\//i.test(ua)) {
    warnings.push('hardware.userAgent-browser-mismatch:firefox');
  }
  if ((runtime === 'extension' || runtime === 'electron') && !/(Chrome|Edg)\//i.test(ua)) {
    warnings.push('hardware.userAgent-browser-mismatch:chromium');
  }

  if (
    identity.hardware.fontSystem &&
    ((identity.hardware.osFamily === 'windows' && identity.hardware.fontSystem !== 'windows') ||
      (identity.hardware.osFamily === 'linux' && identity.hardware.fontSystem !== 'linux') ||
      (identity.hardware.osFamily === 'macos' && identity.hardware.fontSystem !== 'mac'))
  ) {
    warnings.push('hardware.fontSystem-os-mismatch');
  }

  if (
    isFinitePositiveNumber(identity.display.availWidth) &&
    identity.display.availWidth > identity.display.width
  ) {
    warnings.push('display.availWidth-exceeds-width');
  }
  if (
    isFinitePositiveNumber(identity.display.availHeight) &&
    identity.display.availHeight > identity.display.height
  ) {
    warnings.push('display.availHeight-exceeds-height');
  }

  const maxTouchPoints = identity.input?.maxTouchPoints ?? 0;
  const touchSupport = identity.input?.touchSupport ?? false;
  if (!touchSupport && maxTouchPoints > 0) {
    warnings.push('input.touchSupport-false-maxTouchPoints-positive');
  }
  if (touchSupport && maxTouchPoints <= 0) {
    warnings.push('input.touchSupport-true-maxTouchPoints-zero');
  }

  if (webgl?.maskedVendor && webgl?.maskedRenderer) {
    const vendor = webgl.maskedVendor.toLowerCase();
    const renderer = webgl.maskedRenderer.toLowerCase();
    if (vendor.includes('nvidia') && !renderer.includes('nvidia')) {
      warnings.push('graphics.webgl.vendor-renderer-mismatch:nvidia');
    }
    if (vendor.includes('intel') && !renderer.includes('intel')) {
      warnings.push('graphics.webgl.vendor-renderer-mismatch:intel');
    }
    if (vendor.includes('amd') && !renderer.includes('amd') && !renderer.includes('radeon')) {
      warnings.push('graphics.webgl.vendor-renderer-mismatch:amd');
    }
  }

  validateSpeechBundle(fingerprint, warnings);

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
