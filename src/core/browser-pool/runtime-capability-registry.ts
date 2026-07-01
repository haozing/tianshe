import type {
  BrowserCapabilityDescriptor,
  BrowserCapabilityName,
  BrowserRuntimeDescriptor,
} from '../../types/browser-interface';
import { BROWSER_CAPABILITY_NAMES } from '../../types/browser-interface';
import type {
  BrowserControlProtocol,
  BrowserFamily,
  BrowserFingerprintBackend,
  BrowserProfileMode,
  BrowserRuntimeId,
  BrowserRuntimeSource,
  BrowserVisibilityMode,
} from '../../types/browser-runtime';
import { assertBrowserRuntimeDescriptorContract } from '../browser-runtime/capability-contract';

type StaticDescriptorInput = {
  runtimeId: BrowserRuntimeId;
  browserFamily: BrowserFamily;
  controlProtocol: BrowserControlProtocol;
  profileMode: BrowserProfileMode;
  visibilityMode: BrowserVisibilityMode;
  fingerprintBackend: BrowserFingerprintBackend;
  source: BrowserRuntimeSource;
  supported: Partial<Record<BrowserCapabilityName, boolean>>;
  notes?: Partial<Record<BrowserCapabilityName, string>>;
  stability?: Partial<Record<BrowserCapabilityName, BrowserCapabilityDescriptor['stability']>>;
};

const CAPABILITY_NAME_LIST: BrowserCapabilityName[] = [...BROWSER_CAPABILITY_NAMES];

function createCapabilityMap(
  input: StaticDescriptorInput
): Record<BrowserCapabilityName, BrowserCapabilityDescriptor> {
  return Object.fromEntries(
    CAPABILITY_NAME_LIST.map((name) => [
      name,
      {
        supported: input.supported[name] === true,
        stability:
          input.stability?.[name] ??
          (input.supported[name] === true ? 'stable' : 'planned'),
        source: 'static-runtime',
        ...(input.notes?.[name] ? { notes: input.notes[name] } : {}),
      } satisfies BrowserCapabilityDescriptor,
    ])
  ) as Record<BrowserCapabilityName, BrowserCapabilityDescriptor>;
}

function createStaticDescriptor(input: StaticDescriptorInput): BrowserRuntimeDescriptor {
  return Object.freeze({
    runtimeId: input.runtimeId,
    browserFamily: input.browserFamily,
    controlProtocol: input.controlProtocol,
    profileMode: input.profileMode,
    visibilityMode: input.visibilityMode,
    fingerprintBackend: input.fingerprintBackend,
    source: input.source,
    capabilities: Object.freeze(createCapabilityMap(input)),
  });
}

export const STATIC_BROWSER_RUNTIME_DESCRIPTORS: Record<
  BrowserRuntimeId,
  BrowserRuntimeDescriptor
