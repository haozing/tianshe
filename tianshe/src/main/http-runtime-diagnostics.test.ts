import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeLocalHttpRuntime } from './http-runtime-diagnostics';
import { getRuntimeFingerprint } from './runtime-fingerprint';

describe('probeLocalHttpRuntime', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch as any);
  });

  it('识别当前进程提供的健康 Airpa 服务', async () => {
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
              runtimeAlerts: [{ code: 'queue_depth', severity: 'warning' }],
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
              alerts: [{ code: 'queue_depth', severity: 'warning' }],
            },
          })
        ),
      });

    const result = await probeLocalHttpRuntime({
      metricsHeaders: {
        authorization: 'Bearer runtime-token',
      },
    });

    expect(result.running).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_self',
        owner: 'self',
      })
    );
    expect(result.runtimeAlerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'queue_depth' })])
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/metrics'),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer runtime-token',
        }),
      })
    );
  });

  it('识别端口被另一个 Airpa 进程占用', async () => {
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
          },
        })
      ),
    });

    const result = await probeLocalHttpRuntime();

    expect(result.running).toBe(false);
    expect(result.reachable).toBe(true);
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'healthy_other_airpa',
        owner: 'other_airpa',
      })
    );
  });

  it('识别端口没有监听器', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1'));

    const result = await probeLocalHttpRuntime();

    expect(result.running).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'no_listener',
      })
    );
  });

  it('识别非预期 health 响应', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('<html>not found</html>'),
    });

    const result = await probeLocalHttpRuntime();

    expect(result.running).toBe(false);
    expect(result.reachable).toBe(true);
    expect(result.diagnosis).toEqual(
      expect.objectContaining({
        code: 'unexpected_health_response',
        httpStatus: 404,
      })
    );
  });
});
