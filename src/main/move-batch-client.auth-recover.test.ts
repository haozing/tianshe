import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  createMoveBatchClient,
} = require('../../examples/dywebs-submit-worker/lib/move-batch-client.js');

describe('dycopy auth recover', () => {
  it('recovers through reauthorize and relogin prompts', async () => {
    let probeCount = 0;
    let phase: 'relogin' | 'authorize' | 'done' = 'relogin';
    const clickedTexts: string[] = [];

    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn(async () => {
        if (phase === 'relogin') return 'https://dywebs.xingtaosoft.com/move/batch';
        if (phase === 'authorize') return 'https://fuwu.jinritemai.com/authorize?service_id=25190';
        return 'https://dywebs.xingtaosoft.com/move/batch';
      }),
      getWindowOpenPolicy: vi.fn().mockReturnValue(null),
      setWindowOpenPolicy: vi.fn(),
      clearWindowOpenPolicy: vi.fn(),
      evaluate: vi.fn(async (script: string) => {
        const source = String(script || '');
        if (source.includes('fetch(input.url')) {
          probeCount += 1;
          if (probeCount === 1) {
            return {
              ok: true,
              status: 200,
              json: { retCode: '1501', retMsg: '登录超时，请重新登录' },
              textPreview: '',
            };
          }
          return {
            ok: true,
            status: 200,
            json: { retCode: '0', retMsg: 'ok' },
            textPreview: '',
          };
        }
        return { ok: true };
      }),
      snapshot: vi.fn(async () => {
        if (phase === 'relogin') {
          return { elements: [{ name: '提示 当前登录信息已过期 请重新登录 重新登录' }] };
        }
        if (phase === 'authorize') {
          return { elements: [{ name: '确认授权 授权即代表您已阅读并同意 抖店开放平台授权协议' }] };
        }
        return { elements: [] };
      }),
      clickText: vi.fn(async (text: string) => {
        const value = String(text || '');
        clickedTexts.push(value);
        if (value.includes('重新登录') || value.includes('去登录') || value === '登录') {
          phase = 'authorize';
        }
        if (value.includes('确认授权') || value.includes('同意授权')) {
          phase = 'done';
        }
      }),
    };

    const client = createMoveBatchClient({ browser, onLog: async () => {} });

    const result = await client.ensureDycopyAuth({
      maxRetry: 1,
      verifyIntervalMs: 20,
      timeoutMs: 12000,
    });

    expect(result.ok).toBe(true);
    expect(result.recoverMode).toBe('browser-first');
    expect(result.refreshed).toBe(true);
    expect(result.autoRecover).toBeTruthy();
    expect(result.autoRecover.clickedRelogin).toBe(true);
    expect(probeCount).toBe(2);
    expect(clickedTexts.some((item) => item.includes('重新授权'))).toBe(true);
    expect(clickedTexts.some((item) => item.includes('重新登录'))).toBe(true);
  }, 15000);
});
