import type { BrowserRuntimeDescriptor } from '../../types/browser-interface';
import type {
  BrowserRuntimeId,
  BrowserRuntimeSource,
} from '../../types/browser-runtime';
import type { SessionConfig, PooledBrowserController } from '../browser-pool/types';

export interface ResolveRuntimeInput {
  runtimeId: BrowserRuntimeId;
  sourceOverride?: BrowserRuntimeSource | null;
}

export interface ResolvedBrowserRuntime {
  runtimeId: BrowserRuntimeId;
  source: BrowserRuntimeSource;
  executablePath?: string;
  version?: string | null;
  installDir?: string;
  userDataDir?: string;
}

export interface BrowserRuntimeProbeResult {
  installed?: boolean;
  healthy: boolean;
  version?: string | null;
  executablePath?: string;
  errors: string[];
  warnings: string[];
  capabilities?: Partial<Record<string, boolean>>;
}

export interface BrowserRuntimeCreateResult {
  browser: PooledBrowserController;
  runtimeId: BrowserRuntimeId;
  runtimeDescriptor: BrowserRuntimeDescriptor;
  resolvedRuntime: ResolvedBrowserRuntime;
  viewId?: string;
}

export interface BrowserRuntimeProvider {
  id: BrowserRuntimeId;
  descriptor: BrowserRuntimeDescriptor;
  resolveRuntime(input: ResolveRuntimeInput): Promise<ResolvedBrowserRuntime>;
  probeRuntime(runtime: ResolvedBrowserRuntime): Promise<BrowserRuntimeProbeResult>;
  installRuntime?(input: ResolveRuntimeInput): Promise<ResolvedBrowserRuntime>;
  create(session: SessionConfig): Promise<BrowserRuntimeCreateResult>;
}
