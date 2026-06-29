export type RuntimeCatalogArtifactKind = 'runtime_plugin';

export interface RuntimeCatalogCapabilityState {
  loading: boolean;
  actions: {
    view: boolean;
    install: boolean;
    use: boolean;
    cache: boolean;
  };
  policyVersion?: string;
  error?: string;
}

export const EMPTY_RUNTIME_CATALOG_CAPABILITIES: RuntimeCatalogCapabilityState = {
  loading: false,
  actions: {
    view: false,
    install: false,
    use: false,
    cache: false,
  },
  policyVersion: undefined,
  error: undefined,
};

export function formatRuntimeInstallReason(reason?: string): string {
  const code = String(reason || '').trim().toUpperCase();
  switch (code) {
    case 'OK':
      return '可安装';
    case 'CLIENT_VERSION_TOO_LOW':
      return '客户端版本过低';
    case 'CLIENT_VERSION_REQUIRED':
      return '缺少客户端版本信息';
    case 'PLUGIN_NOT_PUBLISHED':
      return '插件未发布或已禁用';
    case 'ORG_DENIED':
      return '当前账号不在安装授权范围内';
    case 'PROFILE_DENIED':
      return '当前身份不在安装授权范围内';
    case 'PLUGIN_NOT_FOUND':
      return '插件不存在';
    case 'INSTALL_PERMISSION_DENIED':
      return '当前账号无安装权限';
    case 'MANIFEST_ID_MISMATCH':
      return '插件身份校验失败';
    case 'ALREADY_LATEST':
      return '当前已经是最新版本';
    case 'LOCAL_VERSION_NEWER':
      return '本地版本高于云端版本';
    case 'PLUGIN_RUNTIME_DOWNLOAD_SECRET_NOT_CONFIGURED':
      return '服务端未配置扩展下载签名密钥';
    default:
      return String(reason || '').trim() || '安装失败';
  }
}
