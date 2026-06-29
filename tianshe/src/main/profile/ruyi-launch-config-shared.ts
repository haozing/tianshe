import fs from 'node:fs';
import path from 'node:path';
import type { SessionConfig } from '../../core/browser-pool/types';
import { getExtensionRuyiDir } from './chrome-runtime-shared';
import { materializeChromiumNativeFingerprint } from './native-fingerprint/native-chromium-fingerprint';
import {
  type NativeFingerprintPayload,
  toNativeFingerprintText,
} from './native-fingerprint/native-fingerprint-shared';

export type PreparedRuyiLaunch = {
  arg: string;
  filePath: string;
  source: 'generated-txt';
};

export function buildGeneratedChromiumNativeFingerprint(
  session: SessionConfig
): NativeFingerprintPayload {
  const fingerprint = session.fingerprint;
  if (!fingerprint) {
    throw new Error(
      `Missing fingerprint config for session ${session.id}, cannot generate ruyi payload.`
    );
  }

  return materializeChromiumNativeFingerprint(fingerprint.identity);
}

export function prepareRuyiLaunch(session: SessionConfig): PreparedRuyiLaunch {
  const payload = buildGeneratedChromiumNativeFingerprint(session);

  const ruyiDir = getExtensionRuyiDir(session.id);
  fs.mkdirSync(ruyiDir, { recursive: true });

  const txtPath = path.join(ruyiDir, 'fingerprint.ruyi.txt');
  fs.writeFileSync(txtPath, toNativeFingerprintText(payload), 'utf8');

  return {
    arg: `--ruyi=${JSON.stringify({ ruyiFile: txtPath })}`,
    filePath: txtPath,
    source: 'generated-txt',
  };
}
