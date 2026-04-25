import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import type { BrowserProfile, ProfileExtensionBinding } from '../../../../types/profile';

interface ExtensionPackagesBindingTabProps {
  isLoading: boolean;
  isWorking: boolean;
  extensionProfiles: BrowserProfile[];
  selectedProfileIds: string[];
  selectedProfileCount: number;
  selectedPackagesCount: number;
  removePackageWhenUnused: boolean;
  onSelectAllProfiles: () => void;
  onClearProfileSelection: () => void;
  onToggleProfileSelection: (profileId: string, checked: boolean) => void;
  onBatchBind: () => void;
  onBatchUnbind: () => void;
  onRemovePackageWhenUnusedChange: (checked: boolean) => void;
  previewProfileId: string;
  onPreviewProfileChange: (profileId: string) => void;
  previewBindings: ProfileExtensionBinding[];
}

export function ExtensionPackagesBindingTab({
  isLoading,
  isWorking,
  extensionProfiles,
  selectedProfileIds,
  selectedProfileCount,
  selectedPackagesCount,
  removePackageWhenUnused,
  onSelectAllProfiles,
  onClearProfileSelection,
  onToggleProfileSelection,
  onBatchBind,
  onBatchUnbind,
  onRemovePackageWhenUnusedChange,
  previewProfileId,
  onPreviewProfileChange,
  previewBindings,
}: ExtensionPackagesBindingTabProps) {
  return (
    <div className="space-y-4">
      <div className="shell-soft-card space-y-4 p-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">目标扩展环境</Label>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onSelectAllProfiles}
              disabled={isWorking || isLoading}
            >
              全选
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onClearProfileSelection}
              disabled={isWorking || isLoading}
            >
              清空
            </Button>
          </div>
        </div>
        <div className="grid max-h-36 grid-cols-3 gap-2 overflow-auto pr-1">
          {extensionProfiles.length === 0 ? (
            <div className="text-sm text-muted-foreground">暂无支持浏览器扩展的环境</div>
          ) : (
            extensionProfiles.map((profile) => (
              <label
                key={profile.id}
                className="flex items-center gap-2 rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70 px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={selectedProfileIds.includes(profile.id)}
                  onCheckedChange={(value) => onToggleProfileSelection(profile.id, value)}
                  disabled={isWorking || isLoading}
                />
                <span className="truncate" title={profile.name}>
                  {profile.name}
                </span>
              </label>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          已选环境 {selectedProfileCount} 个，已选扩展 {selectedPackagesCount}{' '}
          个（仓库页勾选）。同一扩展一次只能选择一个版本。
        </p>
      </div>

      <div className="shell-soft-card flex flex-wrap items-center gap-3 p-4">
        <Button onClick={onBatchBind} disabled={isLoading || isWorking}>
          批量绑定到已选环境
        </Button>
        <Button variant="outline" onClick={onBatchUnbind} disabled={isLoading || isWorking}>
          批量解绑已选扩展
        </Button>
        <label className="text-sm flex items-center gap-2">
          <Checkbox
            checked={removePackageWhenUnused}
            onCheckedChange={onRemovePackageWhenUnusedChange}
            disabled={isLoading || isWorking}
          />
          解绑后清理无引用扩展包
        </label>
      </div>

      <div className="shell-soft-card space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm font-medium">绑定预览</Label>
          <Select
            value={previewProfileId || '__none__'}
            onValueChange={(value) => onPreviewProfileChange(value === '__none__' ? '' : value)}
            disabled={isLoading || isWorking || extensionProfiles.length === 0}
          >
            <SelectTrigger className="w-80">
              <SelectValue placeholder="选择一个环境查看绑定" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">不预览</SelectItem>
              {extensionProfiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="max-h-44 overflow-auto rounded-2xl border border-[rgba(214,221,234,0.92)] bg-white/70">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b bg-background">
              <tr className="text-left">
                <th className="px-3 py-2">扩展ID</th>
                <th className="px-3 py-2">版本</th>
                <th className="px-3 py-2">模式</th>
                <th className="px-3 py-2">启用</th>
                <th className="px-3 py-2">顺序</th>
              </tr>
            </thead>
            <tbody>
              {previewBindings.length === 0 ? (
                <tr>
                  <td className="px-3 py-5 text-center text-muted-foreground" colSpan={5}>
                    当前环境无绑定扩展
                  </td>
                </tr>
              ) : (
                previewBindings.map((binding) => (
                  <tr key={binding.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">{binding.extensionId}</td>
                    <td className="px-3 py-2 font-mono text-xs">{binding.version || 'latest'}</td>
                    <td className="px-3 py-2">{binding.installMode}</td>
                    <td className="px-3 py-2">{binding.enabled ? '是' : '否'}</td>
                    <td className="px-3 py-2">{binding.sortOrder}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

