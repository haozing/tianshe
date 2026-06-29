import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type NetworkTargetPolicyErrorCode =
  | 'INVALID_URL'
  | 'INVALID_PROTOCOL'
  | 'PRIVATE_NETWORK_URL'
  | 'NETWORK_ERROR';

export class NetworkTargetPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: NetworkTargetPolicyErrorCode,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'NetworkTargetPolicyError';
  }
}

export interface ParsePublicHttpUrlOptions {
  allowHttp?: boolean;
  allowHttps?: boolean;
}

export function parsePublicHttpUrl(
  rawUrl: string,
  options: ParsePublicHttpUrlOptions = {}
): URL {
  const allowHttp = options.allowHttp !== false;
  const allowHttps = options.allowHttps !== false;
  let parsed: URL;

  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new NetworkTargetPolicyError('URL format is invalid', 'INVALID_URL', false);
  }

  const protocolAllowed =
    (allowHttp && parsed.protocol === 'http:') || (allowHttps && parsed.protocol === 'https:');
  if (!protocolAllowed) {
    throw new NetworkTargetPolicyError(
      'URL protocol must be http: or https:',
      'INVALID_PROTOCOL',
      false
    );
  }

  if (!parsed.hostname) {
    throw new NetworkTargetPolicyError('URL hostname is required', 'INVALID_URL', false);
  }

  return parsed;
}

export async function assertPublicHttpTarget(rawUrl: string | URL): Promise<URL> {
  const url = typeof rawUrl === 'string' ? parsePublicHttpUrl(rawUrl) : rawUrl;
  const hostname = normalizeHostname(url.hostname);

  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new NetworkTargetPolicyError(
      'Localhost and private network URLs are not allowed',
      'PRIVATE_NETWORK_URL',
      false
    );
  }

  if (isIP(hostname)) {
    if (isDisallowedNetworkAddress(hostname)) {
      throw new NetworkTargetPolicyError(
        'Localhost and private network URLs are not allowed',
        'PRIVATE_NETWORK_URL',
        false
      );
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new NetworkTargetPolicyError('URL hostname could not be resolved', 'NETWORK_ERROR', true);
  }

  if (addresses.some((entry) => isDisallowedNetworkAddress(entry.address))) {
    throw new NetworkTargetPolicyError(
      'Localhost and private network URLs are not allowed',
      'PRIVATE_NETWORK_URL',
      false
    );
  }

  return url;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

function isDisallowedNetworkAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipVersion = isIP(normalized);

  if (ipVersion === 4) {
    return isDisallowedIPv4Address(normalized);
  }

  if (ipVersion === 6) {
    return isDisallowedIPv6Address(normalized);
  }

  return true;
}

function isDisallowedIPv4Address(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isDisallowedIPv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIPv4 = normalized.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIPv4) {
    return isDisallowedIPv4Address(mappedIPv4[1]);
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  );
}
