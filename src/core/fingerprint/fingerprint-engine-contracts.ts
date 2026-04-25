import type { AutomationEngine } from '../../types/automation-engine';

export type FingerprintFieldGroup = {
  label: string;
  fields: string[];
  notes?: string;
};

export type FingerprintActiveInvocationContract = {
  label: string;
  supported: boolean;
  stability: 'stable' | 'experimental' | 'unsupported';
  summary: string;
};

export type FingerprintEngineContract = {
  startupSummary: string;
  startupGuaranteeNote: string;
  startupFieldGroups: FingerprintFieldGroup[];
  requiredPaths: string[];
  activeInvocation: FingerprintActiveInvocationContract[];
};

const FINGERPRINT_ENGINE_CONTRACTS: Record<AutomationEngine, FingerprintEngineContract> = {
  electron: {
    startupSummary:
      'Electron 继续沿用原有 stealth/CDP 投影，不走原生文件注入；启动指纹承诺只对齐现有 Electron 投影与真实页面已验证的字段。',
    startupGuaranteeNote:
      '当前 Electron 真实页面只稳定验证了 UA、platform、timezone、hardwareConcurrency、deviceMemory、screen、maxTouchPoints；languages 与 masked WebGL 仍不应当作强保证。',
    startupFieldGroups: [
      {
        label: 'Navigator / Locale',
        fields: ['userAgent', 'platform', 'platformVersion', 'languages', 'timezone'],
      },
      {
        label: 'Screen / Device',
        fields: [
          'width',
          'height',
          'availWidth',
          'availHeight',
          'colorDepth',
          'pixelRatio',
          'hardwareConcurrency',
          'deviceMemory',
          'touchSupport',
          'maxTouchPoints',
        ],
      },
      {
        label: 'WebGL / Fonts',
        fields: ['webgl.maskedVendor', 'webgl.maskedRenderer', 'webgl.version', 'fonts'],
        notes: '这些字段来自当前 Electron stealth 投影；其中部分字段仍需要以真实页面结果为准。',
      },
    ],
    requiredPaths: [
      'identity.hardware.userAgent',
      'identity.hardware.platform',
      'identity.region.timezone',
      'identity.hardware.hardwareConcurrency',
      'identity.hardware.deviceMemory',
      'identity.display.width',
      'identity.display.height',
      'identity.display.availWidth',
      'identity.display.availHeight',
      'identity.display.colorDepth',
      'identity.display.pixelRatio',
    ],
    activeInvocation: [
      {
        label: '主动调用身份覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Electron 仍有 CDP/session 覆写路径，但这属于浏览器控制能力，不属于指纹契约；需要以真实页面逐项验证具体字段是否生效。',
      },
      {
        label: '主动调用视口覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Electron 仍有 emulateDevice 路径，但这属于浏览器控制能力，不属于指纹契约；需要以真实页面逐项验证 width/height/devicePixelRatio/touch 的实际表现。',
      },
    ],
  },
  extension: {
    startupSummary:
      'Extension 启动指纹仅对齐当前 Chromium 141 runtime 已稳定验证的原生 --ruyi/fp.txt 字段；默认只生成 stable-only 启动字段。',
    startupGuaranteeNote:
      '当前 Chromium runtime 已在真实页面稳定验证 UA、platform、languages、timezone、hardwareConcurrency、deviceMemory、screen、webdriver、WebGL；不要把 locale、pixelRatio、touch、canvas/audio、fonts/textMetrics 或运行时 UA override 当成强保证。',
    startupFieldGroups: [
      {
        label: 'Navigator',
        fields: [
          'webdriver',
          'userAgent',
          'platform',
          'languages',
          'timezone',
          'deviceMemory',
          'hardwareConcurrency',
        ],
      },
      {
        label: 'Screen / Display',
        fields: ['screenWidth', 'screenHeight', 'availWidth', 'availHeight', 'colorDepth'],
      },
      {
        label: 'WebGL',
        fields: [
          'gl_vendor',
          'gl_renderer',
          'gl_version',
          'gl_shading',
          'unmaskedVendor',
          'unmaskedRenderer',
        ],
      },
    ],
    requiredPaths: [
      'identity.hardware.userAgent',
      'identity.hardware.platform',
      'identity.region.primaryLanguage',
      'identity.region.languages',
      'identity.region.timezone',
      'identity.hardware.hardwareConcurrency',
      'identity.hardware.deviceMemory',
      'identity.display.width',
      'identity.display.height',
      'identity.display.availWidth',
      'identity.display.availHeight',
      'identity.display.colorDepth',
      'identity.automationSignals.webdriver',
      'identity.graphics.webgl.maskedVendor',
      'identity.graphics.webgl.maskedRenderer',
      'identity.graphics.webgl.version',
      'identity.graphics.webgl.glslVersion',
      'identity.graphics.webgl.unmaskedVendor',
      'identity.graphics.webgl.unmaskedRenderer',
    ],
    activeInvocation: [
      {
        label: '主动调用身份覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Chromium debugger 路径本身存在，但这不属于指纹契约；真实页面只确认 timezone override 与 clear-to-baseline，可调用不代表 userAgent/locale 一定生效。',
      },
      {
        label: '主动调用视口覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Chromium debugger 视口覆写路径存在，但这不属于指纹契约；真实页面已确认 width/height 可变，devicePixelRatio 与外层窗口尺寸不应当作强保证。',
      },
    ],
  },
  ruyi: {
    startupSummary:
      'Ruyi 启动指纹对齐 firefox-fingerprintBrowser README 描述的 fpfile 字段；当前默认只保留 README 范围内已稳定验证的启动字段。',
    startupGuaranteeNote:
      '当前 Firefox runtime 已在真实页面稳定验证 fpfile 启动真值：WebRTC、UA、timezone、language、speech、canvas、WebGL、screen、hardwareConcurrency、fontSystem、webdriver 均以启动文件为准；不要把 locale、pixelRatio、touch / maxTouchPoints 或运行时 viewport override 当成强保证。',
    startupFieldGroups: [
      {
        label: 'WebRTC / Region',
        fields: [
          'local_webrtc_ipv4',
          'local_webrtc_ipv6',
          'public_webrtc_ipv4',
          'public_webrtc_ipv6',
          'timezone',
          'language',
        ],
      },
      {
        label: 'Speech',
        fields: [
          'speech.voices.local',
          'speech.voices.remote',
          'speech.voices.local.langs',
          'speech.voices.remote.langs',
          'speech.voices.default.name',
          'speech.voices.default.lang',
        ],
      },
      {
        label: 'Browser / Hardware',
        fields: ['userAgent', 'hardwareConcurrency', 'fontSystem', 'webdriver'],
      },
      {
        label: 'Screen / Canvas',
        fields: ['width', 'height', 'canvasSeed'],
      },
      {
        label: 'WebGL',
        fields: [
          'webgl.vendor',
          'webgl.renderer',
          'webgl.version',
          'webgl.glsl_version',
          'webgl.unmasked_vendor',
          'webgl.unmasked_renderer',
          'webgl.max_texture_size',
          'webgl.max_cube_map_texture_size',
          'webgl.max_texture_image_units',
          'webgl.max_vertex_attribs',
          'webgl.aliased_point_size_max',
          'webgl.max_viewport_dim',
        ],
      },
    ],
    requiredPaths: [
      'identity.hardware.userAgent',
      'identity.region.primaryLanguage',
      'identity.region.languages',
      'identity.region.timezone',
      'identity.hardware.hardwareConcurrency',
      'identity.hardware.fontSystem',
      'identity.display.width',
      'identity.display.height',
      'identity.automationSignals.webdriver',
      'identity.graphics.webgl.maskedVendor',
      'identity.graphics.webgl.maskedRenderer',
      'identity.graphics.webgl.version',
    ],
    activeInvocation: [
      {
        label: '主动调用身份覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Firefox BiDi 身份覆写路径本身存在，但这不属于指纹契约；真实页面只确认 locale 路径有观察值，不应把 userAgent/timezone/touch override 当成强保证。',
      },
      {
        label: '主动调用视口覆写',
        supported: true,
        stability: 'experimental',
        summary:
          'Firefox BiDi 视口覆写路径本身存在，但这不属于指纹契约；当前真实页面里 width/height override 仍可能 no-op，devicePixelRatio / touch 也不应当作强保证。',
      },
    ],
  },
};

export function getFingerprintEngineContract(engine: AutomationEngine): FingerprintEngineContract {
  return FINGERPRINT_ENGINE_CONTRACTS[engine];
}

export function getFingerprintRequiredPaths(engine: AutomationEngine): string[] {
  return FINGERPRINT_ENGINE_CONTRACTS[engine].requiredPaths;
}