> = Object.freeze({
  'electron-webcontents': createStaticDescriptor({
    runtimeId: 'electron-webcontents',
    browserFamily: 'electron',
    controlProtocol: 'webcontents',
    profileMode: 'persistent',
    visibilityMode: 'embedded-view',
    fingerprintBackend: 'electron-stealth',
    source: { type: 'bundled' },
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': true,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': true,
      'window.showHide': true,
      'window.openPolicy': true,
      'input.native': true,
      'input.touch': true,
      'text.dom': true,
      'text.ocr': true,
      'network.capture': true,
      'network.sessionRequest': true,
      'console.capture': true,
      'download.manage': true,
      'dialog.basic': false,
      'dialog.promptText': false,
      'emulation.viewport': true,
      'emulation.identity': true,
      'events.runtime': false,
      'intercept.observe': false,
      'intercept.control': false,
    },
    notes: {
      'storage.dom':
        'Electron exposes local/session storage helpers through page evaluateWithArgs on the acquired WebContents.',
      'network.responseBody': 'Electron path does not persist response bodies in capture history.',
      'network.sessionRequest':
        'Electron WebContents performs Profile-bound same-origin fetch through the active page context without returning Cookie, Authorization, Set-Cookie, or browser storage secrets.',
      'input.native':
        'Electron exposes native input through the underlying WebContentsView SimpleBrowser native adapter.',
      'input.touch':
        'Electron touch gestures dispatch CDP Input.dispatchTouchEvent after enabling touch emulation; treat as experimental on real devices.',
      'dialog.basic':
        'Electron runtime does not expose JavaScript dialog interception in the unified browser API.',
      'dialog.promptText':
        'Electron runtime does not expose JavaScript prompt text entry in the unified browser API.',
      'emulation.viewport':
        'Electron viewport emulation is exposed through the legacy CDP-backed emulateDevice path, but it is a browser control capability rather than part of the supported fingerprint contract. Treat real-page results as the source of truth.',
      'emulation.identity':
        'Electron identity emulation is exposed through the legacy session/CDP override path, but it is a browser control capability rather than part of the supported fingerprint contract. Treat real-page results as the source of truth.',
      'tabs.manage': 'Electron automation is scoped to the acquired view, not multi-tab browsing.',
      'events.runtime':
        'Electron does not yet emit normalized BrowserRuntimeEvent subscriptions through the unified runtime API.',
      'intercept.observe':
        'Electron currently exposes rule-based interception only, not blocked-request observation in the unified runtime.',
      'intercept.control':
        'Electron currently does not expose pause/continue request interception control in the unified runtime.',
    },
    stability: {
      'input.touch': 'experimental',
      'network.sessionRequest': 'experimental',
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
    },
  }),
  'chromium-extension-relay': createStaticDescriptor({
    runtimeId: 'chromium-extension-relay',
    browserFamily: 'chromium',
    controlProtocol: 'extension-relay',
    profileMode: 'persistent',
    visibilityMode: 'external-window',
    fingerprintBackend: 'chromium-ruyi-file',
    source: { type: 'bundled' },
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': true,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': false,
      'window.showHide': true,
      'window.openPolicy': true,
      'input.native': true,
      'input.touch': true,
      'text.dom': true,
      'text.ocr': true,
      'network.capture': true,
      'network.responseBody': true,
      'network.sessionRequest': true,
      'console.capture': true,
      'dialog.basic': true,
      'dialog.promptText': false,
      'tabs.manage': true,
      'events.runtime': false,
      'emulation.viewport': true,
      'emulation.identity': true,
      'intercept.observe': true,
      'intercept.control': true,
    },
    stability: {
      'storage.dom': 'experimental',
      'input.touch': 'experimental',
      'network.sessionRequest': 'experimental',
      'dialog.basic': 'experimental',
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
      'intercept.observe': 'experimental',
      'intercept.control': 'experimental',
    },
    notes: {
      'storage.dom':
        'Chromium extension relay exposes local/session storage helpers through bound-tab DOM tasks.',
      'pdf.print':
        'Chromium extension relay does not expose a unified print-to-PDF path.',
      'input.touch':
        'Chromium extension relay dispatches touch gestures through the debugger Input.dispatchTouchEvent path; treat as experimental.',
      'dialog.basic':
        'Basic JavaScript dialog handling is exposed through the Chromium extension debugger relay and remains experimental.',
      'dialog.promptText':
        'Real JavaScript prompt handling through the Chromium extension debugger route is currently too unreliable to expose as a supported unified capability.',
      'download.manage':
        'Chromium extension relay download lifecycle management is not wired into the unified browser API yet.',
      'network.sessionRequest':
        'Chromium extension relay performs Profile-bound same-origin fetch through the bound tab MAIN world without returning Cookie, Authorization, Set-Cookie, or browser storage secrets.',
      'events.runtime':
        'Chromium extension relay does not yet publish normalized runtime event subscriptions through BrowserEventCapability.',
      'emulation.viewport':
        'Chromium extension relay viewport emulation is available as a runtime debugger override after startup, but it is not part of the supported fingerprint contract.',
      'emulation.identity':
        'Chromium extension relay identity emulation is available as a runtime debugger override after startup, but it is not part of the supported fingerprint contract.',
      'intercept.observe':
        'Chromium extension relay blocked-request observation is implemented through the debugger Fetch domain and is scoped to the bound tab.',
      'intercept.control':
        'Chromium extension relay continue/fulfill/fail request control is implemented through the debugger Fetch domain and is scoped to the bound tab.',
    },
  }),
  'firefox-bidi': createStaticDescriptor({
    runtimeId: 'firefox-bidi',
    browserFamily: 'firefox',
    controlProtocol: 'bidi',
    profileMode: 'persistent',
    visibilityMode: 'direct-window',
    fingerprintBackend: 'firefox-fpfile',
    source: { type: 'managed-download', channel: 'firefox' },
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': true,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': true,
      'window.showHide': true,
      'input.native': true,
      'input.touch': true,
      'text.dom': true,
      'text.ocr': true,
      'network.capture': true,
      'network.sessionRequest': false,
      'console.capture': true,
      'window.openPolicy': true,
      'download.manage': true,
      'dialog.basic': true,
      'dialog.promptText': true,
      'tabs.manage': true,
      'events.runtime': true,
      'emulation.viewport': true,
      'emulation.identity': true,
      'intercept.observe': true,
      'intercept.control': true,
    },
    stability: {
      'text.ocr': 'experimental',
      'network.capture': 'experimental',
      'console.capture': 'experimental',
      'window.openPolicy': 'experimental',
      'input.touch': 'experimental',
      'download.manage': 'experimental',
      'pdf.print': 'experimental',
      'dialog.basic': 'experimental',
      'dialog.promptText': 'experimental',
      'tabs.manage': 'experimental',
      'events.runtime': 'experimental',
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
      'intercept.observe': 'experimental',
      'intercept.control': 'experimental',
    },
    notes: {
      'storage.dom':
        'DOM storage helpers are currently surfaced only on the Firefox BiDi runtime.',
      'network.responseBody':
        'Firefox BiDi runtime currently tracks response metadata only, not response bodies.',
      'network.sessionRequest':
        'Firefox BiDi runtime has not passed the Profile-bound sessionRequest contract spike yet.',
      'download.manage':
        'Download tracking is currently exposed through the Firefox BiDi runtime with filesystem-backed completion tracking and best-effort cancellation.',
      'pdf.print':
        'PDF export is exposed through WebDriver BiDi browsingContext.print and returns a Base64-encoded PDF payload.',
      'dialog.basic':
        'Basic JavaScript dialog handling is exposed through the Firefox BiDi runtime and remains experimental.',
      'dialog.promptText':
        'JavaScript prompt text entry is exposed through the Firefox BiDi runtime and remains experimental.',
      'events.runtime':
        'Runtime events are normalized from Firefox BiDi lifecycle and telemetry events instead of exposing raw BiDi methods.',
      'emulation.viewport':
        'Firefox BiDi viewport emulation is exposed as a runtime BiDi path after startup, but it is not part of the supported fingerprint contract.',
      'emulation.identity':
        'Firefox BiDi identity emulation is exposed as a runtime BiDi path after startup, but it is not part of the supported fingerprint contract.',
      'intercept.observe':
        'Blocked-request observation is exposed through Firefox BiDi network interception and remains experimental.',
      'intercept.control':
        'Continue/fulfill/fail request control is exposed through Firefox BiDi network interception and remains experimental.',
    },
  }),
  'chromium-cloak-playwright': createStaticDescriptor({
    runtimeId: 'chromium-cloak-playwright',
    browserFamily: 'chromium',
    controlProtocol: 'playwright',
    profileMode: 'persistent',
    visibilityMode: 'external-window',
    fingerprintBackend: 'cloak-flags',
    source: { type: 'managed-download', channel: 'cloakbrowser' },
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': true,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': false,
      'window.showHide': false,
      'window.openPolicy': false,
      'input.native': true,
      'input.touch': false,
      'text.dom': true,
      'text.ocr': false,
      'network.capture': true,
      'network.responseBody': false,
      'network.sessionRequest': false,
      'console.capture': true,
      'download.manage': false,
      'dialog.basic': false,
      'dialog.promptText': false,
      'tabs.manage': true,
      'events.runtime': false,
      'emulation.viewport': true,
      'emulation.identity': true,
      'intercept.observe': false,
      'intercept.control': false,
    },
    stability: {
      'window.showHide': 'planned',
      'window.openPolicy': 'planned',
      'input.touch': 'planned',
      'text.ocr': 'planned',
      'network.capture': 'experimental',
      'console.capture': 'experimental',
      'download.manage': 'planned',
      'dialog.basic': 'planned',
      'dialog.promptText': 'planned',
      'events.runtime': 'planned',
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
      'intercept.observe': 'planned',
      'intercept.control': 'planned',
    },
    notes: {
      'pdf.print':
        'Cloak Playwright print-to-PDF remains withheld from the unified runtime until filesystem/output semantics are hardened.',
      'window.showHide':
        'Cloak Playwright runs as an external browser; direct show/hide semantics need a window controller.',
      'window.openPolicy':
        'Window open policy requires Playwright context/page event handling before it can be exposed as a stable runtime capability.',
      'input.native':
        'Cloak Playwright currently exposes selector-based click/type/select through the unified API; coordinate-native mouse and keyboard actions are intentionally withheld until the Playwright controller exposes that lower-level surface.',
      'input.touch':
        'Cloak Playwright touch gestures are not exposed through the unified runtime API.',
      'text.ocr':
        'Cloak Playwright does not bundle an OCR-backed text recognition path.',
      'network.responseBody':
        'Cloak Playwright network capture currently exposes metadata only in the unified runtime descriptor.',
      'network.sessionRequest':
        'Cloak Playwright does not expose the Profile-bound sessionRequest contract on the production unified runtime surface yet.',
      'download.manage':
        'Cloak Playwright download lifecycle management is not exposed through the unified runtime API yet.',
      'dialog.basic':
        'Cloak Playwright dialog handling is not exposed through the unified browser API.',
      'dialog.promptText':
        'Cloak Playwright prompt text entry is not exposed through the unified browser API.',
      'events.runtime':
        'Cloak Playwright does not yet emit normalized BrowserRuntimeEvent subscriptions.',
      'intercept.observe':
        'Cloak Playwright request interception observation is not exposed on the production unified runtime surface.',
      'intercept.control':
        'Cloak Playwright request interception mutation is not exposed on the production unified runtime surface.',
    },
  }),
});

