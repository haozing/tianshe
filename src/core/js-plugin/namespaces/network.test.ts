/**
 * NetworkNamespace 单元测试
 *
 * 测试重点：
 * - webhook 请求
 * - HTTP 方法 (get, post, put, delete)
 * - 超时处理
 * - 错误处理
 * - 响应解析
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NetworkNamespace } from './network';

// Mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock errors
vi.mock('../errors', () => ({
  NetworkError: class NetworkError extends Error {
    constructor(
      message: string,
      public details?: any,
      public cause?: Error
    ) {
      super(message);
      this.name = 'NetworkError';
    }
  },
  TimeoutError: class TimeoutError extends Error {
    constructor(operation: string, timeout: number) {
      super(`${operation} timed out after ${timeout}ms`);
      this.name = 'TimeoutError';
    }
  },
}));

// Mock validators
vi.mock('../validators', () => ({
  ParamValidator: {
    validateURL: vi.fn().mockImplementation((url: any) => {
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL');
      }
      try {
        new URL(url);
      } catch {
        throw new Error('Invalid URL format');
      }
    }),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NetworkNamespace', () => {
  let network: NetworkNamespace;

  beforeEach(() => {
    network = new NetworkNamespace('test-plugin');
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========== webhook ==========
  describe('webhook', () => {
    it('应该发送 POST 请求', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ success: true }),
      });

      const result = await network.webhook('https://api.example.com/webhook', { data: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ data: 'test' }),
        })
      );
      expect(result).toEqual({ success: true });
    });

    it('应该支持自定义请求头', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await network.webhook(
        'https://api.example.com/webhook',
        {},
        {
          headers: { Authorization: 'Bearer token123' },
        }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        })
      );
    });

    it('应该支持自定义 HTTP 方法', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'OK',
      });

      await network.webhook('https://api.example.com/endpoint', null, { method: 'PUT' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
        })
      );
    });

    it('应该解析 JSON 响应', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ key: 'value' }),
      });

      const result = await network.webhook('https://api.example.com/json', {});

      expect(result).toEqual({ key: 'value' });
    });

    it('应该解析文本响应', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'Plain text response',
      });

      const result = await network.webhook('https://api.example.com/text', {});

      expect(result).toBe('Plain text response');
    });

    it('HTTP 错误应该抛出 NetworkError', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
      });

      await expect(network.webhook('https://api.example.com/error', {})).rejects.toThrow('500');
    });

    it('网络错误应该抛出 NetworkError', async () => {
      mockFetch.mockRejectedValue(new Error('Network unreachable'));

      await expect(network.webhook('https://api.example.com/unreachable', {})).rejects.toThrow(
        'Network unreachable'
      );
    });

    it('超时应该抛出 TimeoutError', async () => {
      // 模拟 AbortError
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      await expect(
        network.webhook('https://api.example.com/slow', {}, { timeout: 100 })
      ).rejects.toThrow('timed out');
    });
  });

  // ========== get ==========
  describe('get', () => {
    it('应该发送 GET 请求', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'result' }),
      });

      const result = await network.get('https://api.example.com/data');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'GET',
        })
      );
      expect(result).toEqual({ data: 'result' });
    });

    it('GET 请求不应该包含 body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await network.get('https://api.example.com/data');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: undefined,
        })
      );
    });
  });

  // ========== post ==========
  describe('post', () => {
    it('应该发送 POST 请求', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ id: 123 }),
      });

      const result = await network.post('https://api.example.com/create', { name: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/create',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
        })
      );
      expect(result).toEqual({ id: 123 });
    });
  });

  // ========== put ==========
  describe('put', () => {
    it('应该发送 PUT 请求', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ updated: true }),
      });

      const result = await network.put('https://api.example.com/update/123', { status: 'active' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/update/123',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ status: 'active' }),
        })
      );
      expect(result).toEqual({ updated: true });
    });
  });

  // ========== delete ==========
  describe('delete', () => {
    it('应该发送 DELETE 请求', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => '',
      });

      await network.delete('https://api.example.com/delete/123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/delete/123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  // ========== 默认请求头 ==========
  describe('默认请求头', () => {
    it('应该包含 Content-Type 和 User-Agent', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await network.webhook('https://api.example.com/test', {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'User-Agent': 'Airpa-JS-Plugin',
          }),
        })
      );
    });
  });
});
