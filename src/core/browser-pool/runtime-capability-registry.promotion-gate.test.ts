import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserRuntimeId } from '../../types/browser-runtime';
import { BROWSER_CAPABILITY_NAMES, type BrowserCapabilityName } from '../../types/browser-interface';
import { STATIC_BROWSER_RUNTIME_DESCRIPTORS } from './runtime-capability-registry';

type RuntimePromotionEvidence = {
  methodPresenceTest: string;
  semanticSmokeTest?: string;
};

type CapabilityPromotionEvidence = RuntimePromotionEvidence;

const CRITICAL_BROWSER_CAPABILITIES = [
  'snapshot.page',
  'screenshot.detailed',
  'input.native',
  'text.dom',
  'network.capture',
] as const satisfies readonly BrowserCapabilityName[];

const capabilityEvidence = (
  capabilityNames: readonly BrowserCapabilityName[],
  evidence: CapabilityPromotionEvidence
): Partial<Record<BrowserCapabilityName, CapabilityPromotionEvidence>> =>
  Object.fromEntries(capabilityNames.map((capabilityName) => [capabilityName, evidence]));

const browserCapabilityTruth = (
  semanticSmokeTest: string
): CapabilityPromotionEvidence => ({
  methodPresenceTest: 'src/core/browser-automation/browser-capability-truth.test.ts',
  semanticSmokeTest,
});

const sessionRequestContractEvidence: CapabilityPromotionEvidence = {
  methodPresenceTest: 'src/core/browser-automation/browser-capability-truth.test.ts',
  semanticSmokeTest: 'src/core/browser-runtime/profile-session-gateway.test.ts',
};

const PROMOTION_EVIDENCE: Record<
  BrowserRuntimeId,
  Partial<Record<BrowserCapabilityName, CapabilityPromotionEvidence>>
> = {
  'electron-webcontents': {
    ...capabilityEvidence(
      [
        'cookies.read',
        'cookies.write',
        'cookies.clear',
        'cookies.filter',
        'storage.dom',
        'userAgent.read',
        'snapshot.page',
        'screenshot.detailed',
        'pdf.print',
        'window.showHide',
        'window.openPolicy',
        'input.native',
        'input.touch',
        'text.dom',
        'text.ocr',
        'network.capture',
        'console.capture',
        'download.manage',
        'emulation.identity',
        'emulation.viewport',
      ],
      browserCapabilityTruth('src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts')
    ),
    'network.sessionRequest': sessionRequestContractEvidence,
  },
  'chromium-extension-relay': {
    ...capabilityEvidence(
      [
        'cookies.read',
        'cookies.write',
        'cookies.clear',
        'cookies.filter',
        'storage.dom',
        'userAgent.read',
        'snapshot.page',
        'screenshot.detailed',
        'window.showHide',
        'window.openPolicy',
        'input.native',
        'input.touch',
        'text.dom',
        'text.ocr',
        'network.capture',
        'network.responseBody',
        'console.capture',
        'dialog.basic',
        'tabs.manage',
        'emulation.identity',
        'emulation.viewport',
        'intercept.observe',
        'intercept.control',
      ],
      browserCapabilityTruth('src/main/profile/browser-pool-integration-extension.canary.test.ts')
    ),
    'network.sessionRequest': sessionRequestContractEvidence,
  },
  'firefox-bidi': capabilityEvidence(
    [
      'cookies.read',
      'cookies.write',
      'cookies.clear',
      'cookies.filter',
      'storage.dom',
      'userAgent.read',
      'snapshot.page',
      'screenshot.detailed',
      'pdf.print',
      'window.showHide',
      'window.openPolicy',
      'input.native',
      'input.touch',
      'text.dom',
      'text.ocr',
      'network.capture',
      'console.capture',
      'download.manage',
      'dialog.basic',
      'dialog.promptText',
      'tabs.manage',
      'events.runtime',
      'emulation.identity',
      'emulation.viewport',
      'intercept.observe',
      'intercept.control',
    ],
    browserCapabilityTruth('src/main/profile/browser-pool-integration-ruyi.canary.test.ts')
  ),
  'chromium-cloak-playwright': capabilityEvidence(
    [
      'cookies.read',
      'cookies.write',
      'cookies.clear',
      'cookies.filter',
      'storage.dom',
      'userAgent.read',
      'snapshot.page',
      'screenshot.detailed',
      'input.native',
      'text.dom',
      'network.capture',
      'console.capture',
      'tabs.manage',
      'emulation.identity',
      'emulation.viewport',
    ],
    {
      methodPresenceTest: 'src/main/profile/browser-pool-integration-cloak.test.ts',
      semanticSmokeTest: 'src/main/profile/browser-pool-integration-cloak.test.ts',
    }
  ),
};

const pathExists = (relativePath: string): boolean => existsSync(path.resolve(relativePath));

describe('browser runtime descriptor promotion gate', () => {
  it('keeps each static descriptor complete and internally consistent', () => {
    for (const descriptor of Object.values(STATIC_BROWSER_RUNTIME_DESCRIPTORS)) {
      expect(Object.keys(descriptor.capabilities).sort()).toEqual(
        [...BROWSER_CAPABILITY_NAMES].sort()
      );

      for (const [capabilityName, capability] of Object.entries(descriptor.capabilities)) {
        expect(capability.supported && capability.stability === 'planned').toBe(false);
        if (!capability.supported) {
          expect(
            capability.notes,
            `${descriptor.runtimeId}:${capabilityName} must explain unsupported status`
          ).toBeTruthy();
        }
      }
    }
  });

  it('requires promotion evidence for every runtime that claims supported capabilities', () => {
    for (const descriptor of Object.values(STATIC_BROWSER_RUNTIME_DESCRIPTORS)) {
      const evidenceByCapability = PROMOTION_EVIDENCE[descriptor.runtimeId];
      expect(
        evidenceByCapability,
        `${descriptor.runtimeId} must declare descriptor promotion evidence`
      ).toBeDefined();

      const supportedCapabilityNames = BROWSER_CAPABILITY_NAMES.filter(
        (capabilityName) => descriptor.capabilities[capabilityName]?.supported === true
      );
      expect(Object.keys(evidenceByCapability).sort()).toEqual(
        [...supportedCapabilityNames].sort()
      );

      for (const capabilityName of supportedCapabilityNames) {
        const evidence = evidenceByCapability[capabilityName];
        expect(
          evidence,
          `${descriptor.runtimeId}:${capabilityName} must declare capability-level promotion evidence`
        ).toBeDefined();
        expect(pathExists(evidence?.methodPresenceTest || ''), evidence?.methodPresenceTest).toBe(
          true
        );
      }

      const supportedCritical = CRITICAL_BROWSER_CAPABILITIES.filter(
        (capabilityName) => descriptor.capabilities[capabilityName]?.supported === true
      );
      for (const capabilityName of supportedCritical) {
        const evidence = evidenceByCapability[capabilityName];
        expect(
          evidence?.semanticSmokeTest,
          `${descriptor.runtimeId}:${capabilityName} is critical and needs smoke or canary evidence`
        ).toBeTruthy();
        expect(pathExists(evidence?.semanticSmokeTest || ''), evidence?.semanticSmokeTest).toBe(
          true
        );
      }
    }
  });
});
