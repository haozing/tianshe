import crypto from 'node:crypto';
import os from 'node:os';

export interface DeviceFingerprintResult {
  fingerprint: string;
  source: 'fallback';
  warning?: string;
}

function getFallbackHardwareInfo(): {
  macAddress: string;
  cpuModel: string;
  hostname: string;
  platform: string;
} {
  const hostname = os.hostname();
  const platform = process.platform;
  const cpuModel = os.cpus()?.[0]?.model || 'Unknown';

  let macAddress = '00:00:00:00:00:00';
  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries || []) {
        if (!net || net.internal) continue;
        const mac = String(net.mac || '').toLowerCase();
        if (mac && mac !== '00:00:00:00:00:00') {
          macAddress = mac;
          break;
        }
      }
      if (macAddress !== '00:00:00:00:00:00') break;
    }
  } catch {
    // ignore and keep default macAddress
  }

  return { macAddress, cpuModel, hostname, platform };
}

export async function getDeviceFingerprint(): Promise<DeviceFingerprintResult> {
  const hwInfo = getFallbackHardwareInfo();
  const combined = `${hwInfo.macAddress}|${hwInfo.cpuModel}|${hwInfo.hostname}|${hwInfo.platform}`;
  const fingerprint = crypto.createHash('sha256').update(combined).digest('hex');

  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Invalid fingerprint format from fallback generator');
  }

  return {
    fingerprint,
    source: 'fallback',
    warning: 'Native security module is removed; using fallback fingerprint.',
  };
}

export async function resolveDeviceFingerprint(value?: string | null): Promise<string> {
  const normalized = String(value || '').trim();
  if (normalized) {
    return normalized;
  }

  const resolved = await getDeviceFingerprint();
  const fingerprint = String(resolved.fingerprint || '').trim();
  if (!fingerprint) {
    throw new Error('机器码为空，请先获取设备指纹');
  }
  return fingerprint;
}
