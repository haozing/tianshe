import type {
  BrowserCapabilityDescriptor,
  BrowserCapabilityName,
  BrowserRuntimeDescriptor,
} from '../../types/browser-interface';
import { BROWSER_CAPABILITY_NAMES } from '../../types/browser-interface';
import type { BrowserRuntimeId } from '../../types/browser-runtime';

export type BrowserCapabilitySemanticCheckKind =
  | 'method-presence'
  | 'semantic-smoke'
  | 'runtime-canary'
  | 'manual-handoff'
  | 'degraded-mode';

export interface BrowserCapabilitySemanticCheck {
  id: string;
  kind: BrowserCapabilitySemanticCheckKind;
  description: string;
  evidence?: string;
}

export interface BrowserCapabilityContract {
  name: BrowserCapabilityName;
  requiredMethods: string[];
  semanticChecks: BrowserCapabilitySemanticCheck[];
  degradedModes?: string[];
  toolRequirements?: string[];
}

export interface BrowserCapabilityContractValidationIssue {
  code:
    | 'missing_contract'
    | 'missing_descriptor_capability'
    | 'extra_descriptor_capability'
    | 'supported_planned'
    | 'unsupported_without_notes'
    | 'supported_without_required_methods'
    | 'supported_without_semantic_checks';
  runtimeId?: BrowserRuntimeId;
  capabilityName?: BrowserCapabilityName | string;
  message: string;
}

export interface BrowserRuntimeCapabilityMatrixRow {
  runtimeId: BrowserRuntimeId;
  capabilityName: BrowserCapabilityName;
  supported: boolean;
  stability: BrowserCapabilityDescriptor['stability'];
  source: BrowserCapabilityDescriptor['source'];
  notes?: string;
  requiredMethods: string[];
  semanticChecks: string[];
  degradedModes: string[];
  toolRequirements: string[];
}

const semanticCheck = (
  id: string,
  kind: BrowserCapabilitySemanticCheckKind,
  description: string,
  evidence?: string
): BrowserCapabilitySemanticCheck => ({
  id,
  kind,
  description,
  ...(evidence ? { evidence } : {}),
});

export const BROWSER_CAPABILITY_CONTRACTS: Record<
  BrowserCapabilityName,
  BrowserCapabilityContract
