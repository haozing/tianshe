import { WEBGL_PARAMS } from './constants';
import type { BrowserFingerprint } from './types';

export function generateWebGLScript(
  webgl: BrowserFingerprint['webgl'],
  noiseSeed?: number
): string {
  // 转义字符串中的特殊字符
  const vendor = webgl.vendor.replace(/'/g, "\\'");
  const renderer = webgl.renderer.replace(/'/g, "\\'");
  const version = webgl.version.replace(/'/g, "\\'");

  // 如果启用噪声，添加噪声生成代码
  const noiseCode =
    noiseSeed !== undefined
      ? `
    // WebGL 噪声生成（确定性）
    function seededRandom(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    const noiseRandom = seededRandom(${noiseSeed});
    const noiseMultiplier = 1 + (noiseRandom() - 0.5) * 0.0001; // 微小噪声 ±0.005%
    const noiseByteDelta = Math.max(1, Math.round(noiseRandom() * 2)); // 1~2
  `
      : '';

  const applyNoise =
    noiseSeed !== undefined
      ? `
        // 对数值类型的参数应用微小噪声
        if (typeof result === 'number' && !Number.isInteger(result)) {
          result = result * noiseMultiplier;
        }
  `
      : '';

  const readPixelsPatch =
    noiseSeed !== undefined
      ? `
      // readPixels 是很多 WebGL 指纹的核心采集点：在不破坏渲染的前提下对输出做极小确定性扰动
      const readPixels = proto.readPixels;
      if (typeof readPixels === 'function') {
        proto.readPixels = function(...args) {
          const out = readPixels.apply(this, args);
          try {
            const pixels = args[5] || args[6]; // WebGL1: (x,y,w,h,format,type,pixels), WebGL2 有 offset
            if (pixels && pixels.buffer && pixels.byteLength && pixels.length) {
              const len = pixels.length >>> 0;
              const r = seededRandom(${noiseSeed} + len);
              const steps = Math.min(6, Math.max(1, Math.floor(len / 2000)));
              for (let i = 0; i < steps; i++) {
                const idx = Math.floor(r() * len) >>> 0;
                if (idx >= len) continue;
                const v = pixels[idx];
                if (typeof v === 'number') {
                  if (pixels instanceof Float32Array || pixels instanceof Float64Array) {
                    pixels[idx] = v + (r() - 0.5) * 1e-7;
                  } else {
                    const next = v + (r() > 0.5 ? noiseByteDelta : -noiseByteDelta);
                    pixels[idx] = Math.max(0, Math.min(255, next));
                  }
                }
              }
            }
          } catch (_e) {}
          return out;
        };
        markNative(proto.readPixels, 'readPixels');
      }
    `
      : '';

  const shadingLanguageVersion =
    webgl.version && webgl.version.toLowerCase().includes('webgl 2')
      ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'
      : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';

  return `
  // WebGL 参数覆盖${noiseSeed !== undefined ? '（含噪声）' : ''}
  (function() {
    const VENDOR = ${WEBGL_PARAMS.UNMASKED_VENDOR_WEBGL};
    const RENDERER = ${WEBGL_PARAMS.UNMASKED_RENDERER_WEBGL};
    const VERSION = ${WEBGL_PARAMS.VERSION};
    const SHADING_LANGUAGE_VERSION = 0x8B8C;
    const MASKED_VENDOR = 0x1F00;
    const MASKED_RENDERER = 0x1F01;
    const MAX_TEXTURE_SIZE = 0x0D33;
    const MAX_RENDERBUFFER_SIZE = 0x84E8;
    const MAX_VIEWPORT_DIMS = 0x0D3A;
    const MAX_VERTEX_UNIFORM_VECTORS = 0x8DFB;
    const MAX_FRAGMENT_UNIFORM_VECTORS = 0x8DFD;
    const MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8B4D;
    const MAX_TEXTURE_IMAGE_UNITS = 0x8872;
    const MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8B4C;
    const MAX_CUBE_MAP_TEXTURE_SIZE = 0x851C;
    const MAX_VARYING_VECTORS = 0x8DFC;
    const MAX_VERTEX_ATTRIBS = 0x8869;
    const ALIASED_LINE_WIDTH_RANGE = 0x846E;
    const ALIASED_POINT_SIZE_RANGE = 0x846D;
    const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info';

    const webglParams = {
      [VENDOR]: '${vendor}',
      [RENDERER]: '${renderer}',
      [VERSION]: '${version}',
      [SHADING_LANGUAGE_VERSION]: '${shadingLanguageVersion}',
      [MASKED_VENDOR]: 'WebKit',
      [MASKED_RENDERER]: 'WebKit WebGL',
    };

    const vendorLower = '${vendor}'.toLowerCase();
    const rendererLower = '${renderer}'.toLowerCase();
    const isNvidia = vendorLower.includes('nvidia');
    const isAmd = vendorLower.includes('amd') || rendererLower.includes('radeon');
    const isIntel =
      vendorLower.includes('intel') || rendererLower.includes('intel') || rendererLower.includes('iris');
    const isApple =
      vendorLower.includes('apple') ||
      rendererLower.includes('apple') ||
      rendererLower.includes('m1') ||
      rendererLower.includes('m2') ||
      rendererLower.includes('m3');
    const isMesa = vendorLower.includes('mesa') || rendererLower.includes('mesa');

    const capsHigh = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 4096,
      maxFragmentUniformVectors: 4096,
      maxCombinedTextureImageUnits: 192,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 32,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const capsMid = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 2048,
      maxFragmentUniformVectors: 2048,
      maxCombinedTextureImageUnits: 128,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 16,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const capsLow = {
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
      maxViewportDims: 8192,
      maxVertexUniformVectors: 2048,
      maxFragmentUniformVectors: 2048,
      maxCombinedTextureImageUnits: 96,
      maxTextureImageUnits: 16,
      maxVertexTextureImageUnits: 16,
      maxCubeMapTextureSize: 8192,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 512,
    };
    const capsApple = {
      maxTextureSize: 16384,
      maxRenderbufferSize: 16384,
      maxViewportDims: 16384,
      maxVertexUniformVectors: 4096,
      maxFragmentUniformVectors: 4096,
      maxCombinedTextureImageUnits: 160,
      maxTextureImageUnits: 32,
      maxVertexTextureImageUnits: 32,
      maxCubeMapTextureSize: 16384,
      maxVaryingVectors: 30,
      maxVertexAttribs: 16,
      maxPointSize: 1024,
    };
    const isHighEnd =
      rendererLower.includes('rtx') ||
      rendererLower.includes('rx ') ||
      rendererLower.includes('radeon') ||
      rendererLower.includes('quadro') ||
      rendererLower.includes('firepro');
    const isMidEnd =
      rendererLower.includes('gtx') ||
      rendererLower.includes('geforce') ||
      rendererLower.includes('vega') ||
      rendererLower.includes('arc');
    const capProfile = (function() {
      if (isApple) return capsApple;
      if (isHighEnd) return capsHigh;
      if (isMidEnd) return capsMid;
      if (isNvidia || isAmd) return capsMid;
      if (isIntel || isMesa) return capsLow;
      return capsLow;
    })();

    const webglCaps = {
      [MAX_TEXTURE_SIZE]: capProfile.maxTextureSize,
      [MAX_RENDERBUFFER_SIZE]: capProfile.maxRenderbufferSize,
      [MAX_VIEWPORT_DIMS]: [capProfile.maxViewportDims, capProfile.maxViewportDims],
      [MAX_VERTEX_UNIFORM_VECTORS]: capProfile.maxVertexUniformVectors,
      [MAX_FRAGMENT_UNIFORM_VECTORS]: capProfile.maxFragmentUniformVectors,
      [MAX_COMBINED_TEXTURE_IMAGE_UNITS]: capProfile.maxCombinedTextureImageUnits,
      [MAX_TEXTURE_IMAGE_UNITS]: capProfile.maxTextureImageUnits,
      [MAX_VERTEX_TEXTURE_IMAGE_UNITS]: capProfile.maxVertexTextureImageUnits,
      [MAX_CUBE_MAP_TEXTURE_SIZE]: capProfile.maxCubeMapTextureSize,
      [MAX_VARYING_VECTORS]: capProfile.maxVaryingVectors,
      [MAX_VERTEX_ATTRIBS]: capProfile.maxVertexAttribs,
      [ALIASED_LINE_WIDTH_RANGE]: [1, 1],
      [ALIASED_POINT_SIZE_RANGE]: [1, capProfile.maxPointSize],
    };

    ${noiseCode}

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const __airpaDebugRendererInfoExt = createDebugRendererInfoExtension();
    function createDebugRendererInfoExtension() {
      return {
        UNMASKED_VENDOR_WEBGL: VENDOR,
        UNMASKED_RENDERER_WEBGL: RENDERER,
      };
    }

    function patchContext(proto, label) {
      if (!proto) return;

      const getSupportedExtensions = proto.getSupportedExtensions;
      if (typeof getSupportedExtensions === 'function') {
        proto.getSupportedExtensions = function() {
          let list;
          try {
            list = getSupportedExtensions.call(this);
          } catch (_e) {
            list = null;
          }

          const arr = Array.isArray(list) ? [...list] : [];
          if (!arr.some((e) => String(e || '').toLowerCase() === DEBUG_RENDERER_INFO.toLowerCase())) {
            arr.push(DEBUG_RENDERER_INFO);
          }
          return arr;
        };
        markNative(proto.getSupportedExtensions, 'getSupportedExtensions');
      }

      const getParameter = proto.getParameter;
      if (typeof getParameter === 'function') {
        proto.getParameter = function(param) {
          if (param in webglParams) return webglParams[param];
          var result = getParameter.call(this, param);
          if (param in webglCaps) {
            const override = webglCaps[param];
            if (typeof override === 'number') {
              if (typeof result === 'number' && Number.isFinite(result)) {
                return Math.min(override, result);
              }
              return override;
            }
            if (Array.isArray(override)) {
              const out = [];
              const length = override.length;
              for (let i = 0; i < length; i++) {
                const originalValue = result && typeof result[i] === 'number' ? result[i] : undefined;
                out[i] =
                  typeof originalValue === 'number' ? Math.min(override[i], originalValue) : override[i];
              }
              if (typeof Int32Array !== 'undefined' && result instanceof Int32Array) {
                return new Int32Array(out);
              }
              if (typeof Float32Array !== 'undefined' && result instanceof Float32Array) {
                return new Float32Array(out);
              }
              return out;
            }
          }
          ${applyNoise}
          return result;
        };
        markNative(proto.getParameter, 'getParameter');
      }

      const getExtension = proto.getExtension;
      if (typeof getExtension === 'function') {
        proto.getExtension = function(name) {
          try {
            const normalized = String(name || '').trim().toLowerCase();
            if (normalized === DEBUG_RENDERER_INFO.toLowerCase()) {
              return __airpaDebugRendererInfoExt;
            }
          } catch (_e) {}
          return getExtension.call(this, name);
        };
        markNative(proto.getExtension, 'getExtension');
      }

      ${readPixelsPatch}
    }

    // WebGL 1.0
    try {
      if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext && WebGLRenderingContext.prototype) {
        patchContext(WebGLRenderingContext.prototype, 'webgl1');
      }
    } catch (_e) {}

    // WebGL 2.0
    try {
      if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext && WebGL2RenderingContext.prototype) {
        patchContext(WebGL2RenderingContext.prototype, 'webgl2');
      }
    } catch (_e) {}
  })();
  `;
}

// ========== Webdriver 隐藏脚本 ==========

/**
 * 生成 navigator.webdriver 隐藏脚本
 *
 * @returns JavaScript 代码字符串
 */
