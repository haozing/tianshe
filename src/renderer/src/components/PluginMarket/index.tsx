/**
 * 插件市场页面主组件（简化版）
 * 布局：插件市场（全屏）+ 底部状态栏（资源监控）
 */

import { PluginMarket } from './PluginMarket';
import { ResourceMonitor } from './ResourceMonitor';

export function PluginMarketPage() {
  return (
    <div className="shell-content-surface flex h-full flex-col">
      {/* 主内容区：插件市场 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <PluginMarket />
      </div>

      {/* 底部状态栏：资源监控 */}
      <ResourceMonitor />
    </div>
  );
}
