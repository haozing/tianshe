import type { IpcRenderer, IpcRendererEvent } from 'electron';

export function createCloudAPI(ipcRenderer: IpcRenderer) {
  return {
  // ========== 云端登录（private admin） ==========

  cloudAuth: {
    /**
     * 获取当前登录会话
     */
    getSession: (): Promise<{
      success: boolean;
      data?: {
        loggedIn: boolean;
        authRevision: number;
        expire?: string;
        user?: {
          userId: number;
          userName: string;
          name?: string;
          deptId?: number;
          avatar?: string;
          roles?: string[];
        };
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:get-session');
    },

    /**
     * 监听云端会话变化
     */
    onSessionChanged: (
      callback: (event: {
        session: {
          loggedIn: boolean;
          authRevision: number;
          expire?: string;
          user?: {
            userId: number;
            userName: string;
            name?: string;
            deptId?: number;
            avatar?: string;
            roles?: string[];
          };
        };
        reason: 'login' | 'logout' | 'expired' | 'remote_unauthorized' | 'workbench_sync_failed';
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, payload: any) => callback(payload);
      ipcRenderer.on('cloud-auth:session-changed', subscription);
      return () => {
        ipcRenderer.removeListener('cloud-auth:session-changed', subscription);
      };
    },

    /**
     * 拉取验证码
     */
    getCaptcha: (): Promise<{
      success: boolean;
      data?: {
        uuid: string;
        imageBase64: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:get-captcha');
    },

    /**
     * 登录云端
     */
    login: (params: {
      username: string;
      password: string;
      captchaCode?: string;
      captchaUuid?: string;
    }): Promise<{
      success: boolean;
      data?: {
        loggedIn: boolean;
        authRevision: number;
        expire?: string;
        user?: {
          userId: number;
          userName: string;
          name?: string;
          deptId?: number;
          avatar?: string;
          roles?: string[];
        };
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:login', params);
    },

    /**
     * 退出登录
     */
    logout: (): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-auth:logout');
    },
  },

  // ========== 云端快照（Profile 配置 + Cookie） ==========

  cloudSnapshot: {
    /**
     * 获取当前会话的云端快照能力（view/cache/edit/delete）
     */
    getCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        profile: {
          view: boolean;
          cache: boolean;
          edit: boolean;
          delete: boolean;
        };
        account: {
          view: boolean;
          cache: boolean;
          edit: boolean;
          delete: boolean;
        };
        scopes?: Array<{
          scopeType?: string;
          scopeId?: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-capabilities', options);
    },

    /**
     * 获取公共云配置列表（需登录）
     */
    getActiveScope: (options?: {
      forceRefreshCapabilities?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        activeScope: {
          scopeType: string;
          scopeId: number;
        };
        availableScopes: Array<{
          scopeType: string;
          scopeId: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-active-scope', options);
    },

    setActiveScope: (
      input?: {
        scopeType?: string;
        scopeId?: number;
      } | null
    ): Promise<{
      success: boolean;
      data?: {
        capabilities: {
          profile: {
            view: boolean;
            cache: boolean;
            edit: boolean;
            delete: boolean;
          };
          account: {
            view: boolean;
            cache: boolean;
            edit: boolean;
            delete: boolean;
          };
          scopes?: Array<{
            scopeType?: string;
            scopeId?: number;
          }>;
        };
        activeScope: {
          scopeType: string;
          scopeId: number;
        };
        availableScopes: Array<{
          scopeType: string;
          scopeId: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:set-active-scope', input);
    },

    listPublic: (params?: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          profileUid?: string;
          cloudUid: string;
          name: string;
          engine: 'electron' | 'extension' | 'ruyi';
          ownerUserId: number;
          ownerUserName?: string;
          visibility: 'public' | 'private';
          version: number;
          updatedAt: string;
          lastSyncedAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:list-public', params);
    },

    /**
     * 获取我的云配置列表（需登录）
     */
    listMine: (params?: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          profileUid?: string;
          cloudUid: string;
          name: string;
          engine: 'electron' | 'extension' | 'ruyi';
          ownerUserId: number;
          ownerUserName?: string;
          visibility: 'public' | 'private';
          version: number;
          updatedAt: string;
          lastSyncedAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:list-mine', params);
    },

    /**
     * 拉取账号共享快照并应用到本地（账号/平台/标签）
     */
    pullAccountBundle: (): Promise<{
      success: boolean;
      data?: {
        snapshotUid?: string;
        schemaVersion: number;
        version: number;
        contentHash?: string;
        accountCount: number;
        siteCount: number;
        tagCount: number;
        unresolvedProfileRefs: Array<{
          profileUid?: string;
          cloudUid?: string;
        }>;
        applied: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:pull-account-bundle');
    },

    /**
     * 将云端 Profile 拉取到本地
     */
    pullProfile: (
      cloudUid: string,
      options?: { forceCreate?: boolean; targetLocalProfileId?: string }
    ): Promise<{
      success: boolean;
      data?: {
        profileUid?: string;
        cloudUid: string;
        localProfileId: string;
        version: number;
        createdLocal: boolean;
        importedCookies: number;
        downloadedExtensions?: number;
        boundExtensions?: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:pull-profile', cloudUid, options);
    },

    /**
     * 获取本地云同步映射
     */
    pushProfile: (
      localProfileId: string,
      options?: { deviceFingerprint?: string; onConflict?: 'error' | 'overwrite' }
    ): Promise<{
      success: boolean;
      data?: {
        profileId: string;
        profileUid?: string;
        cloudUid: string;
        version: number;
        contentHash?: string;
        created: boolean;
        cookieCount: number;
        extensionCount: number;
        conflictResolved?: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:push-profile', localProfileId, options);
    },

    pushAccountBundle: (options?: {
      deviceFingerprint?: string;
      onConflict?: 'error' | 'overwrite';
    }): Promise<{
      success: boolean;
      data?: {
        snapshotUid?: string;
        schemaVersion: number;
        version: number;
        contentHash?: string;
        created: boolean;
        accountCount: number;
        siteCount: number;
        tagCount: number;
        conflictResolved?: boolean;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:push-account-bundle', options);
    },

    deleteCloudProfile: (
      localProfileId: string
    ): Promise<{
      success: boolean;
      data?: {
        localProfileId: string;
        cloudUid?: string;
        remoteDeleted: boolean;
        mappingRemoved: boolean;
        skipped?: 'mapping_not_found';
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:delete-cloud-profile', localProfileId);
    },

    getMappings: (): Promise<{
      success: boolean;
      data?: Array<{
        localProfileId: string;
        profileUid?: string;
        cloudUid: string;
        version: number;
        contentHash?: string;
        updatedAt: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-snapshot:get-mappings');
    },
  },

  // ========== 插件市场（公司目录） ==========

  cloudPlugin: {
    /**
     * 获取云端插件目录（全量视图）
     */
    listCatalog: (params: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          pluginCode: string;
          name: string;
          description?: string;
          artifactKind?: 'runtime_plugin';
          currentVersion?: string;
          minClientVersion?: string;
          clientVersion?: string;
          canInstall?: boolean;
          installReason?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:list', params);
    },

    /**
     * 获取云端插件目录（兼容旧命名）
     */
    /**
     * 获取单个运行时插件详情（按 pluginCode + profileUid）
     */
    getRuntimeDetail: (params: {
      pluginCode: string;
      profileUid: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginCode: string;
        name: string;
        description?: string;
        artifactKind?: 'runtime_plugin';
        currentVersion?: string;
        minClientVersion?: string;
        clientVersion?: string;
        allowed?: boolean;
        reason?: string;
        canInstall?: boolean;
        installReason?: string;
        canUse?: boolean;
        useReason?: string;
        canCache?: boolean;
        cacheReason?: string;
        endpoints?: Array<{
          endpointCode: string;
          name: string;
          type: 'FORWARD' | 'JS_FILE';
          allowCacheJs?: boolean;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-runtime-detail', params);
    },

    /**
     * 获取当前用户可见的运行时调用日志
     */
    listRuntimeLogs: (params?: {
      pageIndex?: number;
      pageSize?: number;
      pluginCode?: string;
      endpointCode?: string;
      endpointType?: string;
      action?: string;
      profileUid?: string;
      allowed?: boolean;
      responseCode?: number;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          id: number;
          pluginCode: string;
          endpointCode: string;
          endpointType: string;
          action: string;
          userId: number;
          profileUid?: string;
          allowed: boolean;
          reason?: string;
          responseCode: number;
          durationMs: number;
          targetUrl?: string;
          clientIp?: string;
          errorMessage?: string;
          createdAt?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:list-runtime-logs', params);
    },

    /**
     * 获取目录能力（view/install/use/cache + policyVersion）
     */
    getCatalogCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        actions: {
          view: boolean;
          install: boolean;
          use: boolean;
          cache: boolean;
        };
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-capabilities', options);
    },

    /**
     * 获取运行时能力（兼容旧命名）
     */
    /**
     * 插件授权检查
     */
    authorize: (params: {
      pluginCode: string;
      profileUid: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginCode: string;
        profileUid: string;
        allowed: boolean;
        reason: string;
        clientVersion?: string;
        minClientVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:authorize', params);
    },

    /**
     * 插件安装授权检查
     */
    authorizeInstall: (params: {
      pluginCode: string;
    }): Promise<{
      success: boolean;
      data?: {
        allowed: boolean;
        reason: string;
        pluginCode: string;
        releaseVersion?: string;
        downloadToken?: string;
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:authorize-install', params);
    },

    /**
     * 安装云端托管插件（安装鉴权 -> 下载 -> 本地导入）
     */
    install: (params: {
      pluginCode: string;
    }): Promise<{
      success: boolean;
      data?: {
        pluginId: string;
        pluginCode: string;
        releaseVersion?: string;
        policyVersion?: string;
        operation?: 'installed' | 'updated';
        warnings?: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:install', params);
    },

    /**
     * 获取 JS_FILE 文件内容
     */
    getJSFile: (params: {
      pluginCode: string;
      endpointCode: string;
      profileUid: string;
      ifNoneMatch?: string;
      allowCacheJs?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        statusCode: number;
        notModified: boolean;
        etag?: string;
        contentType?: string;
        content?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:get-js-file', params);
    },

    /**
     * 调用 FORWARD 转发接口
     */
    forward: (params: {
      pluginCode: string;
      endpointCode: string;
      profileUid: string;
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    }): Promise<{
      success: boolean;
      data?: {
        statusCode: number;
        headers?: Record<string, string>;
        body?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:plugins:forward', params);
    },
  },

  // ========== 浏览器扩展云端目录 ==========

  cloudBrowserExtension: {
    listCatalog: (params: {
      pageIndex?: number;
      pageSize?: number;
      keyword?: string;
    }): Promise<{
      success: boolean;
      data?: {
        items: Array<{
          extensionId: string;
          name: string;
          description?: string;
          currentVersion?: string;
          minClientVersion?: string;
          clientVersion?: string;
          canInstall?: boolean;
          installReason?: string;
        }>;
        total: number;
        pageIndex: number;
        pageSize: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:list', params);
    },

    getCatalogCapabilities: (options?: {
      forceRefresh?: boolean;
    }): Promise<{
      success: boolean;
      data?: {
        actions: {
          view: boolean;
          install: boolean;
        };
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:get-capabilities', options);
    },

    authorizeInstall: (params: {
      extensionId: string;
    }): Promise<{
      success: boolean;
      data?: {
        allowed: boolean;
        reason: string;
        extensionId: string;
        releaseVersion?: string;
        downloadToken?: string;
        policyVersion?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('cloud-catalog:browser-extensions:authorize-install', params);
    },
  },

  };
}
