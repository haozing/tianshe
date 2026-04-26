import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCloudAuthAvailable,
  isCloudBrowserExtensionCatalogAvailable,
  isCloudCatalogAvailable,
  isCloudSnapshotAvailable,
  isCloudWorkbenchAvailable,
} from './edition';

const originalElectronAPI = window.electronAPI;

function setElectronAPI(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value,
  });
}

describe('renderer edition capabilities', () => {
  beforeEach(() => {
    setElectronAPI({});
  });

  afterEach(() => {
    setElectronAPI(originalElectronAPI);
  });

  it('defaults cloud capabilities to disabled when edition info is missing', () => {
    expect(isCloudAuthAvailable()).toBe(false);
    expect(isCloudSnapshotAvailable()).toBe(false);
    expect(isCloudCatalogAvailable()).toBe(false);
    expect(isCloudBrowserExtensionCatalogAvailable()).toBe(false);
    expect(isCloudWorkbenchAvailable()).toBe(false);
  });

  it('requires both edition capability and matching preload API', () => {
    setElectronAPI({
      edition: {
        capabilities: {
          cloudAuth: true,
          cloudSnapshot: true,
          cloudCatalog: true,
        },
      },
    });

    expect(isCloudAuthAvailable()).toBe(false);
    expect(isCloudSnapshotAvailable()).toBe(false);
    expect(isCloudCatalogAvailable()).toBe(false);
    expect(isCloudBrowserExtensionCatalogAvailable()).toBe(false);

    setElectronAPI({
      edition: {
        capabilities: {
          cloudAuth: true,
          cloudSnapshot: true,
          cloudCatalog: true,
        },
      },
      cloudAuth: {},
      cloudSnapshot: {},
      cloudPlugin: {},
      cloudBrowserExtension: {},
    });

    expect(isCloudAuthAvailable()).toBe(true);
    expect(isCloudSnapshotAvailable()).toBe(true);
    expect(isCloudCatalogAvailable()).toBe(true);
    expect(isCloudBrowserExtensionCatalogAvailable()).toBe(true);
    expect(isCloudWorkbenchAvailable()).toBe(true);
  });
});