for (const descriptor of Object.values(STATIC_BROWSER_RUNTIME_DESCRIPTORS)) {
  assertBrowserRuntimeDescriptorContract(descriptor);
}

export function cloneBrowserRuntimeDescriptor(
  descriptor: BrowserRuntimeDescriptor
): BrowserRuntimeDescriptor {
  return {
    runtimeId: descriptor.runtimeId,
    browserFamily: descriptor.browserFamily,
    controlProtocol: descriptor.controlProtocol,
    profileMode: descriptor.profileMode,
    visibilityMode: descriptor.visibilityMode,
    fingerprintBackend: descriptor.fingerprintBackend,
    source: { ...descriptor.source },
    capabilities: Object.fromEntries(
      Object.entries(descriptor.capabilities).map(([name, value]) => [name, { ...value }])
    ) as Record<BrowserCapabilityName, BrowserCapabilityDescriptor>,
  };
}

export function getStaticRuntimeDescriptor(
  runtimeId: BrowserRuntimeId
): BrowserRuntimeDescriptor {
  return cloneBrowserRuntimeDescriptor(STATIC_BROWSER_RUNTIME_DESCRIPTORS[runtimeId]);
}

export function applyRuntimeCapabilitySupport(
  descriptor: BrowserRuntimeDescriptor,
  overrides: Partial<Record<BrowserCapabilityName, boolean>>,
  options: {
    source?: BrowserCapabilityDescriptor['source'];
    stability?: BrowserCapabilityDescriptor['stability'];
    notes?: Partial<Record<BrowserCapabilityName, string | undefined>>;
  } = {}
): BrowserRuntimeDescriptor {
  const clone = cloneBrowserRuntimeDescriptor(descriptor);
  for (const [name, supported] of Object.entries(overrides) as Array<
    [BrowserCapabilityName, boolean | undefined]
  >) {
    if (typeof supported !== 'boolean') {
      continue;
    }
    clone.capabilities[name] = {
      supported,
      stability:
        options.stability ??
        clone.capabilities[name]?.stability ??
        (supported ? 'stable' : 'planned'),
      source: options.source ?? 'runtime',
      ...(options.notes?.[name] ? { notes: options.notes[name] } : {}),
    };
  }
  return clone;
}

export function browserRuntimeSupports(
  descriptor: BrowserRuntimeDescriptor,
  name: BrowserCapabilityName
): boolean {
  return descriptor.capabilities[name]?.supported === true;
}
