/**
 * 依赖关系管理器
 * 管理计算列之间的依赖关系，防止循环依赖
 */

import type { EnhancedColumnSchema } from './types';
import { extractDependenciesFromComputeConfig } from '../../utils/computed-schema-helpers';

export interface ColumnDependency {
  columnName: string;
  dependsOn: string[]; // 依赖的列名
  computeType?: string;
  expression?: string;
}

export interface DependencyCheckResult {
  hasCycle: boolean;
  cycle?: string[];
  message?: string;
}

export interface DeleteImpactResult {
  canDelete: boolean;
  affectedColumns: string[];
  message?: string;
}

export class DependencyManager {
  private dependencies: Map<string, ColumnDependency> = new Map();

  /**
   * 添加列依赖关系
   */
  addDependency(column: ColumnDependency): void {
    this.dependencies.set(column.columnName, column);
  }

  /**
   * 移除列依赖关系
   */
  removeDependency(columnName: string): void {
    this.dependencies.delete(columnName);
  }

  /**
   * 检查是否存在循环依赖
   */
  checkCyclicDependency(columnName: string, dependsOn: string[]): DependencyCheckResult {
    // 创建临时依赖图（包含新列）
    const tempDeps = new Map(this.dependencies);
    tempDeps.set(columnName, {
      columnName,
      dependsOn,
    });

    // 使用DFS检测循环
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (current: string, path: string[]): string[] | null => {
      if (recStack.has(current)) {
        // 找到循环，返回循环路径
        const cycleStart = path.indexOf(current);
        return path.slice(cycleStart).concat(current);
      }

      if (visited.has(current)) {
        return null; // 已访问过，无循环
      }

      visited.add(current);
      recStack.add(current);

      const deps = tempDeps.get(current)?.dependsOn || [];
      for (const dep of deps) {
        const cycle = dfs(dep, [...path, current]);
        if (cycle) return cycle;
      }

      recStack.delete(current);
      return null;
    };

    // 从新列开始检测
    const cycle = dfs(columnName, []);

    if (cycle) {
      return {
        hasCycle: true,
        cycle,
        message: `检测到循环依赖: ${cycle.join(' → ')}`,
      };
    }

    return { hasCycle: false };
  }

  /**
   * 获取拓扑排序顺序（用于确定计算列的计算顺序）
   */
  getComputeOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const dfs = (column: string) => {
      if (visited.has(column)) return;
      visited.add(column);

      const deps = this.dependencies.get(column)?.dependsOn || [];
      for (const dep of deps) {
        if (this.dependencies.has(dep)) {
          dfs(dep);
        }
      }

      order.push(column);
    };

    // 对所有计算列进行拓扑排序
    for (const column of this.dependencies.keys()) {
      dfs(column);
    }

    return order;
  }

  /**
   * 检查删除列的影响
   */
  checkDeleteImpact(columnName: string): DeleteImpactResult {
    const affectedColumns: string[] = [];

    for (const [col, dep] of this.dependencies.entries()) {
      if (dep.dependsOn.includes(columnName)) {
        affectedColumns.push(col);
      }
    }

    if (affectedColumns.length > 0) {
      return {
        canDelete: false,
        affectedColumns,
        message: `无法删除列 "${columnName}"，因为以下计算列依赖它: ${affectedColumns.join(', ')}`,
      };
    }

    return {
      canDelete: true,
      affectedColumns: [],
      message: `列 "${columnName}" 可以安全删除`,
    };
  }

  /**
   * 获取列的所有依赖（包括间接依赖）
   */
  getAllDependencies(columnName: string): string[] {
    const allDeps = new Set<string>();
    const visited = new Set<string>();

    const collect = (col: string) => {
      if (visited.has(col)) return;
      visited.add(col);

      const deps = this.dependencies.get(col)?.dependsOn || [];
      for (const dep of deps) {
        allDeps.add(dep);
        collect(dep);
      }
    };

    collect(columnName);
    return Array.from(allDeps);
  }

  /**
   * 获取依赖某列的所有列（包括间接依赖）
   */
  getAllDependents(columnName: string): string[] {
    const allDependents = new Set<string>();
    const visited = new Set<string>();

    const collect = (col: string) => {
      if (visited.has(col)) return;
      visited.add(col);

      for (const [depCol, dep] of this.dependencies.entries()) {
        if (dep.dependsOn.includes(col)) {
          allDependents.add(depCol);
          collect(depCol);
        }
      }
    };

    collect(columnName);
    return Array.from(allDependents);
  }

  /**
   * 从schema重建依赖图
   */
  rebuildFromSchema(schema: EnhancedColumnSchema[]): void {
    this.dependencies.clear();

    for (const col of schema) {
      if (col.storageMode === 'computed' && col.computeConfig) {
        const dependsOn = extractDependenciesFromComputeConfig(col.computeConfig);
        this.addDependency({
          columnName: col.name,
          dependsOn,
          computeType: col.computeConfig.type,
          expression: col.computeConfig.expression,
        });
      }
    }

    console.log(`✅ Rebuilt dependency graph with ${this.dependencies.size} computed columns`);
  }

  /**
   * 获取依赖关系的可视化表示（用于调试）
   */
  getDependencyGraph(): string {
    const lines: string[] = ['Dependency Graph:', '================'];

    for (const [col, dep] of this.dependencies.entries()) {
      if (dep.dependsOn.length > 0) {
        lines.push(`${col} → [${dep.dependsOn.join(', ')}]`);
      } else {
        lines.push(`${col} (no dependencies)`);
      }
    }

    if (this.dependencies.size === 0) {
      lines.push('(empty)');
    }

    return lines.join('\n');
  }

  /**
   * 清空所有依赖关系
   */
  clear(): void {
    this.dependencies.clear();
  }

  /**
   * 获取依赖关系数量
   */
  get size(): number {
    return this.dependencies.size;
  }

  /**
   * 检查列是否存在依赖关系
   */
  hasDependency(columnName: string): boolean {
    return this.dependencies.has(columnName);
  }

  /**
   * 获取列的依赖关系
   */
  getDependency(columnName: string): ColumnDependency | undefined {
    return this.dependencies.get(columnName);
  }
}
