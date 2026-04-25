/**
 * SavedSite Namespace - 平台管理
 *
 * 为插件提供访问和管理 saved_sites 的能力。
 */

import type { SavedSiteService } from '../../../main/duckdb/saved-site-service';
import type {
  CreateSavedSiteParams,
  SavedSite,
  UpdateSavedSiteParams,
} from '../../../types/profile';

export interface EnsureDoudianSavedSiteOptions {
  /** 平台名称，默认“抖店” */
  name?: string;
  /** 平台登录 URL，默认抖店登录页 */
  url?: string;
  /** 平台图标，可选 */
  icon?: string | null;
  /** 已存在时是否按传入参数更新，默认 false */
  updateIfExists?: boolean;
}

const DEFAULT_DOUDIAN_SAVED_SITE: Required<
  Pick<EnsureDoudianSavedSiteOptions, 'name' | 'url' | 'icon' | 'updateIfExists'>
> = {
  name: '抖店',
  url: 'https://fxg.jinritemai.com/login/common',
  icon: null,
  updateIfExists: false,
};

/**
 * 平台命名空间
 */
export class SavedSiteNamespace {
  constructor(
    private pluginId: string,
    private savedSiteService: SavedSiteService
  ) {}

  /**
   * 列出所有平台
   */
  async list(): Promise<SavedSite[]> {
    return this.savedSiteService.listAll();
  }

  /**
   * 获取平台详情
   */
  async get(id: string): Promise<SavedSite | null> {
    return this.savedSiteService.get(id);
  }

  /**
   * 按名称获取平台
   */
  async getByName(name: string): Promise<SavedSite | null> {
    return this.savedSiteService.getByName(name);
  }

  /**
   * 创建平台
   */
  async create(params: CreateSavedSiteParams): Promise<SavedSite> {
    console.log(`[SavedSite] Plugin ${this.pluginId} creating saved site: ${params.name}`);
    return this.savedSiteService.create(params);
  }

  /**
   * 更新平台
   */
  async update(id: string, params: UpdateSavedSiteParams): Promise<SavedSite> {
    console.log(`[SavedSite] Plugin ${this.pluginId} updating saved site: ${id}`);
    return this.savedSiteService.update(id, params);
  }

  /**
   * 删除平台
   */
  async delete(id: string): Promise<void> {
    console.log(`[SavedSite] Plugin ${this.pluginId} deleting saved site: ${id}`);
    return this.savedSiteService.delete(id);
  }

  /**
   * 确保抖店平台存在，不存在则创建
   */
  async ensureDoudianSavedSite(options: EnsureDoudianSavedSiteOptions = {}): Promise<SavedSite> {
    const hasIcon = Object.prototype.hasOwnProperty.call(options, 'icon');
    const merged = {
      ...DEFAULT_DOUDIAN_SAVED_SITE,
      ...options,
    };

    const name = String(merged.name || '').trim();
    if (!name) {
      throw new Error('ensureDoudianSavedSite: 平台名称不能为空');
    }

    const url = String(merged.url || '').trim();
    if (!url) {
      throw new Error('ensureDoudianSavedSite: 平台 URL 不能为空');
    }

    const existing = await this.savedSiteService.getByName(name);
    if (!existing) {
      return this.savedSiteService.create({
        name,
        url,
        icon: merged.icon ?? null,
      });
    }

    if (!merged.updateIfExists) {
      return existing;
    }

    return this.savedSiteService.update(existing.id, {
      url,
      icon: hasIcon ? (options.icon ?? null) : existing.icon ?? null,
    });
  }
}
