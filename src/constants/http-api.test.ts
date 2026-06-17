import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTP_API_CONFIG,
  describeHttpApiAuthContract,
  normalizeHttpApiConfig,
} from './http-api';

describe('HTTP API auth contract', () => {
  it('describes the default disabled state', () => {
    expect(describeHttpApiAuthContract(DEFAULT_HTTP_API_CONFIG)).toEqual(
      expect.objectContaining({
        mode: 'disabled',
        httpRequiresBearer: false,
        mcpRequiresBearer: false,
        orchestrationRequiresBearer: false,
        warning: 'http-disabled',
      })
    );
  });

  it('makes HTTP enabled no-auth explicit', () => {
    const contract = describeHttpApiAuthContract({
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
      enableAuth: false,
      mcpRequireAuth: true,
    });

    expect(contract).toEqual(
      expect.objectContaining({
        mode: 'no-auth',
        httpRequiresBearer: false,
        mcpRequiresBearer: false,
        orchestrationRequiresBearer: false,
        warning: 'http-no-auth',
      })
    );
    expect(contract.detail).toContain('/api/v1/orchestration/*');
    expect(contract.detail).toContain('/mcp');
    expect(contract.detail).toContain('本机其他进程或容器');
  });

  it('distinguishes token-auth HTTP from optional MCP auth', () => {
    expect(
      describeHttpApiAuthContract({
        ...DEFAULT_HTTP_API_CONFIG,
        enabled: true,
        enableAuth: true,
        token: 'secret',
        mcpRequireAuth: true,
      })
    ).toEqual(
      expect.objectContaining({
        mode: 'token-auth',
        httpRequiresBearer: true,
        mcpRequiresBearer: true,
        orchestrationRequiresBearer: true,
        warning: 'token-required',
      })
    );

    expect(
      describeHttpApiAuthContract({
        ...DEFAULT_HTTP_API_CONFIG,
        enabled: true,
        enableAuth: true,
        token: 'secret',
        mcpRequireAuth: false,
      })
    ).toEqual(
      expect.objectContaining({
        mode: 'token-auth',
        httpRequiresBearer: true,
        mcpRequiresBearer: false,
        orchestrationRequiresBearer: true,
        warning: 'mcp-no-auth',
      })
    );
  });

  it('normalizes legacy values before describing auth', () => {
    const normalized = normalizeHttpApiConfig({ enabled: true, enableAuth: 'yes' as never });

    expect(normalized.enableAuth).toBe(DEFAULT_HTTP_API_CONFIG.enableAuth);
    expect(describeHttpApiAuthContract(normalized).mode).toBe('no-auth');
  });
});
