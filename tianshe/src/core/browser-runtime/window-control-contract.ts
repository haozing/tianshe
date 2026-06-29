import type { BrowserRuntimeDescriptor } from '../../types/browser-interface';
import type { BrowserRuntimeId } from '../../types/browser-runtime';
import { getStaticRuntimeDescriptor } from '../browser-pool/runtime-capability-registry';

export type BrowserWindowControlCapability =
  | 'window'
  | 'focus'
  | 'restore'
  | 'capture'
  | 'osInput'
  | 'manualHandoff';

export type BrowserWindowControlSupport = 'supported' | 'degraded' | 'unsupported';

export interface BrowserWindowControlCapabilityDescriptor {
  status: BrowserWindowControlSupport;
  reason?: string;
  requiredBrowserCapability?: string;
}

export interface BrowserWindowControlContract {
  runtimeId: BrowserRuntimeId;
  visibilityMode: BrowserRuntimeDescriptor['visibilityMode'];
  capabilities: Record<BrowserWindowControlCapability, BrowserWindowControlCapabilityDescriptor>;
}

const descriptor = (
  status: BrowserWindowControlSupport,
  reason?: string,
  requiredBrowserCapability?: string
): BrowserWindowControlCapabilityDescriptor => ({
  status,
  ...(reason ? { reason } : {}),
  ...(requiredBrowserCapability ? { requiredBrowserCapability } : {}),
});

export function getWindowControlContract(
  runtimeDescriptor: BrowserRuntimeDescriptor
): BrowserWindowControlContract {
  const { runtimeId, visibilityMode } = runtimeDescriptor;
  const showHideSupported =
    runtimeDescriptor.capabilities['window.showHide']?.supported === true;
  const screenshotSupported =
    runtimeDescriptor.capabilities['screenshot.detailed']?.supported === true;
  const nativeInputSupported =
    runtimeDescriptor.capabilities['input.native']?.supported === true;

  const embeddedOrDirect =
    visibilityMode === 'embedded-view' || visibilityMode === 'direct-window';
  const external = visibilityMode === 'external-window';

  return {
    runtimeId,
    visibilityMode,
    capabilities: {
      window: showHideSupported
        ? descriptor('supported', 'Runtime can show or hide its managed browser surface.', 'window.showHide')
        : descriptor(
            external ? 'degraded' : 'unsupported',
            external
              ? 'External browser windows are user-visible but direct show/hide control is limited.'
              : 'Runtime does not expose a managed visible browser surface.',
            'window.showHide'
          ),
      focus:
        showHideSupported || embeddedOrDirect
          ? descriptor('supported', 'Runtime can focus the managed browser surface.', 'window.showHide')
          : descriptor('degraded', 'Focus is best-effort for external browser windows.'),
      restore:
        showHideSupported || embeddedOrDirect
          ? descriptor('supported', 'Runtime can restore the browser surface before interaction.', 'window.showHide')
          : descriptor('degraded', 'Restoring external windows depends on the host OS/window manager.'),
      capture: screenshotSupported
        ? descriptor('supported', 'Runtime can provide browser screenshot capture.', 'screenshot.detailed')
        : descriptor('unsupported', 'Runtime does not expose screenshot capture.', 'screenshot.detailed'),
      osInput: nativeInputSupported
        ? descriptor('supported', 'Runtime supports native OS-level input.', 'input.native')
        : descriptor('degraded', 'Runtime falls back to DOM/selector input instead of native OS input.', 'input.native'),
      manualHandoff:
        visibilityMode === 'headless'
          ? descriptor('unsupported', 'Headless runtime cannot provide a human handoff window.')
          : descriptor(
              showHideSupported || embeddedOrDirect ? 'supported' : 'degraded',
              showHideSupported || embeddedOrDirect
                ? 'Runtime can present a human handoff surface.'
                : 'Human handoff is possible through an existing external browser window, but focus/restore is best-effort.',
              'window.showHide'
            ),
    },
  };
}

export function getRuntimeWindowControlContract(
  runtimeId: BrowserRuntimeId
): BrowserWindowControlContract {
  return getWindowControlContract(getStaticRuntimeDescriptor(runtimeId));
}
