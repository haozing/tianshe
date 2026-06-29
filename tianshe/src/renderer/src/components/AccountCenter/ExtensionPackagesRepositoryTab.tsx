import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import type { ExtensionPackage } from '../../../../types/profile';
import {
  type CloudCatalogItem,
  formatCloudInstallReason,
  formatDateTime,
  toPackageKey,
} from './extensionPackagesShared';
import type { RuntimeCatalogCapabilityState } from '../PluginMarket/pluginMarketShared';

interface ExtensionPackagesRepositoryTabProps {
  isLoading: boolean;
  isWorking: boolean;
  isLoadingCloudCatalog: boolean;
  localImportPaths: string[];
  onSelectLocalDirectories: () => void;
  onSelectLocalArchives: () => void;
  onClearLocalImportPaths: () => void;
  onImportLocal: () => void;
  cloudCatalogAvailable: boolean;
  cloudLoggedIn: boolean;
  cloudCapabilityState: RuntimeCatalogCapabilityState;
  cloudKeyword: string;
  onCloudKeywordChange: (value: string) => void;
  onRefreshCloudCatalog: () => void;
  onSelectAllCloudItems: () => void;
  onClearCloudSelection: () => void;
  cloudCatalogItems: CloudCatalogItem[];
  selectedCloudExtensionIds: string[];
  onToggleCloudSelection: (extensionId: string, checked: boolean) => void;
  onDownloadSelectedCloud: () => void;
  canSelectCloudItem: (item: CloudCatalogItem) => boolean;
  packages: ExtensionPackage[];
  selectedPackageKeys: string[];
  selectedPackagesCount: number;
  onTogglePackageSelection: (pkg: ExtensionPackage, checked: boolean) => void;
  onSelectAllPackages: () => void;
  onClearPackageSelection: () => void;
  onRefreshPackages: () => void;
}

