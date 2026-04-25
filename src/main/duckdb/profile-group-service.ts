/**
 * ProfileGroupService - 浏览器配置分组管理服务
 *
 * 管理 ProfileGroup 的 CRUD 操作，支持嵌套分组
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import type { ProfileGroup, CreateGroupParams, UpdateGroupParams } from '../../types/profile';

/**
 * ProfileGroup 服务
 */
export class ProfileGroupService {
  constructor(private conn: DuckDBConnection) {}

  // =====================================================
  // 分组 CRUD
  // =====================================================

  /**
   * 创建分组
   */
  async create(params: CreateGroupParams): Promise<ProfileGroup> {
    const id = uuidv4();

    const stmt = await this.conn.prepare(`
      INSERT INTO profile_groups (
        id, name, parent_id, color, icon, description, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    // 获取同级分组中最大的 sort_order
    const maxOrder = await this.getMaxSortOrder(params.parentId || null);

    stmt.bind([
      id,
      params.name,
      params.parentId || null,
      params.color || null,
      params.icon || null,
      params.description || null,
      maxOrder + 1,
    ]);

    await stmt.run();
    stmt.destroySync();

    console.log(`[ProfileGroupService] Created group: ${params.name} (${id})`);

    return this.get(id) as Promise<ProfileGroup>;
  }

  /**
   * 获取单个分组
   */
  async get(id: string): Promise<ProfileGroup | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, parent_id, color, icon, description,
        sort_order, created_at, updated_at
      FROM profile_groups
      WHERE id = ?
    `);

    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToGroup(rows[0]);
  }