> = Object.freeze({
  'cookies.read': {
    name: 'cookies.read',
    requiredMethods: ['getCookies'],
    semanticChecks: [
      semanticCheck(
        'cookies.read.list',
        'semantic-smoke',
        'Reads cookies without exposing values on public agent surfaces.',
        'src/core/ai-dev/capabilities/browser/handlers/cookies.test.ts'
      ),
    ],
    toolRequirements: ['browser_cookies_get'],
  },
  'cookies.write': {
    name: 'cookies.write',
    requiredMethods: ['setCookie'],
    semanticChecks: [
      semanticCheck(
        'cookies.write.set',
        'method-presence',
        'Sets a cookie through the unified BrowserCookieCapability.'
      ),
    ],
    toolRequirements: ['browser_cookies_set'],
  },
  'cookies.clear': {
    name: 'cookies.clear',
    requiredMethods: ['clearCookies'],
    semanticChecks: [
      semanticCheck('cookies.clear.all', 'method-presence', 'Clears cookies for the active context.'),
    ],
    toolRequirements: ['browser_cookies_clear'],
  },
  'cookies.filter': {
    name: 'cookies.filter',
    requiredMethods: ['getCookies'],
    semanticChecks: [
      semanticCheck('cookies.filter.query', 'method-presence', 'Accepts cookie filters when reading cookies.'),
    ],
    toolRequirements: ['browser_cookies_get'],
  },
  'storage.dom': {
    name: 'storage.dom',
    requiredMethods: ['getStorageItem', 'setStorageItem', 'removeStorageItem', 'clearStorageArea'],
    semanticChecks: [
      semanticCheck('storage.dom.roundtrip', 'semantic-smoke', 'Can round-trip local/session storage values.'),
    ],
  },
  'userAgent.read': {
    name: 'userAgent.read',
    requiredMethods: ['getUserAgent'],
    semanticChecks: [
      semanticCheck('userAgent.read.value', 'method-presence', 'Reads the active runtime user agent.'),
    ],
  },
  'snapshot.page': {
    name: 'snapshot.page',
    requiredMethods: ['snapshot', 'search'],
    semanticChecks: [
      semanticCheck(
        'snapshot.page.semantic-elements',
        'semantic-smoke',
        'Returns URL, title, and semantic elements for the active page.',
        'src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts'
      ),
    ],
    toolRequirements: [
      'browser_observe',
      'browser_snapshot',
      'browser_search',
      'browser_wait_for',
      'browser_act',
      'browser_debug_state',
      'browser_validate_selector',
    ],
  },
  'screenshot.detailed': {
    name: 'screenshot.detailed',
    requiredMethods: ['screenshot', 'screenshotDetailed'],
    semanticChecks: [
      semanticCheck(
        'screenshot.detailed.capture',
        'semantic-smoke',
        'Captures viewport/full-page screenshot metadata with degradation flags.',
        'src/core/browser-automation/browser-runtime.cross-runtime-contract.test.ts'
      ),
    ],
    degradedModes: ['stitched capture', 'viewport-only fallback'],
    toolRequirements: ['browser_screenshot', 'browser_debug_state'],
  },
  'pdf.print': {
    name: 'pdf.print',
    requiredMethods: ['savePdf'],
    semanticChecks: [
      semanticCheck('pdf.print.payload', 'semantic-smoke', 'Returns a PDF payload or saved path.'),
    ],
  },
  'window.showHide': {
    name: 'window.showHide',
    requiredMethods: ['show', 'hide'],
    semanticChecks: [
      semanticCheck('window.showHide.visibility', 'manual-handoff', 'Can surface or hide the runtime window/view for human handoff.'),
    ],
    degradedModes: ['external-window cannot be programmatically hidden'],
  },
  'window.openPolicy': {
    name: 'window.openPolicy',
    requiredMethods: ['setWindowOpenPolicy', 'getWindowOpenPolicy', 'clearWindowOpenPolicy'],
    semanticChecks: [
      semanticCheck('window.openPolicy.block-or-allow', 'semantic-smoke', 'Applies window.open policy for popups.'),
    ],
    degradedModes: ['runtime-scoped popup policy only'],
  },
  'input.native': {
    name: 'input.native',
    requiredMethods: [
      'native.click',
      'native.move',
      'native.drag',
      'native.type',
      'native.keyPress',
      'native.scroll',
    ],
    semanticChecks: [
      semanticCheck(
        'input.native.trusted-events',
        'semantic-smoke',
        'Generates trusted native input or a declared degraded runtime fallback.',
        'src/core/browser-automation/browser-capability-truth.test.ts'
      ),
    ],
    degradedModes: ['selector-backed fallback'],
    toolRequirements: [
      'browser_act',
      'browser_click_at',
      'browser_scroll_at',
      'browser_drag_to',
      'browser_hover_at',
      'browser_native_type',
      'browser_native_key',
    ],
  },
  'input.touch': {
    name: 'input.touch',
    requiredMethods: ['touchTap', 'touchLongPress', 'touchDrag'],
    semanticChecks: [
      semanticCheck('input.touch.gestures', 'semantic-smoke', 'Dispatches touch tap/long-press/drag gestures.'),
    ],
    degradedModes: ['mouse-backed touch emulation'],
  },
  'text.dom': {
    name: 'text.dom',
    requiredMethods: ['clickText', 'findTextNormalizedDetailed', 'findText', 'textExists'],
    semanticChecks: [
      semanticCheck(
        'text.dom.lookup',
        'semantic-smoke',
        'Finds text through DOM lookup and reports normalized bounds.',
        'src/core/browser-automation/browser-capability-truth.test.ts'
      ),
    ],
    toolRequirements: ['browser_act', 'browser_find_text', 'browser_wait_for'],
  },
  'text.ocr': {
    name: 'text.ocr',
    requiredMethods: ['recognizeText'],
    semanticChecks: [
      semanticCheck('text.ocr.lookup', 'semantic-smoke', 'Recognizes visible text from screenshot/OCR data.'),
    ],
    degradedModes: ['DOM-first lookup with OCR unavailable'],
    toolRequirements: ['browser_act', 'browser_find_text', 'browser_wait_for'],
  },
  'network.capture': {
    name: 'network.capture',
    requiredMethods: [
      'startNetworkCapture',
      'stopNetworkCapture',
      'getNetworkEntries',
      'getNetworkSummary',
      'clearNetworkEntries',
      'waitForResponse',
    ],
    semanticChecks: [
      semanticCheck(
        'network.capture.entries',
        'semantic-smoke',
        'Captures request metadata and summarizes failures/slowness.',
        'src/core/browser-automation/browser-capability-truth.test.ts'
      ),
    ],
    toolRequirements: [
      'browser_network_start',
      'browser_network_stop',
      'browser_network_entries',
      'browser_network_summary',
      'browser_debug_state',
    ],
  },
  'network.responseBody': {
    name: 'network.responseBody',
    requiredMethods: ['getNetworkEntries'],
    semanticChecks: [
      semanticCheck('network.responseBody.body', 'semantic-smoke', 'Captured entries may include responseBody when enabled.'),
    ],
    degradedModes: ['metadata-only network capture'],
    toolRequirements: ['browser_network_entries'],
  },
  'network.sessionRequest': {
    name: 'network.sessionRequest',
    requiredMethods: ['sessionRequest'],
    semanticChecks: [
      semanticCheck(
        'network.sessionRequest.contract',
        'semantic-smoke',
        'Performs a browser-session request without exposing Cookie, Authorization, Set-Cookie, or storage secrets.',
        'src/core/browser-runtime/profile-session-gateway.test.ts'
      ),
      semanticCheck(
        'network.sessionRequest.runtime-spike',
        'runtime-canary',
        'Electron WebContents and Chromium extension relay pass the same ProfileSessionGateway request contract.',
        'src/core/browser-runtime/profile-session-gateway.test.ts'
      ),
    ],
    degradedModes: ['same-origin browser fetch/CORS semantics'],
  },
  'console.capture': {
    name: 'console.capture',
    requiredMethods: [
      'startConsoleCapture',
      'stopConsoleCapture',
      'getConsoleMessages',
      'clearConsoleMessages',
    ],
    semanticChecks: [
      semanticCheck('console.capture.tail', 'semantic-smoke', 'Captures console messages with level and timestamp.'),
    ],
    toolRequirements: [
      'browser_console_start',
      'browser_console_stop',
      'browser_console_get',
      'browser_console_clear',
      'browser_debug_state',
    ],
  },
  'download.manage': {
    name: 'download.manage',
    requiredMethods: ['setDownloadBehavior', 'listDownloads', 'waitForDownload', 'cancelDownload'],
    semanticChecks: [
      semanticCheck('download.manage.lifecycle', 'semantic-smoke', 'Tracks download lifecycle and supports cancellation.'),
    ],
  },
  'dialog.basic': {
    name: 'dialog.basic',
    requiredMethods: ['waitForDialog', 'handleDialog'],
    semanticChecks: [
      semanticCheck('dialog.basic.accept-dismiss', 'semantic-smoke', 'Observes and accepts/dismisses JavaScript dialogs.'),
    ],
  },
  'dialog.promptText': {
    name: 'dialog.promptText',
    requiredMethods: ['waitForDialog', 'handleDialog'],
    semanticChecks: [
      semanticCheck('dialog.promptText.entry', 'semantic-smoke', 'Handles prompt dialogs with user text.'),
    ],
    degradedModes: ['alert/confirm only'],
  },
  'tabs.manage': {
    name: 'tabs.manage',
    requiredMethods: ['listTabs', 'createTab', 'activateTab', 'closeTab'],
    semanticChecks: [
      semanticCheck('tabs.manage.lifecycle', 'semantic-smoke', 'Lists, creates, activates, and closes tabs.'),
    ],
  },
  'events.runtime': {
    name: 'events.runtime',
    requiredMethods: ['onRuntimeEvent'],
    semanticChecks: [
      semanticCheck('events.runtime.subscribe', 'semantic-smoke', 'Subscribes to normalized runtime events.'),
    ],
    degradedModes: ['polling-only lifecycle'],
  },
  'emulation.identity': {
    name: 'emulation.identity',
    requiredMethods: ['setEmulationIdentity', 'clearEmulation'],
    semanticChecks: [
      semanticCheck('emulation.identity.apply', 'semantic-smoke', 'Applies identity overrides and clears them.'),
    ],
    degradedModes: ['startup-only fingerprint identity'],
  },
  'emulation.viewport': {
    name: 'emulation.viewport',
    requiredMethods: ['setViewportEmulation', 'clearEmulation'],
    semanticChecks: [
      semanticCheck('emulation.viewport.apply', 'semantic-smoke', 'Applies viewport emulation and clears it.'),
    ],
    degradedModes: ['window resize only'],
  },
  'intercept.observe': {
    name: 'intercept.observe',
    requiredMethods: [
      'enableRequestInterception',
      'disableRequestInterception',
      'getInterceptedRequests',
      'clearInterceptedRequests',
      'waitForInterceptedRequest',
    ],
    semanticChecks: [
      semanticCheck('intercept.observe.blocked-request', 'semantic-smoke', 'Observes intercepted/paused requests.'),
    ],
    degradedModes: ['metadata-only interception'],
  },
  'intercept.control': {
    name: 'intercept.control',
    requiredMethods: ['continueRequest', 'fulfillRequest', 'failRequest'],
    semanticChecks: [
      semanticCheck('intercept.control.mutate', 'semantic-smoke', 'Continues, fulfills, or fails intercepted requests.'),
    ],
    degradedModes: ['observe-only interception'],
  },
});

