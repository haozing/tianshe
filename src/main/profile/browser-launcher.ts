/**
 * Browser Launcher - 浏览器启动工具
 *
 * v2 架构：仅保留代理认证凭据管理功能
 * 浏览器启动统一通过 BrowserPoolManager 进行
 */

/**
 * 代理认证凭据存储
 * key: `${host}:${port}`
 */
const proxyCredentials = new Map<string, { username: string; password: string }>();

/**
 * 获取代理认证凭据
 */
export function getProxyCredentials(
  host: string,
  port: number
): { username: string; password: string } | undefined {
  return proxyCredentials.get(`${host}:${port}`);
}

/**
 * 设置代理认证凭据
 */
export function setProxyCredentials(
  host: string,
  port: number,
  username: string,
  password: string
): void {
  proxyCredentials.set(`${host}:${port}`, { username, password });
}

/**
 * 清除代理认证凭据
 */
export function clearProxyCredentials(host: string, port: number): void {
  proxyCredentials.delete(`${host}:${port}`);
}

/**
 * 设置代理认证事件处理器
 *
 * 需要在应用启动时调用一次
 */
export function setupProxyAuthHandler(app: Electron.App): void {
  app.on('login', (event, _webContents, details, authInfo, callback) => {
    // 只处理代理认证
    if (!authInfo.isProxy) {
      return;
    }

    const credentials = getProxyCredentials(authInfo.host, authInfo.port);
    if (credentials) {
      event.preventDefault();
      callback(credentials.username, credentials.password);
      console.log(`[BrowserLauncher] Proxy auth provided for ${authInfo.host}:${authInfo.port}`);
    }
  });

  console.log('[BrowserLauncher] Proxy auth handler registered');
}
