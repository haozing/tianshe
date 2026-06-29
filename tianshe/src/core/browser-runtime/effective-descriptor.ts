import type { BrowserRuntimeDescriptor } from '../../types/browser-interface';
import { BROWSER_RUNTIME_IDS, type BrowserRuntimeId } from '../../types/browser-runtime';
import {
  applyRuntimeCapabilitySupport,
  cloneBrowserRuntimeDescriptor,
  getStaticRuntimeDescriptor,
} from '../browser-pool/runtime-capability-registry';
import type { BrowserRuntimeStatus } from './runtime-manager';

const CLOAK_DYNAMIC_CAPABILITY_NOTES = {
  'pdf.print':
    'Cloak Playwright exposes Playwright PDF export when the underlying page supports pdf().',
  'network.responseBody':
    'Cloak Playwright captures response.text() on stored/waited responses; treat as experimental because large/streaming bodies may be unavailable.',
  'download.manage':
    'Cloak Playwright tracks Playwright download lifecycle and optional saveAs paths through the unified runtime API.',
  'dialog.basic':
    'Cloak Playwright exposes basic JavaScript dialog accept/dismiss through Playwright dialog events.',
  'dialog.promptText':
    'Cloak Playwright exposes prompt text submission through Playwright dialog accept(promptText).',
  'events.runtime':
    'Cloak Playwright emits normalized runtime events for downloads, dialogs, tabs, network, and console messages.',
  'intercept.observe':
    'Cloak Playwright observes routed requests through Playwright route interception.',
  'intercept.control':
    'Cloak Playwright can continue, fulfill, or fail intercepted Playwright routes.',
} as const;

export function getKnownEffectiveRuntimeDescriptor(
  runtimeId: BrowserRuntimeId
): BrowserRuntimeDescriptor {
  const descriptor = getStaticRuntimeDescriptor(runtimeId);
  if (runtimeId !== 'chromium-cloak-playwright') {
    return descriptor;
  }

  return applyRuntimeCapabilitySupport(
    descriptor,
    {
      'pdf.print': true,
      'network.responseBody': true,
      'download.manage': true,
      'dialog.basic': true,
      'dialog.promptText': true,
      'events.runtime': true,
      'intercept.observe': true,
      'intercept.control': true,
    },
    {
      source: 'runtime',
      stability: 'experimental',
      notes: CLOAK_DYNAMIC_CAPABILITY_NOTES,
    }
  );
}

export function buildEffectiveRuntimeDescriptorMap(
  statuses?: readonly Pick<BrowserRuntimeStatus, 'runtimeId' | 'descriptor'>[] | null
): Record<BrowserRuntimeId, BrowserRuntimeDescriptor> {
  const descriptors = Object.fromEntries(
    BROWSER_RUNTIME_IDS.map((runtimeId) => [
      runtimeId,
      getKnownEffectiveRuntimeDescriptor(runtimeId),
    ])
  ) as Record<BrowserRuntimeId, BrowserRuntimeDescriptor>;

  for (const status of statuses || []) {
    descriptors[status.runtimeId] = cloneBrowserRuntimeDescriptor(status.descriptor);
  }

  return descriptors;
}
