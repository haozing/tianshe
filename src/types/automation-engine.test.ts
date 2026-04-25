import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ENGINES,
  isAutomationEngine,
  isPersistentAutomationEngine,
  normalizeProfileBrowserQuota,
  normalizeAutomationEngine,
  PERSISTENT_AUTOMATION_ENGINES,
  PROFILE_BROWSER_INSTANCE_LIMIT,
} from './automation-engine';

describe('automation engine helpers', () => {
  it('exposes the supported engine names from one place', () => {
    expect(AUTOMATION_ENGINES).toEqual(['electron', 'extension', 'ruyi']);
    expect(PERSISTENT_AUTOMATION_ENGINES).toEqual(['extension', 'ruyi']);
  });

  it('recognizes valid automation engines', () => {
    expect(isAutomationEngine('electron')).toBe(true);
    expect(isAutomationEngine('extension')).toBe(true);
    expect(isAutomationEngine('ruyi')).toBe(true);
    expect(isAutomationEngine('firefox')).toBe(false);
    expect(isAutomationEngine(null)).toBe(false);
  });

  it('normalizes unknown engine values to electron by default', () => {
    expect(normalizeAutomationEngine('electron')).toBe('electron');
    expect(normalizeAutomationEngine('extension')).toBe('extension');
    expect(normalizeAutomationEngine('ruyi')).toBe('ruyi');
    expect(normalizeAutomationEngine('firefox')).toBe('electron');
    expect(normalizeAutomationEngine(undefined)).toBe('electron');
    expect(normalizeAutomationEngine('firefox', 'ruyi')).toBe('ruyi');
  });

  it('marks only persistent engines as persistent', () => {
    expect(isPersistentAutomationEngine('electron')).toBe(false);
    expect(isPersistentAutomationEngine('extension')).toBe(true);
    expect(isPersistentAutomationEngine('ruyi')).toBe(true);
    expect(isPersistentAutomationEngine(undefined)).toBe(false);
  });

  it('exposes the per-profile single-instance limit from one place', () => {
    expect(PROFILE_BROWSER_INSTANCE_LIMIT).toBe(1);
  });

  it('normalizes every profile quota to a single live browser instance', () => {
    expect(normalizeProfileBrowserQuota(4)).toEqual({
      quota: 1,
      forced: true,
      reason: 'single-profile-browser-instance',
    });
    expect(normalizeProfileBrowserQuota(1)).toEqual({
      quota: 1,
      forced: false,
      reason: null,
    });
  });
});
