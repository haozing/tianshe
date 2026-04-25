/**
 * 协议传输层共享类型（MCP / HTTP / capability adapters）
 *
 * 目标：
 * - 作为 transport 层单一类型源，减少 mcp/capabilities 双份定义冗余。
 * - 保持语义中立，不绑定具体协议实现。
 */

import type { BrowserInterface } from '../../../types/browser-interface';
import type { CapabilityCallResult } from '../capabilities/types';
import type {
  OrchestrationBrowserSessionContext,
  OrchestrationMcpSessionGateway,
} from '../orchestration/types';

export type { BrowserInterface };

export interface TransportToolCallParams<TName extends string = string> {
  name: TName;
  arguments: Record<string, unknown>;
}

export type TransportToolCallResult = CapabilityCallResult;

export type TransportBrowserFactory = (options: {
  partition?: string;
  visible?: boolean;
}) => Promise<BrowserInterface>;

export interface TransportToolNamespaces {
  [key: string]: unknown;
}

export interface TransportToolHandlerDependencies extends TransportToolNamespaces {
  browser?: BrowserInterface;
  browserFactory?: TransportBrowserFactory;
  signal?: AbortSignal;
  mcpSessionGateway?: OrchestrationMcpSessionGateway;
  mcpSessionContext?: OrchestrationBrowserSessionContext;
}

export type TransportToolHandler<
  TDeps extends TransportToolHandlerDependencies = TransportToolHandlerDependencies,
  TResult = TransportToolCallResult,
> = (args: Record<string, unknown>, deps: TDeps) => Promise<TResult>;

export type TransportToolHandlerRegistry<
  TDeps extends TransportToolHandlerDependencies = TransportToolHandlerDependencies,
  TResult = TransportToolCallResult,
> = Record<string, TransportToolHandler<TDeps, TResult>>;
