/**
 * BrowserPoolManager 集成层
 *
 * 将 BrowserPoolManager 与 WebContentsViewManager 集成
 * 提供 BrowserFactory 和 BrowserDestroyer 实现
 */

import type { Session } from 'electron';
import type { WebContentsViewManager } from '../webcontentsview-manager';
import type { WindowManager } from '../window-manager';
import type { SessionConfig } from '../../core/browser-pool/types';
import { SimpleBrowser } from '../../core/browser-core';
import { IntegratedBrowser } from '../../core/browser-automation';
import type { BrowserFactory, BrowserDestroyer } from '../../core/browser-pool/global-pool';
import { buildStealthConfigFromFingerprint } from '../../core/fingerprint/fingerprint-projections';
import { getDefaultFingerprint } from './presets';
import { mergeFingerprintConfig } from '../../constants/fingerprint-defaults';
import type { ProxyConfig as ProfileProxyConfig } from '../../types/profile';
import { clearProxyCredentials, setProxyCredentials } from './browser-launcher';

/**
 * 离屏坐标常量
 *
 * 浏览器创建时默认放在离屏位置，避免闪烁。
 * 使用窗口相对坐标，x: 10000 足够让视图在任何窗口外不可见。
 */
const OFFSCREEN_BOUNDS = {
  x: 10000,
  y: 0,
  width: 1920,
  height: 1080,
};

async function applyProxyToSession(
  ses: Session,
  proxy: ProfileProxyConfig | null | undefined
): Promise<void> {
  if (!proxy || proxy.type === 'none' || !proxy.host || !proxy.port) {
    await ses.setProxy({ mode: 'direct' });
    return;
  }

  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: `${proxy.type}://${proxy.host}:${proxy.port}`,
    proxyBypassRules: proxy.bypassList || undefined,
  });

  if (proxy.username && proxy.password) {
    setProxyCredentials(proxy.host, proxy.port, proxy.username, proxy.password);
  } else {
    clearProxyCredentials(proxy.host, proxy.port);
  }
}

/**
 * 创建 BrowserFactory
 *
 * 使用 WebContentsViewManager 创建浏览器实例
 */
export function createBrowserFactory(
  viewManager: WebContentsViewManager,
  windowManager: WindowManager
): BrowserFactory {
  return async (session: SessionConfig) => {
    const viewId = `pool:${session.id}:${Date.now()}`;

    const defaultFingerprint = getDefaultFingerprint('electron');
    const fingerprint = session.fingerprint
      ? mergeFingerprintConfig(defaultFingerprint, session.fingerprint)
      : defaultFingerprint;
    const stealthFingerprint = buildStealthConfigFromFingerprint(fingerprint);

    viewManager.registerView({
      id: viewId,
      partition: session.partition,
      url: 'about:blank',
      metadata: {
        label: `Pool Browser - ${session.id}`,
        temporary: true,
        profileId: session.id,
        displayMode: 'offscreen',
        source: 'pool',
        stealth: stealthFingerprint,
      },
    });

    // 激活视图
    const viewInfo = await viewManager.activateView(viewId);

    try {
      await applyProxyToSession(viewInfo.view.webContents.session, session.proxy);
    } catch (error) {
      console.warn('[BrowserPool] Failed to apply proxy for session:', session.id, error);
    }

    // 附加到主窗口（离屏位置，避免闪烁）
    // 后续由 showBrowserView() 移动到正常位置
    const mainWindow = windowManager.getMainWindowV3();
    if (mainWindow) {
      viewManager.attachView(viewId, 'main', OFFSCREEN_BOUNDS);
    }

    // 创建 SimpleBrowser 核心实例
    const simpleBrowser = new SimpleBrowser(viewId, viewInfo.view.webContents, viewManager);

    // 包装为 IntegratedBrowser，提供完整功能
    const browser = new IntegratedBrowser(simpleBrowser, viewManager);

    console.log(`[BrowserPool] Browser created: ${viewId}`);

    return { browser, viewId, engine: 'electron' };
  };
}

/**
 * 创建 BrowserDestroyer
 *
 * 使用 IntegratedBrowser.closeInternal() 进行完整清理：
 * 1. 停止导航
 * 2. 清除拦截规则
 * 3. 清理网络/控制台监控数据
 * 4. 关闭 WebContentsView
 */
export function createBrowserDestroyer(viewManager: WebContentsViewManager): BrowserDestroyer {
  return async (browser, viewId): Promise<void> => {
    await browser.closeInternal();

    // pool:* 视图是临时浏览器（每次创建一个新 viewId），需要从 registry 中移除，避免长期运行导致注册表增长。
    if (viewId && viewId.startsWith('pool:')) {
      try {
        await viewManager.deleteView(viewId);
      } catch {
        // ignore
      }
    }
    console.log(`[BrowserPool] Browser destroyed: ${viewId}`);
  };
}
