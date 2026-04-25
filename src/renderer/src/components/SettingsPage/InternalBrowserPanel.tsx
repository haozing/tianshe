import { useEffect, useMemo, useState } from 'react';
import { Bug, RefreshCw, Save } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { toast } from '../../lib/toast';
import type { InternalBrowserDevToolsConfig } from '../../../../types/internal-browser';

const DEFAULT_CONFIG: InternalBrowserDevToolsConfig = {
  autoOpenDevTools: false,
};

export function InternalBrowserPanel() {
  const [storedConfig, setStoredConfig] = useState<InternalBrowserDevToolsConfig>(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState<InternalBrowserDevToolsConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasUnsavedChanges = useMemo(() => {
    return draftConfig.autoOpenDevTools !== storedConfig.autoOpenDevTools;
  }, [draftConfig.autoOpenDevTools, storedConfig.autoOpenDevTools]);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.internalBrowser.getDevToolsConfig();
      if (!result.success || !result.config) {
        toast.error('加载内置浏览器配置失败', result.error || '配置返回值不完整');
        return;
      }

      setStoredConfig(result.config);
      setDraftConfig(result.config);
    } catch (error: any) {
      toast.error('加载内置浏览器配置失败', error?.message || '未知错误');
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI.internalBrowser.setDevToolsConfig(draftConfig);
      if (!result.success || !result.config) {
        toast.error('保存内置浏览器配置失败', result.error || '未知错误');
        return;
      }

      setStoredConfig(result.config);
      setDraftConfig(result.config);
      toast.success('内置浏览器配置已保存');
    } catch (error: any) {
      toast.error('保存内置浏览器配置失败', error?.message || '未知错误');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5" />
            内置浏览器调试
          </CardTitle>
          <CardDescription>
            控制 Electron 内置浏览器实例是否自动打开 Developer Tools。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-lg border bg-muted/40 p-4">
            <div className="text-sm font-semibold">当前已保存配置</div>
            <div className="mt-2 text-xs text-muted-foreground">
              自动打开 DevTools：{storedConfig.autoOpenDevTools ? '开启' : '关闭'}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4">
            <div className="space-y-1">
              <Label className="text-base font-semibold">自动打开 Developer Tools</Label>
              <div className="text-sm text-muted-foreground">
                新创建的内置浏览器页面、`WebContentsView`、插件模态窗口、弹窗壳窗口和隐藏
                automation host 会按此开关自动打开 detached DevTools。
              </div>
            </div>
            <Switch
              aria-label="自动打开 Developer Tools"
              checked={draftConfig.autoOpenDevTools}
              onCheckedChange={(checked: boolean) =>
                setDraftConfig((prev) => ({
                  ...prev,
                  autoOpenDevTools: checked,
                }))
              }
            />
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            已经打开的窗口不会被自动补开或自动关闭 DevTools；如需生效，请重新打开对应浏览器实例。
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => void loadConfig()} disabled={loading || saving}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
            <Button onClick={() => void saveConfig()} disabled={!hasUnsavedChanges || saving}>
              <Save className="mr-2 h-4 w-4" />
              保存配置
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default InternalBrowserPanel;
