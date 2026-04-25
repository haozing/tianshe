/**
 * Account Namespace - 账号管理
 *
 * 为插件提供访问和管理账号的能力
 *
 * 账号与 Profile 的关系：
 * - 一个 Profile 可以绑定多个账号
 * - 账号记录登录信息（网站、URL等）
 * - 通过 Profile 启动的浏览器可以访问其绑定的账号
 *
 * @example
 * // 列出所有账号
 * const accounts = await helpers.account.list();
 *
 * // 列出某个 Profile 的账号
 * const profileAccounts = await helpers.account.listByProfile('profile-id');
 *
 * // 按平台列出账号
 * const platformAccounts = await helpers.account.listByPlatform('saved-site-id');
 *
 * // 创建账号
 * const account = await helpers.account.create({
 *   profileId: 'profile-id',
 *   platformId: 'saved-site-id',
 *   name: '工作号',
 *   loginUrl: 'https://example.com/login'
 * });
 *
 * // 更新账号
 * await helpers.account.update(account.id, { name: '新名称' });
 *
 * // 删除账号
 * await helpers.account.delete(account.id);
 */

import type { AccountService } from '../../../main/duckdb/account-service';
import type { Account, CreateAccountParams, UpdateAccountParams } from '../../../types/profile';

/**
 * 账号命名空间
 */
export class AccountNamespace {
  constructor(
    private pluginId: string,
    private accountService: AccountService
  ) {}

  /**
   * 列出所有账号
   *
   * @returns 账号列表
   *
   * @example
   * const accounts = await helpers.account.list();
   * for (const account of accounts) {
   *   console.log(`${account.name} - ${account.platformId || 'unassigned-platform'}`);
   * }
   */
  async list(): Promise<Account[]> {
    return this.accountService.listAll();
  }

  /**
   * 列出某个 Profile 的所有账号
   *
   * @param profileId Profile ID
   * @returns 账号列表
   *
   * @example
   * const accounts = await helpers.account.listByProfile('profile-id');
   */
  async listByProfile(profileId: string): Promise<Account[]> {
    return this.accountService.listByProfile(profileId);
  }

  /**
   * 按平台列出账号
   *
   * @param platformId 平台 ID（saved_sites.id）
   * @returns 账号列表
   */
  async listByPlatform(platformId: string): Promise<Account[]> {
    return this.accountService.listByPlatform(platformId);
  }

  /**
   * 获取单个账号
   *
   * @param id 账号 ID
   * @returns 账号详情，不存在返回 null
   *
   * @example
   * const account = await helpers.account.get('account-id');
   * if (account) {
   *   console.log(`账号: ${account.name}`);
   *   console.log(`登录URL: ${account.loginUrl}`);
   * }
   */
  async get(id: string): Promise<Account | null> {
    return this.accountService.get(id);
  }

  /**
   * 创建账号
   *
   * @param params 创建参数
   * @returns 创建的账号
   *
   * @example
   * const account = await helpers.account.create({
   *   profileId: 'profile-id',
   *   platformId: 'saved-site-id',
   *   name: '工作号',
   *   loginUrl: 'https://example.com/login',
   *   tags: ['工作', '重要'],
   *   notes: '主要用于工作'
   * });
   */
  async create(params: CreateAccountParams): Promise<Account> {
    console.log(`[Account] Plugin ${this.pluginId} creating account: ${params.name}`);
    return this.accountService.create(params);
  }

  /**
   * 更新账号
   *
   * @param id 账号 ID
   * @param params 更新参数
   * @returns 更新后的账号
   *
   * @example
   * const updated = await helpers.account.update('account-id', {
   *   name: '新名称',
   *   tags: ['新标签']
   * });
   */
  async update(id: string, params: UpdateAccountParams): Promise<Account> {
    console.log(`[Account] Plugin ${this.pluginId} updating account: ${id}`);
    return this.accountService.update(id, params);
  }

  /**
   * 删除账号
   *
   * @param id 账号 ID
   *
   * @example
   * await helpers.account.delete('account-id');
   */
  async delete(id: string): Promise<void> {
    console.log(`[Account] Plugin ${this.pluginId} deleting account: ${id}`);
    return this.accountService.delete(id);
  }

  /**
   * 删除某个 Profile 的所有账号
   *
   * @param profileId Profile ID
   *
   * @example
   * await helpers.account.deleteByProfile('profile-id');
   */
  async deleteByProfile(profileId: string): Promise<void> {
    console.log(`[Account] Plugin ${this.pluginId} deleting accounts for profile: ${profileId}`);
    return this.accountService.deleteByProfile(profileId);
  }

  /**
   * 更新账号的最后登录时间
   *
   * @param id 账号 ID
   *
   * @example
   * // 登录成功后更新时间
   * await helpers.account.updateLastLogin('account-id');
   */
  async updateLastLogin(id: string): Promise<void> {
    return this.accountService.updateLastLogin(id);
  }
}
