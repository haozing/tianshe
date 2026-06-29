import type { BrowserIdentityProfile } from '../../../types/profile';
import {
  type NativeFingerprintPayload,
  setJoinedPayloadField,
  setPayloadField,
} from './native-fingerprint-shared';

export function materializeChromiumNativeFingerprint(
  identity: BrowserIdentityProfile
): NativeFingerprintPayload {
  const payload: NativeFingerprintPayload = {};
  const languages = identity.region.languages;
  const primaryLanguage = identity.region.primaryLanguage || languages[0] || '';
  const display = identity.display;
  const webgl = identity.graphics?.webgl;

  setPayloadField(payload, 'webdriver', identity.automationSignals?.webdriver ?? 0);
  setPayloadField(payload, 'useragent', identity.hardware.userAgent);
  setPayloadField(payload, 'platform', identity.hardware.platform);
  setPayloadField(payload, 'language', primaryLanguage);
  setJoinedPayloadField(payload, 'languages', languages, ',');
  setJoinedPayloadField(payload, 'langugages', languages, ',');
  setPayloadField(payload, 'timezone', identity.region.timezone);
  setPayloadField(payload, 'screenWidth', display.width);
  setPayloadField(payload, 'screenHeight', display.height);
  setPayloadField(payload, 'avaiScreenWidth', display.availWidth ?? display.width);
  setPayloadField(payload, 'avaiScreenHeight', display.availHeight ?? display.height);
  setPayloadField(payload, 'avaiscreenWidth', display.availWidth ?? display.width);
  setPayloadField(payload, 'avaiscreenHeight', display.availHeight ?? display.height);
  setPayloadField(payload, 'colorDepth', display.colorDepth);
  setPayloadField(payload, 'hardwareConcurrency', identity.hardware.hardwareConcurrency);
  setPayloadField(payload, 'deviceMemory', identity.hardware.deviceMemory);
  setPayloadField(payload, 'unmaskedVendor', webgl?.unmaskedVendor ?? webgl?.maskedVendor);
  setPayloadField(payload, 'unmaskedRenderer', webgl?.unmaskedRenderer ?? webgl?.maskedRenderer);
  setPayloadField(payload, 'gl_vendor', webgl?.maskedVendor);
  setPayloadField(payload, 'gl_renderer', webgl?.maskedRenderer);
  setPayloadField(payload, 'gl_version', webgl?.version);
  setPayloadField(payload, 'gl_shading', webgl?.glslVersion);

  return payload;
}