export function ExtensionPackagesRepositoryTab({
  isLoading,
  isWorking,
  isLoadingCloudCatalog,
  localImportPaths,
  onSelectLocalDirectories,
  onSelectLocalArchives,
  onClearLocalImportPaths,
  onImportLocal,
  cloudCatalogAvailable,
  cloudLoggedIn,
  cloudCapabilityState,
  cloudKeyword,
  onCloudKeywordChange,
  onRefreshCloudCatalog,
  onSelectAllCloudItems,
  onClearCloudSelection,
  cloudCatalogItems,
  selectedCloudExtensionIds,
  onToggleCloudSelection,
  onDownloadSelectedCloud,
  canSelectCloudItem,
  packages,
  selectedPackageKeys,
  selectedPackagesCount,
  onTogglePackageSelection,
  onSelectAllPackages,
  onClearPackageSelection,
  onRefreshPackages,
}: ExtensionPackagesRepositoryTabProps) {
  const canViewCloudCatalog = cloudCapabilityState.actions.view;
  const canInstallFromCloudCatalog = cloudCapabilityState.actions.install;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="shell-soft-card space-y-4 p-4">
          <Label className="text-sm font-medium">本地扩展批量导入</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={onSelectLocalDirectories}
              disabled={isLoading || isWorking}
            >
              选择目录
            </Button>
            <Button
              variant="outline"
              onClick={onSelectLocalArchives}
              disabled={isLoading || isWorking}
            >
              选择 ZIP 文件
            </Button>
            <Button
              variant="ghost"
              onClick={onClearLocalImportPaths}
              disabled={isLoading || isWorking || localImportPaths.length === 0}
            >
              清空待导入
            </Button>
          </div>
          <div className="rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70 px-3 py-2 text-sm">
            已选择 {localImportPaths.length} 个路径
          </div>
          <div className="max-h-28 overflow-auto rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70">
            {localImportPaths.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">尚未选择本地路径</div>
            ) : (
              <ul className="text-xs font-mono">
                {localImportPaths.map((item) => (
                  <li key={item} className="border-b px-3 py-2 last:border-b-0 break-all">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button onClick={onImportLocal} disabled={isLoading || isWorking}>
            导入已选本地扩展
          </Button>
        </div>

        {cloudCatalogAvailable ? (
          <div className="shell-soft-card space-y-4 p-4">
          <Label className="text-sm font-medium">云端扩展下载</Label>

          <div className="grid grid-cols-1 gap-2 items-end md:grid-cols-[1fr_auto_auto_auto]">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">关键词</Label>
              <Input
                value={cloudKeyword}
                onChange={(event) => onCloudKeywordChange(event.target.value)}
                placeholder="按名称或编码过滤"
                disabled={isLoading || isWorking || !cloudLoggedIn || !canViewCloudCatalog}
              />
            </div>
            <Button
              variant="outline"
              onClick={onRefreshCloudCatalog}
              disabled={
                isLoading ||
                isWorking ||
                isLoadingCloudCatalog ||
                !cloudLoggedIn ||
                !canViewCloudCatalog
              }
            >
              查询
            </Button>
            <Button
              variant="outline"
              onClick={onSelectAllCloudItems}
              disabled={
                isLoading ||
                isWorking ||
                isLoadingCloudCatalog ||
                cloudCatalogItems.length === 0 ||
                !canViewCloudCatalog
              }
            >
              全选可下载
            </Button>
            <Button
              variant="outline"
              onClick={onClearCloudSelection}
              disabled={isLoading || isWorking || selectedCloudExtensionIds.length === 0}
            >
              清空
            </Button>
          </div>

          {!cloudLoggedIn ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              请先在左侧导航完成云端登录。
            </div>
          ) : cloudCapabilityState.error ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              获取云端扩展目录权限失败：{cloudCapabilityState.error}
            </div>
          ) : !canViewCloudCatalog ? (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              当前账号没有云端扩展目录查看权限。
            </div>
          ) : (
            <div className="max-h-44 overflow-auto rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b bg-background">
                  <tr className="text-left">
                    <th className="px-3 py-2 w-10">选</th>
                    <th className="px-3 py-2">扩展ID</th>
                    <th className="px-3 py-2">名称</th>
                    <th className="px-3 py-2">版本</th>
                    <th className="px-3 py-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {cloudCatalogItems.length === 0 ? (
                    <tr>
                      <td className="px-3 py-5 text-center text-muted-foreground" colSpan={5}>
                        {isLoadingCloudCatalog ? '加载中...' : '暂无云端浏览器扩展'}
                      </td>
                    </tr>
                  ) : (
                    cloudCatalogItems.map((item) => {
                      const checked = selectedCloudExtensionIds.includes(item.extensionId);
                      const selectable = canSelectCloudItem(item);
                      return (
                        <tr key={item.extensionId} className="border-b last:border-b-0">
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(value) =>
                                onToggleCloudSelection(item.extensionId, value)
                              }
                              disabled={
                                !selectable || isWorking || isLoading || !canInstallFromCloudCatalog
                              }
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{item.extensionId}</td>
                          <td className="px-3 py-2">{item.name || '-'}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {item.currentVersion || '-'}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {selectable ? '可下载' : formatCloudInstallReason(item.installReason)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70 px-3 py-2 text-sm">
            已选云端扩展 {selectedCloudExtensionIds.length} 个
          </div>
          <Button
            onClick={onDownloadSelectedCloud}
            disabled={
              isLoading ||
              isWorking ||
              !cloudLoggedIn ||
              !canViewCloudCatalog ||
              !canInstallFromCloudCatalog
            }
          >
            下载并导入已选云端扩展
          </Button>
          </div>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[20px] border border-[rgba(214,221,234,0.92)] bg-white/70">
        <div className="flex items-center justify-between border-b border-[rgba(214,221,234,0.92)] bg-[rgba(248,250,254,0.92)] px-3 py-3">
          <div className="text-sm text-muted-foreground">
            扩展包 {packages.length} 个，已选 {selectedPackagesCount} 个
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onSelectAllPackages}
              disabled={isWorking || isLoading}
            >
              全选
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onClearPackageSelection}
              disabled={isWorking || isLoading}
            >
              清空
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefreshPackages}
              disabled={isWorking || isLoading}
            >
              刷新
            </Button>
          </div>
        </div>

        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b bg-background">
              <tr className="text-left">
                <th className="px-3 py-2 w-10">选</th>
                <th className="px-3 py-2">扩展ID</th>
                <th className="px-3 py-2">版本</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">来源</th>
                <th className="px-3 py-2">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {packages.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-muted-foreground" colSpan={6}>
                    暂无扩展包
                  </td>
                </tr>
              ) : (
                packages.map((pkg) => {
                  const key = toPackageKey(pkg);
                  const checked = selectedPackageKeys.includes(key);
                  return (
                    <tr key={key} className="border-b last:border-b-0">
                      <td className="px-3 py-2 align-middle">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => onTogglePackageSelection(pkg, value)}
                          disabled={isWorking || isLoading}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{pkg.extensionId}</td>
                      <td className="px-3 py-2 font-mono text-xs">{pkg.version}</td>
                      <td className="px-3 py-2">{pkg.name || '-'}</td>
                      <td className="px-3 py-2">{pkg.sourceType}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDateTime(pkg.updatedAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

