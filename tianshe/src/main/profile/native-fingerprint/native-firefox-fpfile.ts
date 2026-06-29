import type { BrowserIdentityProfile } from '../../../types/profile';
import {
  type NativeFingerprintPayload,
  setJoinedPayloadField,
  setPayloadField,
} from './native-fingerprint-shared';

export function materializeFirefoxNativeFingerprint(
  identity: BrowserIdentityProfile
): NativeFingerprintPayload {
  const payload: NativeFingerprintPayload = {};
  const languages = identity.region.languages;
  const webgl = identity.graphics?.webgl;
  const speech = identity.speech;
  const network = identity.network;

  setPayloadField(payload, 'webdriver', identity.automationSignals?.webdriver ?? 0);
  setPayloadField(payload, 'local_webrtc_ipv4', network?.localWebrtcIpv4);
  setPayloadField(payload, 'local_webrtc_ipv6', network?.localWebrtcIpv6);
  setPayloadField(payload, 'public_webrtc_ipv4', network?.publicWebrtcIpv4);
  setPayloadField(payload, 'public_webrtc_ipv6', network?.publicWebrtcIpv6);
  setPayloadField(payload, 'timezone', identity.region.timezone);
  setPayloadField(payload, 'language', languages.join(',') || identity.region.primaryLanguage);
  setJoinedPayloadField(payload, 'speech.voices.local', speech?.localNames, '|');
  setJoinedPayloadField(payload, 'speech.voices.remote', speech?.remoteNames, '|');
  setJoinedPayloadField(payload, 'speech.voices.local.langs', speech?.localLangs, '|');
  setJoinedPayloadField(payload, 'speech.voices.remote.langs', speech?.remoteLangs, '|');
  setPayloadField(payload, 'speech.voices.default.name', speech?.defaultName);
  setPayloadField(payload, 'speech.voices.default.lang', speech?.defaultLang);
  setPayloadField(payload, 'font_system', identity.hardware.fontSystem);
  setPayloadField(payload, 'useragent', identity.hardware.userAgent);
  setPayloadField(payload, 'hardwareConcurrency', identity.hardware.hardwareConcurrency);
  setPayloadField(payload, 'webgl.vendor', webgl?.maskedVendor);
  setPayloadField(payload, 'webgl.renderer', webgl?.maskedRenderer);
  setPayloadField(payload, 'webgl.version', webgl?.version);
  setPayloadField(payload, 'webgl.glsl_version', webgl?.glslVersion);
  setPayloadField(
    payload,
    'webgl.unmasked_vendor',
    webgl?.unmaskedVendor ?? webgl?.maskedVendor
  );
  setPayloadField(
    payload,
    'webgl.unmasked_renderer',
    webgl?.unmaskedRenderer ?? webgl?.maskedRenderer
  );
  setPayloadField(payload, 'webgl.max_texture_size', webgl?.maxTextureSize);
  setPayloadField(payload, 'webgl.max_cube_map_texture_size', webgl?.maxCubeMapTextureSize);
  setPayloadField(payload, 'webgl.max_texture_image_units', webgl?.maxTextureImageUnits);
  setPayloadField(payload, 'webgl.max_vertex_attribs', webgl?.maxVertexAttribs);
  setPayloadField(payload, 'webgl.aliased_point_size_max', webgl?.aliasedPointSizeMax);
  setPayloadField(payload, 'webgl.max_viewport_dim', webgl?.maxViewportDim);
  setPayloadField(payload, 'width', identity.display.width);
  setPayloadField(payload, 'height', identity.display.height);
  setPayloadField(payload, 'canvas', identity.graphics?.canvasSeed);

  return payload;
}
