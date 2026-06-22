import {
  ALL_TOOLS,
  BROWSER_TOOLS,
  type BrowserToolName,
  type PublicBrowserToolName,
} from './tool-definitions';
import {
  createBrowserCapabilityRequires,
  type CapabilityMetadata,
} from '../catalog-utils';

const READ_METADATA: CapabilityMetadata = {
  idempotent: true,
  sideEffectLevel: 'none',
  estimatedLatencyMs: 1200,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['browser.read'],
  requires: createBrowserCapabilityRequires(),
};

const WRITE_METADATA: CapabilityMetadata = {
  idempotent: false,
  sideEffectLevel: 'low',
  estimatedLatencyMs: 3000,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['browser.write'],
  requires: createBrowserCapabilityRequires(),
};

const browserMetadata = (
  base: CapabilityMetadata,
  capabilities: Parameters<typeof createBrowserCapabilityRequires>[0]
): CapabilityMetadata => ({
  ...base,
  requires: createBrowserCapabilityRequires(capabilities),
});

type BrowserToolManifestEntry = {
  tool: (typeof ALL_TOOLS)[BrowserToolName];
  metadata: CapabilityMetadata;
  publicMcp: boolean;
};

const PUBLIC_BROWSER_TOOL_NAME_SET = new Set<string>(Object.keys(BROWSER_TOOLS));

export const BROWSER_TOOL_MANIFEST = {
  browser_observe: {
    tool: ALL_TOOLS.browser_observe,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page']),
    publicMcp: true,
  },
  browser_snapshot: {
    tool: ALL_TOOLS.browser_snapshot,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page']),
    publicMcp: true,
  },
  browser_wait_for: {
    tool: ALL_TOOLS.browser_wait_for,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page', 'text.dom']),
    publicMcp: true,
  },
  browser_act: {
    tool: ALL_TOOLS.browser_act,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page', 'text.dom']),
    publicMcp: true,
  },
  browser_evaluate: {
    tool: ALL_TOOLS.browser_evaluate,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_search: {
    tool: ALL_TOOLS.browser_search,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page']),
    publicMcp: true,
  },
  browser_network_start: {
    tool: ALL_TOOLS.browser_network_start,
    metadata: browserMetadata(WRITE_METADATA, ['network.capture']),
    publicMcp: false,
  },
  browser_network_stop: {
    tool: ALL_TOOLS.browser_network_stop,
    metadata: browserMetadata(WRITE_METADATA, ['network.capture']),
    publicMcp: false,
  },
  browser_network_entries: {
    tool: ALL_TOOLS.browser_network_entries,
    metadata: browserMetadata(READ_METADATA, ['network.capture']),
    publicMcp: false,
  },
  browser_network_summary: {
    tool: ALL_TOOLS.browser_network_summary,
    metadata: browserMetadata(READ_METADATA, ['network.capture']),
    publicMcp: false,
  },
  browser_screenshot: {
    tool: ALL_TOOLS.browser_screenshot,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page', 'screenshot.detailed']),
    publicMcp: false,
  },
  browser_debug_state: {
    tool: ALL_TOOLS.browser_debug_state,
    metadata: browserMetadata(READ_METADATA, [
      'snapshot.page',
      'screenshot.detailed',
      'console.capture',
      'network.capture',
    ]),
    publicMcp: true,
  },
  browser_cookies_get: {
    tool: ALL_TOOLS.browser_cookies_get,
    metadata: browserMetadata(READ_METADATA, ['cookies.read', 'cookies.filter']),
    publicMcp: false,
  },
  browser_cookies_set: {
    tool: ALL_TOOLS.browser_cookies_set,
    metadata: browserMetadata(WRITE_METADATA, ['cookies.write']),
    publicMcp: false,
  },
  browser_cookies_clear: {
    tool: ALL_TOOLS.browser_cookies_clear,
    metadata: browserMetadata(WRITE_METADATA, ['cookies.clear']),
    publicMcp: false,
  },
  browser_back: {
    tool: ALL_TOOLS.browser_back,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_forward: {
    tool: ALL_TOOLS.browser_forward,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_reload: {
    tool: ALL_TOOLS.browser_reload,
    metadata: browserMetadata(WRITE_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_get_url: {
    tool: ALL_TOOLS.browser_get_url,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_get_title: {
    tool: ALL_TOOLS.browser_get_title,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
  browser_click_at: {
    tool: ALL_TOOLS.browser_click_at,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_scroll_at: {
    tool: ALL_TOOLS.browser_scroll_at,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_drag_to: {
    tool: ALL_TOOLS.browser_drag_to,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_hover_at: {
    tool: ALL_TOOLS.browser_hover_at,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_native_type: {
    tool: ALL_TOOLS.browser_native_type,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_native_key: {
    tool: ALL_TOOLS.browser_native_key,
    metadata: browserMetadata(WRITE_METADATA, ['input.native']),
    publicMcp: false,
  },
  browser_find_text: {
    tool: ALL_TOOLS.browser_find_text,
    metadata: browserMetadata(READ_METADATA, ['text.dom']),
    publicMcp: false,
  },
  browser_console_start: {
    tool: ALL_TOOLS.browser_console_start,
    metadata: browserMetadata(WRITE_METADATA, ['console.capture']),
    publicMcp: false,
  },
  browser_console_stop: {
    tool: ALL_TOOLS.browser_console_stop,
    metadata: browserMetadata(WRITE_METADATA, ['console.capture']),
    publicMcp: false,
  },
  browser_console_get: {
    tool: ALL_TOOLS.browser_console_get,
    metadata: browserMetadata(READ_METADATA, ['console.capture']),
    publicMcp: false,
  },
  browser_console_clear: {
    tool: ALL_TOOLS.browser_console_clear,
    metadata: browserMetadata(WRITE_METADATA, ['console.capture']),
    publicMcp: false,
  },
  browser_validate_selector: {
    tool: ALL_TOOLS.browser_validate_selector,
    metadata: browserMetadata(READ_METADATA, ['snapshot.page']),
    publicMcp: false,
  },
} as const satisfies Record<BrowserToolName, BrowserToolManifestEntry>;

export const PUBLIC_BROWSER_TOOL_MANIFEST = Object.fromEntries(
  (Object.keys(BROWSER_TOOLS) as PublicBrowserToolName[]).map((toolName) => [
    toolName,
    BROWSER_TOOL_MANIFEST[toolName],
  ])
) as Record<PublicBrowserToolName, BrowserToolManifestEntry>;

export const INTERNAL_BROWSER_TOOL_NAMES = (
  Object.keys(BROWSER_TOOL_MANIFEST) as BrowserToolName[]
).filter((toolName) => !PUBLIC_BROWSER_TOOL_NAME_SET.has(toolName));
