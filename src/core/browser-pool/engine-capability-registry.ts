import type {
  BrowserCapabilityDescriptor,
  BrowserCapabilityName,
  BrowserEngineName,
  BrowserRuntimeDescriptor,
} from '../../types/browser-interface';
import { BROWSER_CAPABILITY_NAMES } from '../../types/browser-interface';

type StaticDescriptorInput = {
  engine: BrowserEngineName;
  profileMode: BrowserRuntimeDescriptor['profileMode'];
  visibilityMode: BrowserRuntimeDescriptor['visibilityMode'];
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
        source: 'static-engine',
        ...(input.notes?.[name] ? { notes: input.notes[name] } : {}),
      } satisfies BrowserCapabilityDescriptor,
    ])
  ) as Record<BrowserCapabilityName, BrowserCapabilityDescriptor>;
}

function createStaticDescriptor(input: StaticDescriptorInput): BrowserRuntimeDescriptor {
  return Object.freeze({
    engine: input.engine,
    profileMode: input.profileMode,
    visibilityMode: input.visibilityMode,
    capabilities: Object.freeze(createCapabilityMap(input)),
  });
}

export const STATIC_BROWSER_RUNTIME_DESCRIPTORS: Record<
  BrowserEngineName,
  BrowserRuntimeDescriptor
> = Object.freeze({
  electron: createStaticDescriptor({
    engine: 'electron',
    profileMode: 'ephemeral',
    visibilityMode: 'embedded-view',
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': false,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': true,
      'window.showHide': true,
      'window.openPolicy': true,
      'input.native': true,
      'input.touch': false,
      'text.dom': true,
      'text.ocr': true,
      'network.capture': true,
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
      'network.responseBody': 'Electron path does not persist response bodies in capture history.',
      'dialog.basic':
        'Electron runtime does not expose JavaScript dialog interception in the unified browser API.',
      'dialog.promptText':
        'Electron runtime does not expose JavaScript prompt text entry in the unified browser API.',
      'emulation.viewport':
        'Electron viewport emulation is exposed through the legacy CDP-backed emulateDevice path, but it is a browser control capability rather than part of the supported fingerprint contract. Treat real-page results as the source of truth.',
      'emulation.identity':
        'Electron identity emulation is exposed through the legacy session/CDP override path, but it is a browser control capability rather than part of the supported fingerprint contract. Treat real-page results as the source of truth.',
      'tabs.manage': 'Electron automation is scoped to the acquired view, not multi-tab browsing.',
      'intercept.observe':
        'Electron currently exposes rule-based interception only, not blocked-request observation in the unified runtime.',
      'intercept.control':
        'Electron currently does not expose pause/continue request interception control in the unified runtime.',
    },
    stability: {
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
    },
  }),
  extension: createStaticDescriptor({
    engine: 'extension',
    profileMode: 'persistent',
    visibilityMode: 'external-window',
    supported: {
      'cookies.read': true,
      'cookies.write': true,
      'cookies.clear': true,
      'cookies.filter': true,
      'storage.dom': false,
      'userAgent.read': true,
      'snapshot.page': true,
      'screenshot.detailed': true,
      'pdf.print': false,
      'window.showHide': true,
      'window.openPolicy': true,
      'input.native': true,
      'input.touch': false,
      'text.dom': true,
      'text.ocr': true,
      'network.capture': true,
      'network.responseBody': true,
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
      'dialog.basic': 'experimental',
      'emulation.viewport': 'experimental',
      'emulation.identity': 'experimental',
      'intercept.observe': 'experimental',
      'intercept.control': 'experimental',
    },
    notes: {
      'dialog.basic':
        'Basic JavaScript dialog handling is exposed through the Chrome extension debugger relay and remains experimental.',
      'dialog.promptText':
        'Real JavaScript prompt handling through the Chrome extension debugger route is currently too unreliable to expose as a supported unified capability.',
      'emulation.viewport':
        'Extension viewport emulation is available as a runtime debugger override after startup, but it is not part of the supported fingerprint contract. Real-page verification confirmed width/height override and clear-to-baseline behavior; do not treat devicePixelRatio or outer-window metrics as guaranteed.',
      'emulation.identity':
        'Extension identity emulation is available as a runtime debugger override after startup, but it is not part of the supported fingerprint contract. Real-page verification confirmed timezone override and clear-to-baseline behavior; do not treat runtime userAgent or locale override as guaranteed.',
      'intercept.observe':
        'Extension blocked-request observation is implemented through the Chrome debugger Fetch domain and is scoped to the bound tab.',
      'intercept.control':
        'Extension continue/fulfill/fail request control is implemented through the Chrome debugger Fetch domain and is scoped to the bound tab.',
    },
  }),
  ruyi: createStaticDescriptor({
    engine: 'ruyi',
    profileMode: 'persistent',
    visibilityMode: 'direct-window',
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
        'DOM storage helpers are currently surfaced only on the ruyi runtime.',
      'network.responseBody':
        'Firefox BiDi runtime currently tracks response metadata only, not response bodies.',
      'download.manage':
        'Download tracking is currently exposed through the ruyi runtime with filesystem-backed completion tracking and best-effort cancellation.',
      'pdf.print':
        'PDF export is exposed through WebDriver BiDi browsingContext.print and returns a Base64-encoded PDF payload.',
      'dialog.basic':
        'Basic JavaScript dialog handling is exposed through the Firefox BiDi runtime and remains experimental.',
      'dialog.promptText':
        'JavaScript prompt text entry is exposed through the Firefox BiDi runtime and remains experimental.',
      'events.runtime':
        'Runtime events are normalized from Firefox BiDi lifecycle and telemetry events instead of exposing raw BiDi methods.',
      'emulation.viewport':
        'Ruyi viewport emulation is exposed as a runtime BiDi path after startup, but it is not part of the supported fingerprint contract. The current Firefox runtime does not reliably apply viewport overrides in real-page verification, so treat it as best-effort only.',
      'emulation.identity':
        'Ruyi identity emulation is exposed as a runtime BiDi path after startup, but it is not part of the supported fingerprint contract. Real-page verification on the current Firefox runtime only confirmed locale-related behavior; do not treat userAgent/timezone/touch overrides as guaranteed.',
      'intercept.observe':
        'Blocked-request observation is exposed through Firefox BiDi network interception and remains experimental.',
      'intercept.control':
        'Continue/fulfill/fail request control is exposed through Firefox BiDi network interception and remains experimental.',
    },
  }),
});

export function cloneBrowserRuntimeDescriptor(
  descriptor: BrowserRuntimeDescriptor
): BrowserRuntimeDescriptor {
  return {
    engine: descriptor.engine,
    profileMode: descriptor.profileMode,
    visibilityMode: descriptor.visibilityMode,
    capabilities: Object.fromEntries(
      Object.entries(descriptor.capabilities).map(([name, value]) => [name, { ...value }])
    ) as Record<BrowserCapabilityName, BrowserCapabilityDescriptor>,
  };
}

export function getStaticEngineRuntimeDescriptor(
  engine: BrowserEngineName
): BrowserRuntimeDescriptor {
  return cloneBrowserRuntimeDescriptor(STATIC_BROWSER_RUNTIME_DESCRIPTORS[engine]);
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
