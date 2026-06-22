import { describe, expect, it } from 'vitest';
import { BROWSER_CAPABILITY_NAMES } from '../../types/browser-interface';
import {
  STATIC_BROWSER_RUNTIME_DESCRIPTORS,
} from '../browser-pool/runtime-capability-registry';
import {
  BROWSER_CAPABILITY_CONTRACTS,
  BROWSER_MINIMAL_CORE_METHODS,
  createBrowserRuntimeCapabilityMatrix,
  getMissingBrowserCapabilityContractMethods,
  validateBrowserCapabilityContracts,
  validateBrowserRuntimeDescriptorAgainstContract,
} from './capability-contract';

describe('browser capability contract', () => {
  it('covers every declared browser capability exactly once', () => {
    expect(Object.keys(BROWSER_CAPABILITY_CONTRACTS).sort()).toEqual(
      [...BROWSER_CAPABILITY_NAMES].sort()
    );
    expect(validateBrowserCapabilityContracts()).toEqual([]);
  });

  it('keeps static runtime descriptors aligned with the contract', () => {
    for (const descriptor of Object.values(STATIC_BROWSER_RUNTIME_DESCRIPTORS)) {
      expect(validateBrowserRuntimeDescriptorAgainstContract(descriptor)).toEqual([]);
      for (const [capabilityName, capability] of Object.entries(descriptor.capabilities)) {
        if (!capability.supported) {
          expect(capability.notes, `${descriptor.runtimeId}:${capabilityName}`).toBeTruthy();
        }
      }
    }
  });

  it('generates a runtime capability matrix from descriptors and contracts', () => {
    const matrix = createBrowserRuntimeCapabilityMatrix(
      Object.values(STATIC_BROWSER_RUNTIME_DESCRIPTORS)
    );

    expect(matrix).toHaveLength(
      Object.keys(STATIC_BROWSER_RUNTIME_DESCRIPTORS).length * BROWSER_CAPABILITY_NAMES.length
    );
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: 'electron-webcontents',
          capabilityName: 'snapshot.page',
          supported: true,
          requiredMethods: expect.arrayContaining(['snapshot', 'search']),
          semanticChecks: expect.arrayContaining(['snapshot.page.semantic-elements']),
          toolRequirements: expect.arrayContaining(['browser_observe', 'browser_snapshot']),
        }),
        expect.objectContaining({
          runtimeId: 'chromium-cloak-playwright',
          capabilityName: 'window.showHide',
          supported: false,
          degradedModes: expect.arrayContaining(['external-window cannot be programmatically hidden']),
        }),
      ])
    );
  });

  it('checks dotted method paths against runtime instances', () => {
    const browser = {
      native: {
        click: () => undefined,
        move: () => undefined,
      },
    };

    expect(getMissingBrowserCapabilityContractMethods(browser, 'input.native')).toEqual([
      'native.drag',
      'native.type',
      'native.keyPress',
      'native.scroll',
    ]);
  });

  it('keeps BrowserCore minimal and leaves feature methods in capability contracts', () => {
    expect([...BROWSER_MINIMAL_CORE_METHODS]).toEqual([
      'describeRuntime',
      'hasCapability',
      'goto',
      'back',
      'forward',
      'reload',
      'getCurrentUrl',
      'title',
    ]);

    const coreMethodNames = new Set<string>(BROWSER_MINIMAL_CORE_METHODS);
    const capabilityMethods = Object.values(BROWSER_CAPABILITY_CONTRACTS).flatMap(
      (contract) => contract.requiredMethods
    );
    expect(capabilityMethods.filter((methodName) => coreMethodNames.has(methodName))).toEqual([]);
    expect(capabilityMethods).toEqual(expect.arrayContaining(['snapshot', 'search', 'getCookies']));
  });
});
