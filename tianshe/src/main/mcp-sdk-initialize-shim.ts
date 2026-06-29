import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { InitializeRequest, InitializeResult, Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

interface ServerWithPrivateInitialize {
  _oninitialize?: unknown;
}

export type McpSdkInitializeShimMode =
  | 'private_slot'
  | 'fallback_unknown_sdk_version'
  | 'fallback_missing_private_slot';

export interface McpSdkInitializeShimStatus {
  sdkVersion: string | null;
  privateSlot: typeof MCP_SDK_PRIVATE_INITIALIZE_SLOT;
  mode: McpSdkInitializeShimMode;
  degraded: boolean;
  fingerprintInjected: boolean;
  reason: string | null;
}

export interface McpSdkInitializeShim {
  status: McpSdkInitializeShimStatus;
  initialize: (request: InitializeRequest) => Promise<InitializeResult>;
}

interface CreateSdkInitializeShimOptions {
  serverInfo: Implementation;
  capabilities: ServerCapabilities;
  instructions?: string;
}

export const MCP_SDK_PRIVATE_INITIALIZE_SLOT = '_oninitialize';
export const MCP_SDK_PRIVATE_INITIALIZE_TESTED_VERSIONS = ['1.25.1', '1.29.0'] as const;

const nodeRequire = createRequire(__filename);
let cachedSdkVersion: string | null | undefined;

const createInitializeContractError = (reason: string): Error =>
  new Error(
    `Unsupported @modelcontextprotocol/sdk Server contract: ${reason}. Update ${MCP_SDK_PRIVATE_INITIALIZE_SLOT} shim handling before upgrading the SDK.`
  );

const isTestedSdkVersion = (version: string | null): boolean =>
  Boolean(
    version &&
      (MCP_SDK_PRIVATE_INITIALIZE_TESTED_VERSIONS as readonly string[]).includes(version.trim())
  );

const resolveSdkPackageJsonPath = (): string | null => {
  try {
    const serverEntry = nodeRequire.resolve('@modelcontextprotocol/sdk/server/index.js');
    const candidate = path.resolve(path.dirname(serverEntry), '../../../package.json');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
};

export const readMcpSdkVersion = (): string | null => {
  if (cachedSdkVersion !== undefined) {
    return cachedSdkVersion;
  }

  const packageJsonPath = resolveSdkPackageJsonPath();
  if (!packageJsonPath) {
    cachedSdkVersion = null;
    return cachedSdkVersion;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    cachedSdkVersion = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
  } catch {
    cachedSdkVersion = null;
  }

  return cachedSdkVersion;
};

const createSyntheticInitializeResult = (
  request: InitializeRequest,
  options: CreateSdkInitializeShimOptions
): InitializeResult => ({
  protocolVersion: request.params.protocolVersion,
  serverInfo: options.serverInfo,
  capabilities: options.capabilities,
  ...(options.instructions ? { instructions: options.instructions } : {}),
});

const resolvePrivateInitializeCandidate = (
  server: Server | undefined
): ((request: InitializeRequest) => Promise<InitializeResult>) | undefined => {
  if (!server) {
    return undefined;
  }

  const candidate = (server as unknown as ServerWithPrivateInitialize)[MCP_SDK_PRIVATE_INITIALIZE_SLOT];
  if (typeof candidate !== 'function') {
    return undefined;
  }

  return candidate.bind(server) as (request: InitializeRequest) => Promise<InitializeResult>;
};

const createShimProbeServer = (): Server =>
  new Server(
    {
      name: 'airpa-shim-probe',
      version: '0.0.0',
    },
    {
      capabilities: {},
    }
  );

export const getSdkPrivateInitializeHandler = (
  server: Server
): ((request: InitializeRequest) => Promise<InitializeResult>) => {
  const candidate = resolvePrivateInitializeCandidate(server);
  if (!candidate) {
    throw createInitializeContractError(`private ${MCP_SDK_PRIVATE_INITIALIZE_SLOT} handler is missing`);
  }

  return candidate;
};

export const getMcpSdkInitializeShimStatus = (server?: Server): McpSdkInitializeShimStatus => {
  const sdkVersion = readMcpSdkVersion();
  if (!sdkVersion) {
    return {
      sdkVersion: null,
      privateSlot: MCP_SDK_PRIVATE_INITIALIZE_SLOT,
      mode: 'fallback_unknown_sdk_version',
      degraded: true,
      fingerprintInjected: false,
      reason: 'Unable to resolve @modelcontextprotocol/sdk package version; initialize will fall back to synthesized results.',
    };
  }

  const probeServer = server || createShimProbeServer();
  if (!resolvePrivateInitializeCandidate(probeServer)) {
    return {
      sdkVersion,
      privateSlot: MCP_SDK_PRIVATE_INITIALIZE_SLOT,
      mode: 'fallback_missing_private_slot',
      degraded: true,
      fingerprintInjected: false,
      reason: `SDK version ${sdkVersion} does not expose private ${MCP_SDK_PRIVATE_INITIALIZE_SLOT} on the Server instance.`,
    };
  }

  return {
    sdkVersion,
    privateSlot: MCP_SDK_PRIVATE_INITIALIZE_SLOT,
    mode: 'private_slot',
    degraded: false,
    fingerprintInjected: true,
    reason: isTestedSdkVersion(sdkVersion)
      ? null
      : `SDK version ${sdkVersion} is outside the tested initialize shim list (${MCP_SDK_PRIVATE_INITIALIZE_TESTED_VERSIONS.join(', ')}), but runtime probing confirmed private ${MCP_SDK_PRIVATE_INITIALIZE_SLOT}. Keep contract tests green before upgrading further.`,
  };
};

export const createSdkInitializeShim = (
  server: Server,
  options: CreateSdkInitializeShimOptions
): McpSdkInitializeShim => {
  const status = getMcpSdkInitializeShimStatus(server);
  if (status.mode === 'private_slot') {
    return {
      status,
      initialize: getSdkPrivateInitializeHandler(server),
    };
  }

  return {
    status,
    initialize: async (request) => createSyntheticInitializeResult(request, options),
  };
};
