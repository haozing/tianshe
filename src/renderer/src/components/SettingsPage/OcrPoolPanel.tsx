/**
 * OcrPoolPanel - OCR 引擎池设置面板
 */

import { useEffect, useState } from 'react';
import { Layers, Save, RotateCcw, ScanText } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from '../../lib/toast';
import {
  DEFAULT_OCR_POOL_CONFIG,
  OCR_POOL_LIMITS,
  normalizeOcrPoolConfig,
  type OCRPoolConfig,
} from '../../../../constants/ocr-pool';

function clampInt(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function OcrPoolPanel() {
  const [config, setConfig] = useState<OCRPoolConfig>(DEFAULT_OCR_POOL_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.ocrPool.getConfig();
      if (result.success && result.config) {
        setConfig(normalizeOcrPoolConfig(result.config));
      } else if (!result.success) {
        toast.error('加载配置失败', result.error || '未知错误');
      }
    } catch (error: any) {
      toast.error('加载配置失败', error.message);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const normalized = normalizeOcrPoolConfig(config);
      const result = await window.electronAPI.ocrPool.setConfig(normalized);
      if (result.success) {
        setConfig(result.config ?? normalized);
        toast.success('OCR 配置已保存');
      } else {
        toast.error('保存配置失败', result.error || '未知错误');
      }
    } catch (error: any) {
      toast.error('保存配置失败', error.message);
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => {
    setConfig(DEFAULT_OCR_POOL_CONFIG);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  const queueHint = `默认建议: ${config.size} * 2 = ${config.size * 2}`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanText className="h-5 w-5" />
            OCR 引擎池配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ocrPoolSize" className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                池大小
              </Label>
              <Input
                id="ocrPoolSize"
                type="number"
                min={OCR_POOL_LIMITS.size.min}
                max={OCR_POOL_LIMITS.size.max}
                value={config.size}
                onChange={(e) => {
                  const size = clampInt(
                    e.target.valueAsNumber,
                    OCR_POOL_LIMITS.size.min,
                    OCR_POOL_LIMITS.size.max
                  );
                  setConfig((prev) => ({ ...prev, size }));
                }}
              />
              <div className="text-xs text-muted-foreground">
                建议范围: {OCR_POOL_LIMITS.size.min} - {OCR_POOL_LIMITS.size.max}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ocrQueueMode">队列模式</Label>
              <Select
                value={config.queueMode}
                onValueChange={(value) =>
                  setConfig((prev) => ({
                    ...prev,
                    queueMode: value === 'reject' ? 'reject' : 'wait',
                  }))
                }
              >
                <SelectTrigger id="ocrQueueMode">
                  <SelectValue placeholder="选择队列模式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wait">等待</SelectItem>
                  <SelectItem value="reject">拒绝</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">
                wait: 队列排队等待; reject: 队列满时直接返回错误
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ocrMaxQueue">最大队列长度</Label>
            <Input
              id="ocrMaxQueue"
              type="number"
              min={OCR_POOL_LIMITS.maxQueue.min}
              max={OCR_POOL_LIMITS.maxQueue.max}
              value={config.maxQueue}
              onChange={(e) => {
                const maxQueue = clampInt(
                  e.target.valueAsNumber,
                  OCR_POOL_LIMITS.maxQueue.min,
                  OCR_POOL_LIMITS.maxQueue.max
                );
                setConfig((prev) => ({ ...prev, maxQueue }));
              }}
            />
            <div className="text-xs text-muted-foreground">
              {queueHint} | 允许范围: {OCR_POOL_LIMITS.maxQueue.min} -{' '}
              {OCR_POOL_LIMITS.maxQueue.max}
            </div>
          </div>

          <div className="flex items-center justify-between pt-4">
            <Button variant="outline" onClick={resetDefaults} disabled={saving}>
              <RotateCcw className="h-4 w-4 mr-2" />
              恢复默认
            </Button>
            <Button onClick={saveConfig} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? '保存中...' : '保存配置'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