export const BROWSER_MINIMAL_CORE_METHODS = Object.freeze([
  'describeRuntime',
  'hasCapability',
  'goto',
  'back',
  'forward',
  'reload',
  'getCurrentUrl',
  'title',
] as const);

export function getBrowserCapabilityContract(
  name: BrowserCapabilityName
): BrowserCapabilityContract {
  return BROWSER_CAPABILITY_CONTRACTS[name];
}

function getPathValue(target: unknown, methodPath: string): unknown {
  return methodPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, target);
}

export function getMissingBrowserCapabilityContractMethods(
  browser: unknown,
  capabilityName: BrowserCapabilityName
): string[] {
  const contract = getBrowserCapabilityContract(capabilityName);
  return contract.requiredMethods.filter((methodPath) => {
    const value = getPathValue(browser, methodPath);
    return typeof value !== 'function';
  });
}

export function validateBrowserCapabilityContracts(): BrowserCapabilityContractValidationIssue[] {
  const issues: BrowserCapabilityContractValidationIssue[] = [];
  for (const capabilityName of BROWSER_CAPABILITY_NAMES) {
    const contract = BROWSER_CAPABILITY_CONTRACTS[capabilityName];
    if (!contract) {
      issues.push({
        code: 'missing_contract',
        capabilityName,
        message: `${capabilityName} is missing a BrowserCapabilityContract`,
      });
      continue;
    }
    if (contract.name !== capabilityName) {
      issues.push({
        code: 'missing_contract',
        capabilityName,
        message: `${capabilityName} contract name does not match its key`,
      });
    }
  }
  return issues;
}

