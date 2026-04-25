/**
 * 插件配置对话框
 *
 * 根据插件的 manifest.json 配置 schema 自动生成配置表单
 * 使用 react-hook-form + zod 进行动态表单管理和验证
 */

import { useState, useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Settings } from 'lucide-react';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { ConfigFormField } from './ConfigFormField';
import { Alert, AlertDescription } from '../ui/alert';

/**
 * 根据插件配置 schema 动态生成 zod 验证 schema
 */
function createDynamicSchema(schema: Record<string, ConfigProperty>) {
  const shape: Record<string, any> = {};

  Object.entries(schema).forEach(([key, property]) => {
    if (property.type === 'number') {
      let validator = z.number({ required_error: '此项为必填', invalid_type_error: '请输入数字' });

      if (property.minimum !== undefined) {
        validator = validator.min(property.minimum, `最小值为 ${property.minimum}`);
      }
      if (property.maximum !== undefined) {
        validator = validator.max(property.maximum, `最大值为 ${property.maximum}`);
      }

      shape[key] = validator;
    } else if (property.type === 'boolean') {
      shape[key] = z.boolean();
    } else if (property.enum) {
      shape[key] = z.enum(property.enum as [string, ...string[]]);
    } else {
      shape[key] = z.string().optional();
    }
  });

  return z.object(shape);
}

interface ConfigProperty {
  type: 'boolean' | 'number' | 'string';
  title: string;
  description?: string;
  default?: any;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

interface PluginConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginId: string;
  pluginName: string;
  pluginPath: string;
}

export function PluginConfigDialog({
  open,
  onOpenChange,
  pluginId,
  pluginName,
  pluginPath: _pluginPath,
}: PluginConfigDialogProps) {
  const [configSchema, setConfigSchema] = useState<Record<string, ConfigProperty>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // 🔥 使用 useMemo 动态创建验证 schema，确保 configSchema 更新时 resolver 也更新
  const validationSchema = useMemo(
    () => (Object.keys(configSchema).length > 0 ? createDynamicSchema(configSchema) : z.object({})), // 空 schema，允许任何数据通过（但不会有字段）
    [configSchema]
  );

  // 使用 react-hook-form 管理表单状态（动态 schema）
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm({
    resolver: zodResolver(validationSchema),
  });

  // 加载配置 schema 和当前配置值
  useEffect(() => {
    if (open && pluginId) {
      loadConfigSchema();
    }
  }, [open, pluginId]);

  // 加载配置 schema
  const loadConfigSchema = async () => {
    try {
      // 通过 IPC 获取插件信息（包含 manifest）
      const pluginInfo = await window.electronAPI.jsPlugin.get(pluginId);

      if (!pluginInfo || !pluginInfo.success) {
        setConfigSchema({});
        setError('无法获取插件信息');
        return;
      }

      // 如果插件信息包含 manifest
      const schema = pluginInfo.plugin?.manifest?.configuration?.properties || {};
      setConfigSchema(schema);

      // 加载配置值
      if (Object.keys(schema).length > 0) {
        await loadConfig(schema);
      } else {
        setError('该插件没有可配置项');
      }
    } catch (err) {
      console.error('[PluginConfigDialog] Failed to load config schema:', err);
      setConfigSchema({});
      setError('无法加载配置信息');
    }
  };

  // 从数据库加载配置
  const loadConfig = async (schema: Record<string, ConfigProperty>) => {
    setLoading(true);
    setError(null);
    try {
      const values: Record<string, any> = {};

      // 遍历所有配置键，获取当前值
      for (const key of Object.keys(schema)) {
        try {
          const value = await window.electronAPI.jsPlugin.getConfig(pluginId, key);
          values[key] = value !== undefined ? value : schema[key].default;
        } catch (err) {
          console.error(`[PluginConfigDialog] Failed to load config "${key}":`, err);
          values[key] = schema[key].default;
        }
      }

      // 使用 reset 更新表单值
      reset(values);
    } catch (validationErr) {
      console.error('[PluginConfigDialog] Failed to load plugin config:', validationErr);
      setError(validationErr instanceof Error ? validationErr.message : '加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  // 保存配置（使用 handleSubmit 自动验证）
  const onSubmit = handleSubmit(async (data) => {
    setError(null);
    setSuccess(false);
    try {
      // 保存所有配置
      for (const [key, value] of Object.entries(data)) {
        await window.electronAPI.jsPlugin.setConfig(pluginId, key, value);
      }

      setSuccess(true);

      // 1秒后自动关闭对话框
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(false);
      }, 1000);
    } catch (saveErr) {
      console.error('[PluginConfigDialog] Failed to save plugin config:', saveErr);
      setError(saveErr instanceof Error ? saveErr.message : '保存配置失败');
    }
  });

  // 如果没有配置项，不显示对话框
  const hasConfig = Object.keys(configSchema).length > 0;

  return (
    <Dialog open={open && hasConfig} onOpenChange={onOpenChange}>
      <div className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader className="mb-4">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            插件配置 - {pluginName}
          </DialogTitle>
          <DialogDescription>修改插件的配置项，保存后立即生效</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="mb-4 bg-green-50 border-green-200">
            <AlertDescription className="text-green-800">配置已保存成功！</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="py-8 text-center text-gray-500">加载配置中...</div>
        ) : (
          <form onSubmit={onSubmit}>
            <div className="space-y-6 py-4">
              {Object.entries(configSchema).map(([key, property]) => (
                <Controller
                  key={key}
                  name={key}
                  control={control}
                  render={({ field }) => (
                    <div>
                      <ConfigFormField
                        configKey={key}
                        property={property}
                        value={field.value}
                        onChange={(_, value) => field.onChange(value)}
                      />
                      {errors[key] && (
                        <p className="mt-1 text-sm text-red-600">
                          {errors[key]?.message as string}
                        </p>
                      )}
                    </div>
                  )}
                />
              ))}
            </div>
          </form>
        )}

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={loading || isSubmitting}>
            {isSubmitting ? '保存中...' : '保存并应用'}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
