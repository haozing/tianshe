import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { AIRPA_RUNTIME_CONFIG } from './runtime-config';

export type McpProtocolCompatibilityMode = 'sdk-compatible' | 'strict';

export const MCP_PROTOCOL_COMPATIBILITY_MODE: McpProtocolCompatibilityMode =
  AIRPA_RUNTIME_CONFIG.http.mcpProtocolCompatibilityMode;

// Canonical version exposed by the service in initialize and health responses.
export const MCP_PROTOCOL_UNIFIED_VERSION = LATEST_PROTOCOL_VERSION;

// Versions that the underlying SDK can parse.
export const MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  ...SUPPORTED_PROTOCOL_VERSIONS,
]);

// Versions accepted by this server.
export const MCP_PROTOCOL_ALLOWED_VERSIONS: readonly string[] =
  MCP_PROTOCOL_COMPATIBILITY_MODE === 'strict'
    ? Object.freeze([MCP_PROTOCOL_UNIFIED_VERSION])
    : MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS;

export const MCP_TOOL_SURFACE_META_KEY = 'airpa/toolSurface';

export const isAllowedMcpProtocolVersion = (version: string): boolean =>
  MCP_PROTOCOL_ALLOWED_VERSIONS.includes(version);
