/**
 * 元素搜索引擎
 * 基于关键词索引的快速检索
 * 让 Claude Code 负责同义词和语义理解
 */

import type { SnapshotElement } from '../browser-core/types';

/**
 * 搜索结果
 */
export interface SearchResult {
  element: SnapshotElement;
  score: number;
  matchedFields: string[]; // 哪些字段匹配了
}

/**
 * 搜索选项
 */
export interface SearchOptions {
  limit?: number; // 返回数量（默认 10）
  caseSensitive?: boolean; // 大小写敏感（默认 false）
  exactMatch?: boolean; // 精确匹配（默认 false）
  roleFilter?: string; // 只搜索特定角色（如 "button"）
}

/**
 * 元素搜索引擎
 */
export class ElementSearchEngine {
  /**
   * 搜索元素
   * @param query 查询字符串（支持中英文）
   * @param elements 元素列表
   * @param options 搜索选项
   */
  static search(
    query: string,
    elements: SnapshotElement[],
    options?: SearchOptions
  ): SearchResult[] {
    const limit = options?.limit || 10;
    const caseSensitive = options?.caseSensitive || false;
    const exactMatch = options?.exactMatch || false;

    // 1. 标准化查询
    const normalizedQuery = caseSensitive ? query : query.toLowerCase().trim();

    if (!normalizedQuery) {
      return [];
    }

    // 2. 过滤元素（如果指定了角色）
    let candidateElements = elements;
    if (options?.roleFilter) {
      candidateElements = elements.filter((el) => el.role === options.roleFilter);
    }

    // 3. 匹配和打分
    const results: SearchResult[] = [];

    for (const el of candidateElements) {
      const score = this.calculateScore(el, normalizedQuery, {
        caseSensitive,
        exactMatch,
      });

      if (score > 0) {
        results.push({
          element: el,
          score,
          matchedFields: this.getMatchedFields(el, normalizedQuery, caseSensitive),
        });
      }
    }

    // 4. 排序并返回
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 计算得分（纯字符串匹配）
   */
  private static calculateScore(
    el: SnapshotElement,
    query: string,
    options: { caseSensitive: boolean; exactMatch: boolean }
  ): number {
    let score = 0;

    const normalize = (str?: string) => {
      if (!str) return '';
      return options.caseSensitive ? str : str.toLowerCase();
    };

    const match = (field?: string): boolean => {
      if (!field) return false;
      const normalizedField = normalize(field);

      if (options.exactMatch) {
        return normalizedField === query;
      } else {
        return normalizedField.includes(query);
      }
    };

    // 按重要性打分
    if (match(el.name)) {
      score += 10;
      // 完全匹配额外加分
      if (normalize(el.name) === query) score += 5;
    }

    if (match(el.text)) {
      score += 8;
      if (normalize(el.text) === query) score += 4;
    }

    if (match(el.placeholder)) score += 6;
    if (match(el.attributes?.id)) score += 5;
    if (match(el.attributes?.['aria-label'])) score += 4;
    if (match(el.attributes?.name)) score += 3;
    if (match(el.attributes?.type)) score += 2;
    if (match(el.role)) score += 2;
    if (match(el.tag)) score += 1;

    return score;
  }

  /**
   * 获取匹配的字段
   */
  private static getMatchedFields(
    el: SnapshotElement,
    query: string,
    caseSensitive: boolean
  ): string[] {
    const matched: string[] = [];
    const normalize = (str?: string) => (caseSensitive ? str || '' : (str || '').toLowerCase());

    if (normalize(el.name).includes(query)) matched.push('name');
    if (normalize(el.text).includes(query)) matched.push('text');
    if (normalize(el.placeholder).includes(query)) matched.push('placeholder');
    if (normalize(el.attributes?.id).includes(query)) matched.push('id');
    if (normalize(el.attributes?.['aria-label']).includes(query)) matched.push('aria-label');
    if (normalize(el.attributes?.name).includes(query)) matched.push('attribute:name');
    if (normalize(el.role).includes(query)) matched.push('role');

    return matched;
  }
}
