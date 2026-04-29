import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  NetworkTargetPolicyError,
  assertPublicHttpTarget,
  parsePublicHttpUrl,
} from './network-target-policy';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

describe('network target policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses http and https URLs', () => {
    expect(parsePublicHttpUrl('https://example.com/callback').hostname).toBe('example.com');
    expect(parsePublicHttpUrl('http://example.com/callback').protocol).toBe('http:');
  });

  it('rejects unsupported protocols', () => {
    expect(() => parsePublicHttpUrl('file:///etc/passwd')).toThrow(NetworkTargetPolicyError);
  });

  it('rejects direct private and loopback IP targets', async () => {
    await expect(assertPublicHttpTarget('http://127.0.0.1/hook')).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_URL',
    });
    await expect(assertPublicHttpTarget('http://10.0.0.8/hook')).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_URL',
    });
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '192.168.1.8', family: 4 }]);

    await expect(assertPublicHttpTarget('https://callback.example/hook')).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_URL',
    });
  });

  it('allows hostnames that resolve to public addresses', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(assertPublicHttpTarget('https://example.com/hook')).resolves.toMatchObject({
      hostname: 'example.com',
    });
  });
});