  /**
   * 列出所有分组（扁平列表）
   */
  async list(): Promise<ProfileGroup[]> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        id, name, parent_id, color, icon, description,
        sort_order, created_at, updated_at
      FROM profile_groups
      ORDER BY sort_order ASC, created_at ASC
    `);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToGroup(row));
  }

  /**
   * 列出分组（树形结构）
   */
  async listTree(): Promise<ProfileGroup[]> {
    const allGroups = await this.list();
    const profileCounts = await this.getProfileCounts();

    // 添加 profileCount
    allGroups.forEach((group) => {
      group.profileCount = profileCounts.get(group.id) || 0;
    });

    // 构建树形结构
    return this.buildTree(allGroups);
  }

  /**
   * 获取子分组
   */
  async getChildren(parentId: string | null): Promise<ProfileGroup[]> {
    let sql: string;
    let bindValues: any[] = [];

    if (parentId === null) {
      sql = `
        SELECT
          id, name, parent_id, color, icon, description,
          sort_order, created_at, updated_at
        FROM profile_groups
        WHERE parent_id IS NULL
        ORDER BY sort_order ASC, created_at ASC
      `;
    } else {
      sql = `
        SELECT
          id, name, parent_id, color, icon, description,
          sort_order, created_at, updated_at
        FROM profile_groups
        WHERE parent_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `;
      bindValues = [parentId];
    }

    const stmt = await this.conn.prepare(sql);
    if (bindValues.length > 0) {
      stmt.bind(bindValues);
    }

    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToGroup(row));
  }

  /**
   * 更新分组
   */
  async update(id: string, params: UpdateGroupParams): Promise<ProfileGroup> {
    const fields: string[] = [];
    const values: any[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(params.name);
    }

    if (params.parentId !== undefined) {
      // 检查是否会形成循环引用
      if (params.parentId !== null) {
        const wouldCreateCycle = await this.wouldCreateCycle(id, params.parentId);
        if (wouldCreateCycle) {
          throw new Error('无法移动到子分组中，会形成循环引用');
        }
      }
      fields.push('parent_id = ?');
      values.push(params.parentId);
    }

    if (params.color !== undefined) {
      fields.push('color = ?');
      values.push(params.color);
    }

    if (params.icon !== undefined) {
      fields.push('icon = ?');
      values.push(params.icon);
    }

    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }

    if (fields.length === 0) {
      const group = await this.get(id);
      if (!group) throw new Error(`Group not found: ${id}`);
      return group;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = await this.conn.prepare(
      `UPDATE profile_groups SET ${fields.join(', ')} WHERE id = ?`
    );
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();

    console.log(`[ProfileGroupService] Updated group: ${id}`);

    return this.get(id) as Promise<ProfileGroup>;
  }

  /**
   * 删除分组
   */
  async delete(id: string, options?: { recursive?: boolean }): Promise<void> {
    const group = await this.get(id);
    if (!group) {
      throw new Error(`Group not found: ${id}`);
    }

    // 检查是否有子分组
    const children = await this.getChildren(id);
    if (children.length > 0) {
      if (options?.recursive) {
        // 递归删除子分组
        for (const child of children) {
          await this.delete(child.id, { recursive: true });
        }
      } else {
        throw new Error('该分组包含子分组，请先删除子分组或使用递归删除');
      }
    }

    // 检查是否有 Profile
    const profileCount = await this.getProfileCount(id);
    if (profileCount > 0) {
      throw new Error(`该分组包含 ${profileCount} 个浏览器配置，请先移除或删除`);
    }

    // 删除分组
    const stmt = await this.conn.prepare(`DELETE FROM profile_groups WHERE id = ?`);
    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[ProfileGroupService] Deleted group: ${id}`);
  }

  /**
   * 移动分组到新的父分组
   */
  async move(id: string, newParentId: string | null): Promise<ProfileGroup> {
    return this.update(id, { parentId: newParentId ?? undefined });
  }

  /**
   * 重新排序分组
   */
  async reorder(groupIds: string[]): Promise<void> {
    for (let i = 0; i < groupIds.length; i++) {
      const stmt = await this.conn.prepare(`
        UPDATE profile_groups SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `);
      stmt.bind([i, groupIds[i]]);
      await stmt.run();
      stmt.destroySync();
    }

    console.log(`[ProfileGroupService] Reordered ${groupIds.length} groups`);
  }

  // =====================================================
  // 辅助方法
  // =====================================================

  /**
   * 获取分组下的 Profile 数量
   */
  private async getProfileCount(groupId: string): Promise<number> {
    const stmt = await this.conn.prepare(`
      SELECT COUNT(*) as count FROM browser_profiles WHERE group_id = ?
    `);
    stmt.bind([groupId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return Number(rows[0]?.count) || 0;
  }

  /**
   * 获取所有分组的 Profile 数量
   */
  private async getProfileCounts(): Promise<Map<string, number>> {
    const result = await this.conn.runAndReadAll(`
      SELECT group_id, COUNT(*) as count
      FROM browser_profiles
      WHERE group_id IS NOT NULL
      GROUP BY group_id
    `);

    const rows = parseRows(result);
    const counts = new Map<string, number>();
    rows.forEach((row: any) => {
      counts.set(String(row.group_id), Number(row.count));
    });

    return counts;
  }

  /**
   * 获取同级分组中最大的 sort_order
   */
  private async getMaxSortOrder(parentId: string | null): Promise<number> {
    let sql: string;
    let bindValues: any[] = [];

    if (parentId === null) {
      sql = `SELECT MAX(sort_order) as max_order FROM profile_groups WHERE parent_id IS NULL`;
    } else {
      sql = `SELECT MAX(sort_order) as max_order FROM profile_groups WHERE parent_id = ?`;
      bindValues = [parentId];
    }

    const stmt = await this.conn.prepare(sql);
    if (bindValues.length > 0) {
      stmt.bind(bindValues);
    }

    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return Number(rows[0]?.max_order) || 0;
  }

  /**
   * 检查是否会形成循环引用
   */
  private async wouldCreateCycle(groupId: string, newParentId: string): Promise<boolean> {
    // 如果新父分组就是自己，直接返回 true
    if (groupId === newParentId) return true;

    // 递归检查新父分组的所有祖先
    let currentId: string | null = newParentId;
    const visited = new Set<string>();

    while (currentId !== null) {
      if (visited.has(currentId)) {
        // 已经有循环了
        return true;
      }
      visited.add(currentId);

      if (currentId === groupId) {
        return true;
      }

      const parent = await this.get(currentId);
      currentId = parent?.parentId || null;
    }

    return false;
  }

  /**
   * 构建树形结构
   */
  private buildTree(groups: ProfileGroup[]): ProfileGroup[] {
    const groupMap = new Map<string, ProfileGroup>();
    const roots: ProfileGroup[] = [];

    // 创建映射并初始化 children
    groups.forEach((group) => {
      group.children = [];
      groupMap.set(group.id, group);
    });

    // 构建树
    groups.forEach((group) => {
      if (group.parentId === null) {
        roots.push(group);
      } else {
        const parent = groupMap.get(group.parentId);
        if (parent) {
          parent.children!.push(group);
        } else {
          // 父分组不存在，作为根节点
          roots.push(group);
        }
      }
    });

    return roots;
  }

  /**
   * 将数据库行映射为 ProfileGroup
   */
  private mapRowToGroup(row: any): ProfileGroup {
    return {
      id: String(row.id),
      name: String(row.name),
      parentId: row.parent_id ? String(row.parent_id) : null,
      color: row.color ? String(row.color) : null,
      icon: row.icon ? String(row.icon) : null,
      description: row.description ? String(row.description) : null,
      sortOrder: Number(row.sort_order) || 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
