import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcMainHandle } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
}));

vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error: unknown) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })),
}));

import { HttpApiIPCHandler } from './http-api-handler';
import { DEFAULT_HTTP_API_CONFIG } from '../../constants/http-api';
import * as httpApiConstants from '../../constants/http-api';
import { getRuntimeFingerprint } from '../runtime-fingerprint';

describe('HttpApiIPCHandler', () => {
  let handlers: Map<string, Function>;
  let storedConfig: Record<string, unknown>;
  let mockStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let mockWebhookSender: { setCallbackUrl: ReturnType<typeof vi.fn> };
  let startHttpServer: ReturnType<typeof vi.fn>;
  let stopHttpServer: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    storedConfig = { ...DEFAULT_HTTP_API_CONFIG };
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch as any);

    mockIpcMainHandle.mockImplementation((channel: string, fn: Function) => {
      handlers.set(channel, fn);
    });

    mockStore = {
      get: vi.fn(() => storedConfig),
      set: vi.fn((_key: string, value: Record<string, unknown>) => {
        storedConfig = value;
      }),
    };
    mockWebhookSender = {
      setCallbackUrl: vi.fn(),
    };
    startHttpServer = vi.fn().mockResolvedValue(undefined);
    stopHttpServer = vi.fn().mockResolvedValue(undefined);

    const handler = new HttpApiIPCHandler(
      mockStore as any,
      mockWebhookSender as any,
      startHttpServer,
      stopHttpServer
    );
    handler.register();
  });

  it('注册 get/set 配置 IPC 处理器', () => {
    expect(handlers.has('http-api:get-config')).toBe(true);
    expect(handlers.has('http-api:set-config')).toBe(true);
    expect(handlers.has('http-api:get-runtime-status')).toBe(true);
    expect(handlers.has('http-api:repair-runtime')).toBe(true);
  });

  it('get-config 会补齐历史配置缺失字段并回写 store', async () => {
    storedConfig = {
      enabled: true,
      enableAuth: false,
      token: 'legacy-token',
      callbackUrl: '',
      enableMcp: true,
      enableDevMode: false,
    };

    const getHandler = handlers.get('http-api:get-config');
    expect(getHandler).toBeTypeOf('function');
    const result = await getHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.storedConfig).toEqual(
      expect.objectContaining({
        mcpRequireAuth: true,
        mcpAllowedOrigins: [],
        enforceOrchestrationScopes: false,
        orchestrationIdempotencyStore: 'memory',
      })
    );
    expect(result.effectiveConfig).toEqual(result.storedConfig);
    expect(result.runtimeOverrides).toEqual({
      enabled: false,
      enableMcp: false,
    });
    expect(mockStore.set).toHaveBeenCalledWith(
      'httpApiConfig',
      expect.objectContaining({
        mcpRequireAuth: true,
        mcpAllowedOrigins: [],
        enforceOrchestrationScopes: false,
        orchestrationIdempotencyStore: 'memory',
      })
    );
  });

  it('get-config 会将 legacy port 归一到当前运行时端口', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      port: 3000,
      enabled: true,
    };

    const getHandler = handlers.get('http-api:get-config');
    expect(getHandler).toBeTypeOf('function');
    const result = await getHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.storedConfig.port).toBe(DEFAULT_HTTP_API_CONFIG.port);
    expect(result.effectiveConfig.port).toBe(DEFAULT_HTTP_API_CONFIG.port);
    expect(mockStore.set).toHaveBeenCalledWith(
      'httpApiConfig',
      expect.objectContaining({
        port: DEFAULT_HTTP_API_CONFIG.port,
      })
    );
  });

  it('get-config 返回已保存配置、生效配置和运行时覆盖标记', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: false,
      enableMcp: false,
    };

    const getOverrideFlagsSpy = vi
      .spyOn(httpApiConstants, 'getHttpApiRuntimeOverrideFlags')
      .mockReturnValue({
        enabled: true,
        enableMcp: true,
      });
    const resolveEffectiveSpy = vi
      .spyOn(httpApiConstants, 'resolveEffectiveHttpApiConfig')
      .mockImplementation((input) => ({
        ...httpApiConstants.normalizeHttpApiConfig(input),
        enabled: true,
        enableMcp: true,
      }));

    const getHandler = handlers.get('http-api:get-config');
    expect(getHandler).toBeTypeOf('function');
    const result = await getHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.storedConfig).toEqual(
      expect.objectContaining({
        enabled: false,
        enableMcp: false,
      })
    );
    expect(result.effectiveConfig).toEqual(
      expect.objectContaining({
        enabled: true,
        enableMcp: true,
      })
    );
    expect(result.runtimeOverrides).toEqual({
      enabled: true,
      enableMcp: true,
    });

    getOverrideFlagsSpy.mockRestore();
    resolveEffectiveSpy.mockRestore();
  });

  it('enabled 从 false 改为 true 时会启动 HTTP 服务', async () => {
    storedConfig = { ...DEFAULT_HTTP_API_CONFIG, enabled: false };

    const setHandler = handlers.get('http-api:set-config');
    expect(setHandler).toBeTypeOf('function');
    const result = await setHandler?.({} as any, { enabled: true });

    expect(result.success).toBe(true);
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(stopHttpServer).not.toHaveBeenCalled();
  });

  it('enabled 从 true 改为 false 时会停止 HTTP 服务', async () => {
    storedConfig = { ...DEFAULT_HTTP_API_CONFIG, enabled: true };

    const setHandler = handlers.get('http-api:set-config');
    expect(setHandler).toBeTypeOf('function');
    const result = await setHandler?.({} as any, { enabled: false });

    expect(result.success).toBe(true);
    expect(stopHttpServer).toHaveBeenCalledTimes(1);
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it('服务启用时修改关键开关会触发重启', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
      enableMcp: true,
      enableAuth: true,
      token: 'token-1',
      mcpRequireAuth: true,
      mcpAllowedOrigins: [],
      enforceOrchestrationScopes: false,
      orchestrationIdempotencyStore: 'memory',
    };

    const setHandler = handlers.get('http-api:set-config');
    expect(setHandler).toBeTypeOf('function');
    const result = await setHandler?.({} as any, {
      mcpRequireAuth: false,
      mcpAllowedOrigins: ['https://trusted.example'],
      enforceOrchestrationScopes: true,
      orchestrationIdempotencyStore: 'duckdb',
    });

    expect(result.success).toBe(true);
    expect(stopHttpServer).toHaveBeenCalledTimes(1);
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(mockStore.set).toHaveBeenCalledWith(
      'httpApiConfig',
      expect.objectContaining({
        mcpRequireAuth: false,
        mcpAllowedOrigins: ['https://trusted.example'],
        enforceOrchestrationScopes: true,
        orchestrationIdempotencyStore: 'duckdb',
      })
    );
  });

  it('get-runtime-status 返回运行中状态与告警摘要', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
      enableAuth: true,
      token: 'runtime-token',
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              status: 'ok',
              name: 'airpa-browser-http',
              processStartTime: getRuntimeFingerprint().processStartTime,
              runtimeAlerts: [{ code: 'queue_overflow_count', severity: 'warning' }],
            },
          })
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              alerts: [{ code: 'queue_overflow_count', severity: 'warning' }],
            },
          })
        ),
      });

    const runtimeHandler = handlers.get('http-api:get-runtime-status');
    expect(runtimeHandler).toBeTypeOf('function');
    const result = await runtimeHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.running).toBe(true);
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_self',
        owner: 'self',
      })
    );
    expect(result.runtimeAlerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'queue_overflow_count' })])
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/metrics'),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer runtime-token',
        }),
      })
    );
  });

  it('get-runtime-status 在服务不可达时返回 running=false', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
    };
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const runtimeHandler = handlers.get('http-api:get-runtime-status');
    expect(runtimeHandler).toBeTypeOf('function');
    const result = await runtimeHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.running).toBe(false);
    expect(result.health).toBeNull();
    expect(result.metrics).toBeNull();
    expect(result.error).toContain('does not currently have a reachable HTTP service');
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'no_listener',
        owner: 'unknown',
      })
    );
  });

  it('get-runtime-status 在端口被其他 Airpa 进程占用时返回运行态诊断', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          success: true,
          data: {
            status: 'ok',
            name: 'airpa-browser-http',
            processStartTime: '2000-01-01T00:00:00.000Z',
            runtimeAlerts: [],
          },
        })
      ),
    });

    const runtimeHandler = handlers.get('http-api:get-runtime-status');
    expect(runtimeHandler).toBeTypeOf('function');
    const result = await runtimeHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.running).toBe(false);
    expect(result.health).toEqual(
      expect.objectContaining({
        status: 'ok',
        processStartTime: '2000-01-01T00:00:00.000Z',
      })
    );
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_other_airpa',
        owner: 'other_airpa',
      })
    );
  });

  it('repair-runtime 会在没有监听器时尝试启动当前 HTTP 服务', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
    };

    mockFetch
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              status: 'ok',
              name: 'airpa-browser-http',
              processStartTime: getRuntimeFingerprint().processStartTime,
              runtimeAlerts: [],
            },
          })
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              alerts: [],
            },
          })
        ),
      });

    const repairHandler = handlers.get('http-api:repair-runtime');
    expect(repairHandler).toBeTypeOf('function');
    const result = await repairHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.action).toBe('started_self');
    expect(result.running).toBe(true);
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(stopHttpServer).not.toHaveBeenCalled();
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_self',
      })
    );
  });

  it('repair-runtime 在端口被其他 Airpa 进程占用时返回阻塞诊断', async () => {
    storedConfig = {
      ...DEFAULT_HTTP_API_CONFIG,
      enabled: true,
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              status: 'ok',
              name: 'airpa-browser-http',
              processStartTime: '2000-01-01T00:00:00.000Z',
              runtimeAlerts: [],
            },
          })
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: {
              status: 'ok',
              name: 'airpa-browser-http',
              processStartTime: '2000-01-01T00:00:00.000Z',
              runtimeAlerts: [],
            },
          })
        ),
      });

    const repairHandler = handlers.get('http-api:repair-runtime');
    expect(repairHandler).toBeTypeOf('function');
    const result = await repairHandler?.({} as any);

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.action).toBe('blocked');
    expect(result.running).toBe(false);
    expect(startHttpServer).not.toHaveBeenCalled();
    expect(stopHttpServer).not.toHaveBeenCalled();
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_other_airpa',
        owner: 'other_airpa',
      })
    );
  });
});
