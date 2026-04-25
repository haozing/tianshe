/**
 * 浏览器页面快照模块
 *
 * 提供页面快照和元素搜索功能。
 * 从 browser-core 分离，作为可选的自动化功能。
 */

import type { WebContents } from 'electron';
import type { PageSnapshot, SnapshotOptions, NetworkEntry } from '../browser-core/types';
import type { NetworkCaptureManager, ConsoleCaptureManager } from '../browser-core/capture-manager';
import { getSnapshotScript, getPageStructureScript } from './selector-generator';
import { decorateSnapshotElementsWithRefs } from './element-ref';
import { PageAnalyzer } from '../browser-analysis/page-analyzer';
import { type SearchResult, type SearchOptions } from './element-search';
import { searchSnapshotElements } from './search-runtime';
import type { NetworkFilter, NetworkSummary } from '../../types/browser-interface';
import { summarizeNetworkEntries } from './network-utils';

/**
 * 快照依赖接口
 */
export interface SnapshotDependencies {
  getWebContents: () => WebContents;
  getUrl: () => string;
  getTitle: () => Promise<string>;
  networkManager?: NetworkCaptureManager;
  consoleManager?: ConsoleCaptureManager;
  waitForSelector?: (selector: string, options: { timeout: number }) => Promise<void>;
}

/**
 * 浏览器快照服务
 *
 * @example
 * const snapshotService = new BrowserSnapshotService({
 *   getWebContents: () => browser.getWebContents(),
 *   getUrl: () => browser.url(),
 *   getTitle: () => browser.title(),
 * });
 * const snapshot = await snapshotService.snapshot();
 */
export class BrowserSnapshotService {
  constructor(private deps: SnapshotDependencies) {}

  /**
   * 获取页面快照
   */
  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    const webContents = this.deps.getWebContents();

    if (options?.waitFor && this.deps.waitForSelector) {
      await this.deps.waitForSelector(options.waitFor, {
        timeout: options.timeout || 30000,
      });
    }

    const result = await webContents.executeJavaScript(
      getSnapshotScript(options?.elementsFilter || 'interactive')
    );

    const snapshot: PageSnapshot = {
      url: this.deps.getUrl(),
      title: await this.deps.getTitle(),
      elements: decorateSnapshotElementsWithRefs(result.elements),
    };

    // 智能摘要
    if (options?.includeSummary !== false) {
      const structure = await webContents.executeJavaScript(getPageStructureScript());
      snapshot.summary = PageAnalyzer.analyze(result.elements, structure);
    }

    // 网络请求
    if (options?.includeNetwork && this.deps.networkManager?.isCapturing()) {
      if (typeof options.includeNetwork === 'string' && options.includeNetwork === 'smart') {
        snapshot.network = this.getNetworkEntries({ type: 'api' });
        snapshot.networkSummary = this.getNetworkSummary();
      } else {
        snapshot.network = this.deps.networkManager.getAll();
        snapshot.networkSummary = this.getNetworkSummary();
      }
    }

    // 控制台消息
    if (options?.includeConsole && this.deps.consoleManager?.isCapturing()) {
      snapshot.console = this.deps.consoleManager.getAll();
    }

    return snapshot;
  }

  /**
   * 搜索元素
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const webContents = this.deps.getWebContents();
    const result = await webContents.executeJavaScript(getSnapshotScript('all'));
    return searchSnapshotElements(query, result.elements, options);
  }

  /**
   * 获取网络请求记录（带过滤）
   */
  getNetworkEntries(filter?: NetworkFilter): NetworkEntry[] {
    if (!this.deps.networkManager) {
      return [];
    }
    return this.deps.networkManager.getEntries(filter);
  }

  /**
   * 获取网络请求摘要
   */
  getNetworkSummary(): NetworkSummary {
    if (!this.deps.networkManager) {
      return {
        total: 0,
        byType: {},
        byMethod: {},
        failed: [],
        slow: [],
        apiCalls: [],
      };
    }

    return summarizeNetworkEntries(this.deps.networkManager.getAll());
  }
}
