/**
 * HttpApiPanel - HTTP API 设置面板
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Code2, Globe, Key, Plug, RefreshCw, Save, Webhook } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from '../../lib/toast';
import {
  DEFAULT_HTTP_API_CONFIG,
  HTTP_SERVER_DEFAULTS,
  normalizeHttpApiConfig,
  type HttpApiConfig,
} from '../../../../constants/http-api';

type RuntimeAlert = {
  code: string;
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  message: string;
};

type RuntimeDiagnosis = {
  code:
    | 'healthy_self'
    | 'healthy_other_airpa'
    | 'no_listener'
    | 'unresponsive_listener'
    | 'unexpected_health_response';
  severity: 'info' | 'warning' | 'critical';
  owner: 'self' | 'other_airpa' | 'unknown';
  summary: string;
  detail?: string;
  suggestedAction?: string;
  httpStatus?: number;
};

type HttpApiRuntimeStatus = {
  running: boolean;
  reachable?: boolean;
  port?: number;
  health?: any;
  metrics?: any;
  runtimeAlerts?: RuntimeAlert[];
  diagnosis?: RuntimeDiagnosis;
  error?: string;
};

type HttpApiRuntimeActionResult = HttpApiRuntimeStatus & {
  success: boolean;
  repaired?: boolean;
  action?: 'started_self' | 'restarted_self' | 'blocked' | 'noop' | 'failed';
  message?: string;
};

type RuntimeOverrideFlags = {
  enabled: boolean;
  enableMcp: boolean;
};

function configSignature(config: HttpApiConfig): string {
  return JSON.stringify({
    ...config,
    mcpAllowedOrigins: [...config.mcpAllowedOrigins],
  });
}

function getRuntimeBadge(
  runtime: HttpApiRuntimeStatus | null
): { variant: 'default' | 'secondary' | 'destructive'; label: string } {
  if (runtime?.running) {
    return { variant: 'default', label: '运行中' };
  }

  if (runtime?.diagnosis?.code === 'healthy_other_airpa') {
    return { variant: 'secondary', label: '被其他实例占用' };
  }

  if (
    runtime?.diagnosis?.code === 'unresponsive_listener' ||
    runtime?.diagnosis?.code === 'unexpected_health_response'
  ) {
    return { variant: 'destructive', label: '端口异常' };
  }

  return { variant: 'secondary', label: '未运行' };
}

function getDiagnosisTone(
  diagnosis?: RuntimeDiagnosis
): { containerClassName: string; badgeVariant: 'secondary' | 'destructive' | 'default' } {
  if (diagnosis?.severity === 'critical') {
    return {
      containerClassName: 'border-destructive/40 bg-destructive/5',
      badgeVariant: 'destructive',
    };
  }

  if (diagnosis?.severity === 'warning') {
    return {
      containerClassName: 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20',
      badgeVariant: 'secondary',
    };
  }

  return {
    containerClassName: 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20',
    badgeVariant: 'default',
  };
}

function getRepairButtonLabel(runtime: HttpApiRuntimeStatus | null): string {
  if (runtime?.running) {
    return '重启服务';
  }

  if (runtime?.diagnosis?.code === 'no_listener') {
    return '尝试启动';
  }

  return '尝试修复';
}

function getOverrideText(params: {
  label: string;
  flagEnabled: boolean;
  storedValue: boolean;
  effectiveValue: boolean;
}): string | null {
  if (!params.flagEnabled) return null;
  return `${params.label} 当前被启动参数覆盖，已保存值为 ${params.storedValue ? '开启' : '关闭'}，本次生效值为 ${params.effectiveValue ? '开启' : '关闭'}。`;
}

export function HttpApiPanel() {
  const [storedConfig, setStoredConfig] = useState<HttpApiConfig>(DEFAULT_HTTP_API_CONFIG);
  const [effectiveConfig, setEffectiveConfig] = useState<HttpApiConfig>(DEFAULT_HTTP_API_CONFIG);
  const [draftConfig, setDraftConfig] = useState<HttpApiConfig>(DEFAULT_HTTP_API_CONFIG);
  const [runtimeOverrides, setRuntimeOverrides] = useState<RuntimeOverrideFlags>({
    enabled: false,
    enableMcp: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtime, setRuntime] = useState<HttpApiRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const hasUnsavedChanges = useMemo(() => {
    return configSignature(draftConfig) !== configSignature(storedConfig);
  }, [draftConfig, storedConfig]);

  const updateDraftConfig = (patch: Partial<HttpApiConfig>) => {
    setDraftConfig((prev) =>
      normalizeHttpApiConfig({
        ...prev,
        ...patch,
      })
    );
  };

  const loadConfig = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.httpApi.getConfig();
      if (!result.success || !result.storedConfig || !result.effectiveConfig) {
        toast.error('加载配置失败', result.error || '配置返回值不完整');
        return;
      }

      const nextStoredConfig = normalizeHttpApiConfig(result.storedConfig as Partial<HttpApiConfig>);
      const nextEffectiveConfig = normalizeHttpApiConfig(
        result.effectiveConfig as Partial<HttpApiConfig>
      );

      setStoredConfig(nextStoredConfig);
      setEffectiveConfig(nextEffectiveConfig);
      setDraftConfig(nextStoredConfig);
      setRuntimeOverrides(result.runtimeOverrides || { enabled: false, enableMcp: false });
    } catch (error: any) {
      toast.error('加载配置失败', error.message);
    } finally {
      setLoading(false);
    }
  };

  const loadRuntimeStatus = async () => {
    if (!effectiveConfig.enabled) {
      setRuntime(null);
      return;
    }

    setRuntimeLoading(true);
    try {
      const result = await window.electronAPI.httpApi.getRuntimeStatus();
      if (result.success) {
        setRuntime({
          running: result.running === true,
          reachable: result.reachable === true,
          port: result.port,
          health: result.health,
          metrics: result.metrics,
          runtimeAlerts: result.runtimeAlerts || [],
          diagnosis: result.diagnosis,
          error: result.error,
        });
      } else {
        setRuntime({
          running: false,
          runtimeAlerts: [],
          error: result.error || '获取运行时状态失败',
        });
      }
    } catch (error: any) {
      setRuntime({
        running: false,
        runtimeAlerts: [],
        error: error?.message || '获取运行时状态失败',
      });
    } finally {
      setRuntimeLoading(false);
    }
  };

  const applyRuntimeResult = (result: HttpApiRuntimeActionResult) => {
    setRuntime({
      running: result.running === true,
      reachable: result.reachable === true,
      port: result.port,
      health: result.health,
      metrics: result.metrics,
      runtimeAlerts: result.runtimeAlerts || [],
      diagnosis: result.diagnosis,
      error: result.error,
    });
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI.httpApi.setConfig(draftConfig);
      if (!result.success) {
        toast.error('保存配置失败', result.error || '未知错误');
        return;
      }

      await loadConfig();
      await loadRuntimeStatus();
      toast.success('配置已保存');
    } catch (error: any) {
      toast.error('保存配置失败', error.message);
    } finally {
      setSaving(false);
    }
  };

  const repairRuntime = async () => {
    if (!effectiveConfig.enabled) {
      toast.warning('HTTP 服务当前未启用');
      return;
    }

    setRepairing(true);
    try {
      const result = await window.electronAPI.httpApi.repairRuntime();
      if (result.success) {
        applyRuntimeResult(result as HttpApiRuntimeActionResult);
        if (result.repaired) {
          toast.success('HTTP 服务修复完成', result.message);
        } else if (result.action === 'blocked') {
          toast.warning('当前无法自动修复', result.message);
        } else if (result.action === 'failed') {
          toast.error('修复失败', result.message || result.error || '未知错误');
        } else {
          toast.info('已完成运行态检查', result.message);
        }
      } else {
        toast.error('修复失败', result.error || '未知错误');
      }
    } catch (error: any) {
      toast.error('修复失败', error?.message || '未知错误');
    } finally {
      setRepairing(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    if (!effectiveConfig.enabled) {
      setRuntime(null);
      return;
    }

    void loadRuntimeStatus();
    const timer = setInterval(() => {
      void loadRuntimeStatus();
    }, 15000);

    return () => clearInterval(timer);
  }, [effectiveConfig.enabled, effectiveConfig.enableAuth, effectiveConfig.token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  const configuredPort = HTTP_SERVER_DEFAULTS.PORT;
  const mcpBaseUrl = `http://${HTTP_SERVER_DEFAULTS.BIND_ADDRESS}:${configuredPort}/mcp`;
  const runtimeBadge = getRuntimeBadge(runtime);
  const diagnosisTone = getDiagnosisTone(runtime?.diagnosis);
  const enabledOverrideText = getOverrideText({
    label: 'HTTP 服务开关',
    flagEnabled: runtimeOverrides.enabled,
    storedValue: storedConfig.enabled,
    effectiveValue: effectiveConfig.enabled,
  });
  const enableMcpOverrideText = getOverrideText({
    label: 'MCP 服务开关',
    flagEnabled: runtimeOverrides.enableMcp,
    storedValue: Boolean(storedConfig.enableMcp),
    effectiveValue: Boolean(effectiveConfig.enableMcp),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            HTTP API 配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {(enabledOverrideText || enableMcpOverrideText) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                当前进程存在启动参数覆盖
              </div>
              <div className="mt-2 space-y-1 text-xs text-amber-800">
                <div>已保存配置仍会写入本地，但本次运行按生效配置执行。</div>
                {enabledOverrideText ? <div>{enabledOverrideText}</div> : null}
                {enableMcpOverrideText ? <div>{enableMcpOverrideText}</div> : null}
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="text-sm font-semibold">已保存配置</div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div>HTTP 服务：{storedConfig.enabled ? '开启' : '关闭'}</div>
                <div>MCP 服务：{storedConfig.enableMcp ? '开启' : '关闭'}</div>
                <div>鉴权：{storedConfig.enableAuth ? '开启' : '关闭'}</div>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="text-sm font-semibold">当前生效配置</div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div>HTTP 服务：{effectiveConfig.enabled ? '开启' : '关闭'}</div>
                <div>MCP 服务：{effectiveConfig.enableMcp ? '开启' : '关闭'}</div>
                <div>鉴权：{effectiveConfig.enableAuth ? '开启' : '关闭'}</div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/50 p-4">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-base font-semibold">
                <Globe className="h-5 w-5" />
                启用 HTTP 服务器
                {runtimeOverrides.enabled ? <Badge variant="secondary">运行时覆盖</Badge> : null}
              </Label>
              <div className="text-sm text-muted-foreground">
                开启后可通过 HTTP 接口访问编排能力和 MCP 协议端点
              </div>
            </div>
            <Switch
              checked={draftConfig.enabled}
              onCheckedChange={(checked: boolean) => updateDraftConfig({ enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/20">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-base font-semibold text-blue-900 dark:text-blue-100">
                <Plug className="h-5 w-5" />
                启用 MCP 服务
                {runtimeOverrides.enableMcp ? <Badge variant="secondary">运行时覆盖</Badge> : null}
              </Label>
            </div>
            <Switch
              checked={draftConfig.enableMcp || false}
              onCheckedChange={(checked: boolean) => updateDraftConfig({ enableMcp: checked })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sky-200 bg-sky-50 p-4 dark:border-sky-800 dark:bg-sky-950/20">
            <div className="space-y-0.5">
              <Label className="text-base font-semibold text-sky-900 dark:text-sky-100">
                MCP 端点要求鉴权
              </Label>
              <div className="text-sm text-sky-700 dark:text-sky-300">
                仅在 Token 认证开启时生效
              </div>
            </div>
            <Switch
              checked={draftConfig.mcpRequireAuth}
              onCheckedChange={(checked: boolean) => updateDraftConfig({ mcpRequireAuth: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2">
                <Key className="h-4 w-4" />
                Token 认证
              </Label>
              <div className="text-sm text-muted-foreground">
                启用后需要在 HTTP 请求头中提供 Bearer Token
              </div>
            </div>
            <Switch
              checked={draftConfig.enableAuth}
              onCheckedChange={(checked: boolean) => updateDraftConfig({ enableAuth: checked })}
            />
          </div>

          {draftConfig.enableAuth && (
            <div className="space-y-2">
              <Label htmlFor="token">认证 Token</Label>
              <Input
                id="token"
                type="password"
                placeholder="输入 API Token"
                value={draftConfig.token || ''}
                onChange={(e) => updateDraftConfig({ token: e.target.value })}
              />
              <div className="text-xs text-muted-foreground">使用方式：Authorization: Bearer YOUR_TOKEN</div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="callbackUrl" className="flex items-center gap-2">
              <Webhook className="h-4 w-4" />
              Webhook 回调 URL
            </Label>
            <Input
              id="callbackUrl"
              type="url"
              placeholder="https://your-server.com/webhook"
              value={draftConfig.callbackUrl || ''}
              onChange={(e) => updateDraftConfig({ callbackUrl: e.target.value })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 p-4 dark:border-rose-800 dark:bg-rose-950/20">
            <div className="space-y-0.5">
              <Label className="text-base font-semibold text-rose-900 dark:text-rose-100">
                强制 Orchestration Scope 校验
              </Label>
            </div>
            <Switch
              checked={draftConfig.enforceOrchestrationScopes}
              onCheckedChange={(checked: boolean) =>
                updateDraftConfig({ enforceOrchestrationScopes: checked })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="idempotencyStore" className="text-base font-semibold">
              幂等存储策略
            </Label>
            <Select
              value={draftConfig.orchestrationIdempotencyStore}
              onValueChange={(value) =>
                updateDraftConfig({
                  orchestrationIdempotencyStore: value as HttpApiConfig['orchestrationIdempotencyStore'],
                })
              }
            >
              <SelectTrigger id="idempotencyStore">
                <SelectValue placeholder="选择幂等存储策略" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="memory">memory（默认，会话内内存）</SelectItem>
                <SelectItem value="duckdb">duckdb（可选持久化）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-purple-200 bg-purple-50 p-4 dark:border-purple-800 dark:bg-purple-950/20">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-base font-semibold text-purple-900 dark:text-purple-100">
                <Code2 className="h-5 w-5" />
                开发模式
              </Label>
              <div className="text-sm text-purple-700 dark:text-purple-300">
                启用后解锁插件热重载监听等开发功能
              </div>
            </div>
            <Switch
              checked={draftConfig.enableDevMode || false}
              onCheckedChange={(checked: boolean) => updateDraftConfig({ enableDevMode: checked })}
            />
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={saveConfig} disabled={saving || !hasUnsavedChanges}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? '保存中...' : hasUnsavedChanges ? '保存配置' : '已保存'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              运行时状态
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={repairRuntime}
                disabled={repairing || runtimeLoading}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${repairing ? 'animate-spin' : ''}`} />
                {repairing ? '处理中...' : getRepairButtonLabel(runtime)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadRuntimeStatus()}
                disabled={runtimeLoading || repairing || !effectiveConfig.enabled}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${runtimeLoading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant={runtimeBadge.variant}>{runtimeBadge.label}</Badge>
            <span className="text-sm text-muted-foreground">端口: {configuredPort}</span>
          </div>

          {!effectiveConfig.enabled && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              当前生效配置中 HTTP 服务为关闭状态。若已保存配置与生效配置不一致，请检查启动参数覆盖提示。
            </div>
          )}

          {runtime?.diagnosis && runtime.diagnosis.code !== 'healthy_self' && (
            <div className={`rounded-md border p-3 text-sm ${diagnosisTone.containerClassName}`}>
              <div className="flex items-center gap-2">
                <Badge variant={diagnosisTone.badgeVariant}>{runtime.diagnosis.severity}</Badge>
                <span className="font-medium">{runtime.diagnosis.summary}</span>
              </div>
              {runtime.diagnosis.detail && (
                <div className="mt-2 text-xs text-muted-foreground">{runtime.diagnosis.detail}</div>
              )}
            </div>
          )}

          {runtime?.error && !runtime?.diagnosis && (
            <div className="text-sm text-destructive">{runtime.error}</div>
          )}

          <div className="rounded-lg border p-4">
            <div className="text-sm font-semibold">接入方式</div>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div>MCP URL: {mcpBaseUrl}</div>
              <div>建议：先用 `session_prepare` 绑定 profile / engine / visible / scopes，再进入 `browser_*` 工具。</div>
              <div>当前生效：auth={String(effectiveConfig.enableAuth)} / mcp={String(effectiveConfig.enableMcp)}</div>
            </div>
          </div>

          <div className="rounded-lg border p-4">
            <div className="text-sm font-semibold">修复建议</div>
            <div className="mt-2 text-xs text-muted-foreground">
              {runtime?.diagnosis?.suggestedAction || '若当前服务无响应，可先刷新状态，再尝试自动修复。'}
            </div>
          </div>

          <div className="rounded-lg border p-4">
            <div className="text-sm font-semibold">告警摘要</div>
            <div className="mt-2">
              {runtime?.runtimeAlerts && runtime.runtimeAlerts.length > 0 ? (
                <div className="space-y-2">
                  {runtime.runtimeAlerts.map((alert) => (
                    <div
                      key={`${alert.code}-${alert.severity}`}
                      className="flex items-center justify-between rounded-md border p-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant={alert.severity === 'critical' ? 'destructive' : 'secondary'}>
                          {alert.severity}
                        </Badge>
                        <span className="text-sm">{alert.message}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {alert.value} / {alert.threshold}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">当前无告警</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