export function validateBrowserRuntimeDescriptorAgainstContract(
  descriptor: BrowserRuntimeDescriptor
): BrowserCapabilityContractValidationIssue[] {
  const issues: BrowserCapabilityContractValidationIssue[] = [];
  const expectedNames = new Set(BROWSER_CAPABILITY_NAMES);
  const actualNames = new Set(Object.keys(descriptor.capabilities));

  for (const capabilityName of expectedNames) {
    const capability = descriptor.capabilities[capabilityName];
    const contract = BROWSER_CAPABILITY_CONTRACTS[capabilityName];
    if (!contract) {
      issues.push({
        code: 'missing_contract',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId}:${capabilityName} is missing a BrowserCapabilityContract`,
      });
      continue;
    }
    if (!capability) {
      issues.push({
        code: 'missing_descriptor_capability',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId} descriptor is missing ${capabilityName}`,
      });
      continue;
    }
    if (capability.supported && capability.stability === 'planned') {
      issues.push({
        code: 'supported_planned',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId}:${capabilityName} cannot be supported while stability=planned`,
      });
    }
    if (!capability.supported && !capability.notes) {
      issues.push({
        code: 'unsupported_without_notes',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId}:${capabilityName} unsupported capability must explain planned, degraded, or runtime-specific fallback state`,
      });
    }
    if (capability.supported && contract.requiredMethods.length === 0) {
      issues.push({
        code: 'supported_without_required_methods',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId}:${capabilityName} is supported but its contract has no required methods`,
      });
    }
    if (capability.supported && contract.semanticChecks.length === 0) {
      issues.push({
        code: 'supported_without_semantic_checks',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId}:${capabilityName} is supported but its contract has no semantic checks`,
      });
    }
  }

  for (const capabilityName of actualNames) {
    if (!expectedNames.has(capabilityName as BrowserCapabilityName)) {
      issues.push({
        code: 'extra_descriptor_capability',
        runtimeId: descriptor.runtimeId,
        capabilityName,
        message: `${descriptor.runtimeId} descriptor declares unknown capability ${capabilityName}`,
      });
    }
  }

  return issues;
}

export function assertBrowserRuntimeDescriptorContract(
  descriptor: BrowserRuntimeDescriptor
): void {
  const issues = [
    ...validateBrowserCapabilityContracts(),
    ...validateBrowserRuntimeDescriptorAgainstContract(descriptor),
  ];
  if (issues.length > 0) {
    throw new Error(
      issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join('\n')
    );
  }
}

export function createBrowserRuntimeCapabilityMatrix(
  descriptors: Iterable<BrowserRuntimeDescriptor>
): BrowserRuntimeCapabilityMatrixRow[] {
  return Array.from(descriptors).flatMap((descriptor) =>
    BROWSER_CAPABILITY_NAMES.map((capabilityName) => {
      const capability = descriptor.capabilities[capabilityName];
      const contract = BROWSER_CAPABILITY_CONTRACTS[capabilityName];
      return {
        runtimeId: descriptor.runtimeId,
        capabilityName,
        supported: capability.supported,
        stability: capability.stability,
        source: capability.source,
        ...(capability.notes ? { notes: capability.notes } : {}),
        requiredMethods: [...contract.requiredMethods],
        semanticChecks: contract.semanticChecks.map((check) => check.id),
        degradedModes: [...(contract.degradedModes || [])],
        toolRequirements: [...(contract.toolRequirements || [])],
      };
    })
  );
}
