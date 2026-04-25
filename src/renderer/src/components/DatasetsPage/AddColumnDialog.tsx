/**
 * AddColumnDialog - 添加列对话框（单页版）
 * 支持数据列（7种字段类型）和计算列（5种计算类型）
 * 使用 react-hook-form + zod 进行表单管理和验证
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { useDatasetStore } from '../../stores/datasetStore';
import {
  addDatasetColumn,
  validateDatasetColumnName,
} from '../../services/datasets/datasetMutationService';
import { pluginFacade } from '../../services/datasets/pluginFacade';
import type { JSPluginInfo, CommandContribution } from '../../../../types/js-plugin';
import {
  buildButtonMetadataForPersistence,
  type ButtonVariant,
} from '../../../../utils/button-metadata';

type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'attachment'
  | 'button';
type ComputeType = 'amount' | 'discount' | 'bucket' | 'concat' | 'custom';
type AllTypes = FieldType | ComputeType;

interface ColumnMetadata {
  defaultValue?: string;
  format?: string;
  dateFormat?: string;
  includeTime?: boolean;
  options?: string[];
  separator?: string;
  maxFileSize?: number;
  allowedTypes?: string[];
  buttonLabel?: string;
  buttonIcon?: string;
  buttonVariant?: ButtonVariant;
  buttonColor?: string;
  pluginId?: string;
  pluginType?: string;
  methodId?: string;
  confirmMessage?: string;
  showResult?: boolean;
  colorMap?: Record<string, string>;
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | Record<string, string>
    | undefined;
}

type ComputeParams = Record<string, string | number | string[] | number[]>;

interface ComputeConfigState {
  type?: ComputeType;
  expression?: string;
  params?: ComputeParams;
}

interface AddColumnParams {
  datasetId: string;
  columnName: string;
  fieldType: AllTypes;
  nullable: boolean;
  storageMode: 'computed' | 'physical';
  computeConfig?: ComputeConfigState;
  metadata?: ColumnMetadata;
}

interface AddColumnDialogProps {
  open: boolean;
  onClose: () => void;
  datasetId: string;
  existingColumns: string[];
  onSuccess: () => void;
}

const inferLocalDuckdbType = (
  fieldType: AllTypes,
  metadata?: ColumnMetadata,
  computeConfig?: ComputeConfigState
) => {
  if (['amount', 'discount'].includes(fieldType)) {
    return 'DOUBLE';
  }

  if (['bucket', 'concat', 'custom'].includes(fieldType)) {
    return 'VARCHAR';
  }

  switch (fieldType) {
    case 'number':
      return metadata?.format === 'integer' ? 'BIGINT' : 'DOUBLE';
    case 'date':
      return metadata?.includeTime ? 'TIMESTAMP' : 'DATE';
    case 'text':
    case 'single_select':
    case 'multi_select':
    case 'attachment':
    case 'button':
      return 'VARCHAR';
    default:
      return computeConfig?.type === 'amount' || computeConfig?.type === 'discount'
        ? 'DOUBLE'
        : 'VARCHAR';
  }
};

const buildLocalSchemaColumn = (params: AddColumnParams) => {
  const column: Record<string, unknown> = {
    name: params.columnName,
    duckdbType: inferLocalDuckdbType(params.fieldType, params.metadata, params.computeConfig),
    fieldType: params.fieldType,
    nullable: params.nullable,
    storageMode: params.storageMode,
  };

  if (params.storageMode === 'computed') {
    column.computeConfig = params.computeConfig;
  } else {
    column.metadata =
      params.fieldType === 'button'
        ? buildButtonMetadataForPersistence(params.metadata)
        : (params.metadata ?? {});
  }

  return column;
};

// === Zod 验证 Schema（嵌套结构，与 API 参数一致）===
const createAddColumnSchema = (existingColumns: string[]) =>
  z
    .object({
      columnName: z
        .string()
        .min(1, '列名不能为空')
        .max(50, '列名不能超过50个字符')
        .regex(/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/, '列名只能包含中文、字母、数字和下划线')
        .refine((name) => !existingColumns.includes(name), '列名已存在'),
      // 🆕 使用 z.enum 提供类型安全的字段类型选择
      selectedType: z.enum(
        [
          // 数据列类型
          'text',
          'number',
          'date',
          'single_select',
          'multi_select',
          'attachment',
          'button',
          // 计算列类型
          'amount',
          'discount',
          'bucket',
          'concat',
          'custom',
        ],
        { required_error: '请选择字段类型' }
      ),
      nullable: z.boolean(),
      storageMode: z.enum(['physical', 'computed']),

      // 嵌套：数据列配置
      metadata: z
        .object({
          defaultValue: z.string().optional(),
          format: z.string().optional(),
          dateFormat: z.string().optional(),
          includeTime: z.boolean().optional(),
          options: z.array(z.string()).optional(),
          separator: z.string().optional(),
          maxFileSize: z.number().optional(),
          allowedTypes: z.array(z.string()).optional(),
          buttonLabel: z.string().optional(),
          buttonIcon: z.string().optional(),
          buttonVariant: z.enum(['default', 'primary', 'success', 'danger']).optional(),
          buttonColor: z.string().optional(),
          pluginId: z.string().optional(),
          pluginType: z.string().optional(),
          methodId: z.string().optional(),
          confirmMessage: z.string().optional(),
          showResult: z.boolean().optional(),
          colorMap: z.record(z.string()).optional(),
        })
        .optional(),

      // 嵌套：计算列配置
      computeConfig: z
        .object({
          type: z.string().optional(),
          expression: z.string().optional(),
          params: z
            .record(z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number())]))
            .optional(),
        })
        .optional(),
    })
    .superRefine((data, ctx) => {
      // 条件验证：按钮字段必须选择插件和命令
      if (data.selectedType === 'button') {
        if (!data.metadata?.pluginId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择 JS 插件',
            path: ['metadata', 'pluginId'],
          });
        }
        if (!data.metadata?.methodId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择命令',
            path: ['metadata', 'methodId'],
          });
        }
      }

      // 条件验证：自定义 SQL 表达式不能为空
      if (data.selectedType === 'custom' && !data.computeConfig?.expression) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SQL 表达式不能为空',
          path: ['computeConfig', 'expression'],
        });
      }

      // 🆕 条件验证：金额计算必须选择单价和数量字段
      if (data.selectedType === 'amount') {
        if (!data.computeConfig?.params?.priceField) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择单价字段',
            path: ['computeConfig', 'params', 'priceField'],
          });
        }
        if (!data.computeConfig?.params?.quantityField) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择数量字段',
            path: ['computeConfig', 'params', 'quantityField'],
          });
        }
      }

      // 🆕 条件验证：折扣计算必须选择原价和折后价字段
      if (data.selectedType === 'discount') {
        if (!data.computeConfig?.params?.originalPriceField) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择原价字段',
            path: ['computeConfig', 'params', 'originalPriceField'],
          });
        }
        if (!data.computeConfig?.params?.discountedPriceField) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择折后价字段',
            path: ['computeConfig', 'params', 'discountedPriceField'],
          });
        }
      }

      // 🆕 条件验证：分组标签必须选择字段并设置边界和标签
      if (data.selectedType === 'bucket') {
        if (!data.computeConfig?.params?.field) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请选择数值字段',
            path: ['computeConfig', 'params', 'field'],
          });
        }
        const boundaries = data.computeConfig?.params?.boundaries as number[] | undefined;
        if (!boundaries || boundaries.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请设置至少一个分组边界',
            path: ['computeConfig', 'params', 'boundaries'],
          });
        }
        const labels = data.computeConfig?.params?.labels as string[] | undefined;
        if (!labels || labels.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请设置至少一个分组标签',
            path: ['computeConfig', 'params', 'labels'],
          });
        }
      }

      // 🆕 条件验证：文本拼接必须选择至少一个字段
      if (data.selectedType === 'concat') {
        const fields = data.computeConfig?.params?.fields as string[] | undefined;
        if (!fields || fields.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '请至少选择一个字段进行拼接',
            path: ['computeConfig', 'params', 'fields'],
          });
        }
      }
    });

type AddColumnFormData = z.infer<ReturnType<typeof createAddColumnSchema>>;

// === 数据列配置 ===
const FIELD_TYPES = [
  { value: 'text', label: '文本', icon: '📝', description: '单行文本' },
  { value: 'number', label: '数字', icon: '🔢', description: '数值字段' },
  { value: 'date', label: '日期', icon: '📅', description: '日期时间' },
  { value: 'single_select', label: '单选', icon: '◉', description: '单选下拉' },
  { value: 'multi_select', label: '多选', icon: '☑', description: '多选字段' },
  { value: 'attachment', label: '附件', icon: '📎', description: '文件附件' },
  { value: 'button', label: '按钮', icon: '▶️', description: '执行工作流' },
];

// === 计算列配置 ===
const COMPUTE_TYPES = [
  { value: 'amount', label: '金额计算', icon: 'ƒ', description: '数量 × 单价' },
  { value: 'discount', label: '折扣计算', icon: 'ƒ', description: '原价 × 折扣率' },
  { value: 'bucket', label: '分组标签', icon: 'ƒ', description: '数值范围分类' },
  { value: 'concat', label: '文本拼接', icon: 'ƒ', description: '合并多个列' },
  { value: 'custom', label: '自定义SQL', icon: 'ƒ', description: 'SQL表达式' },
];

const NUMBER_FORMATS = [
  { value: 'integer', label: '整数' },
  { value: 'decimal', label: '小数' },
  { value: 'thousand', label: '千分位' },
  { value: 'thousand_decimal', label: '千分位（小数点）' },
  ...Array.from({ length: 9 }, (_, i) => ({
    value: `precision_${i + 1}`,
    label: `保留 ${i + 1} 位小数`,
  })),
  { value: 'percentage', label: '百分比' },
  { value: 'currency', label: '货币' },
];

const DATE_FORMATS = [
  { value: 'YYYY/MM/DD', label: '2025/01/30' },
  { value: 'YYYY-MM-DD', label: '2025-01-30' },
  { value: 'MM/DD/YYYY', label: '01/30/2025' },
  { value: 'DD/MM/YYYY', label: '30/01/2025' },
  { value: 'YYYY年MM月DD日', label: '2025年1月30日' },
];

const BUTTON_ICONS = [
  { value: '▶️', label: '播放' },
  { value: '📧', label: '邮件' },
  { value: '🔍', label: '搜索' },
  { value: '✅', label: '确认' },
  { value: '❌', label: '取消' },
  { value: '🔄', label: '刷新' },
];

const BUTTON_VARIANTS = [
  { value: 'default', label: '默认' },
  { value: 'primary', label: '主要' },
  { value: 'success', label: '成功' },
  { value: 'danger', label: '危险' },
];

export function AddColumnDialog({
  open,
  onClose,
  datasetId,
  existingColumns,
  onSuccess,
}: AddColumnDialogProps) {
  const { currentDataset, applyLocalDatasetSchema } = useDatasetStore();

  // === 使用 react-hook-form 管理表单状态 ===
  const {
    control,
    handleSubmit,
    watch,
    setValue,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AddColumnFormData>({
    resolver: zodResolver(createAddColumnSchema(existingColumns)),
    defaultValues: {
      columnName: '',
      selectedType: '' as any, // 初始未选择状态，提交时会被 zod 验证拦截
      nullable: true,
      storageMode: 'physical',
      metadata: {},
      computeConfig: {},
    },
  });

  // 监听字段类型变化
  const selectedType = watch('selectedType');
  const storageMode = watch('storageMode');

  // === JS插件状态（UI 辅助状态，不由 react-hook-form 管理） ===
  const [jsPlugins, setJsPlugins] = useState<JSPluginInfo[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<JSPluginInfo | null>(null);
  const [pluginCommands, setPluginCommands] = useState<CommandContribution[]>([]);

  // 判断是否为计算列类型
  const isComputeType = (type: string): boolean => {
    if (!type) return false;
    return ['amount', 'discount', 'bucket', 'concat', 'custom'].includes(type);
  };

  // 获取可用字段
  const availableFields = useMemo(() => {
    if (!currentDataset?.schema) return [];
    return currentDataset.schema.map((col) => ({
      name: col.name,
      type: col.duckdbType,
      fieldType: col.fieldType || 'text',
    }));
  }, [currentDataset]);

  // 获取数值字段
  const numericFields = useMemo(() => {
    return availableFields.filter((f) =>
      ['INTEGER', 'BIGINT', 'DOUBLE', 'DECIMAL', 'FLOAT', 'NUMERIC'].some((t) =>
        f.type.toUpperCase().includes(t)
      )
    );
  }, [availableFields]);

  // 加载JS插件列表（用于按钮字段）
  useEffect(() => {
    if (open && selectedType === 'button') {
      pluginFacade
        .listPlugins()
        .then((result) => {
          if (result.success && Array.isArray(result.plugins)) {
            const enabled = (result.plugins as JSPluginInfo[]).filter(
              (plugin) => plugin.enabled !== false
            );
            setJsPlugins(enabled);
          } else {
            setJsPlugins([]);
          }
        })
        .catch(() => setJsPlugins([]));
    }
  }, [open, selectedType]);

  // 加载选中插件的命令列表
  useEffect(() => {
    if (selectedPlugin) {
      pluginFacade
        .getPlugin(selectedPlugin.id)
        .then((result) => {
          if (result.success && result.plugin) {
            const commands = Array.isArray(result.plugin.commands)
              ? (result.plugin.commands as CommandContribution[])
              : [];
            setPluginCommands(commands);
          } else {
            setPluginCommands([]);
          }
        })
        .catch(() => setPluginCommands([]));
    } else {
      setPluginCommands([]);
    }
  }, [selectedPlugin]);

  // 类型变化时初始化配置并更新 storageMode
  useEffect(() => {
    if (!selectedType) return;

    // 更新存储模式
    const newStorageMode = isComputeType(selectedType) ? 'computed' : 'physical';
    setValue('storageMode', newStorageMode);

    if (isComputeType(selectedType)) {
      // 初始化计算列配置
      initializeComputeConfig(selectedType as ComputeType);
    } else {
      // 初始化数据列配置
      initializeMetadata(selectedType as FieldType);
    }
  }, [selectedType, setValue]);

  // 初始化数据列 metadata
  const initializeMetadata = (type: FieldType) => {
    switch (type) {
      case 'number':
        setValue('metadata', { format: 'integer' });
        break;
      case 'date':
        setValue('metadata', { dateFormat: 'YYYY/MM/DD', includeTime: false });
        break;
      case 'single_select':
      case 'multi_select':
        setValue('metadata', {
          options: ['选项1', '选项2'],
          colorMap: {} as Record<string, string>,
          separator: type === 'multi_select' ? ',' : undefined,
        });
        break;
      case 'button':
        setValue('metadata', {
          buttonLabel: '执行',
          buttonIcon: '▶️',
          buttonVariant: 'primary',
          pluginType: 'js',
          showResult: true,
        });
        break;
      case 'attachment':
        setValue('metadata', { maxFileSize: 10 * 1024 * 1024, allowedTypes: [] });
        break;
      default:
        setValue('metadata', {});
    }
  };

  // 初始化计算列配置
  const initializeComputeConfig = (type: ComputeType) => {
    switch (type) {
      case 'amount':
        setValue('computeConfig', {
          type: 'amount',
          params: { priceField: '', quantityField: '' },
        });
        break;
      case 'discount':
        setValue('computeConfig', {
          type: 'discount',
          params: { originalPriceField: '', discountedPriceField: '', discountType: 'percentage' },
        });
        break;
      case 'bucket':
        setValue('computeConfig', {
          type: 'bucket',
          params: { field: '', boundaries: [0, 100, 200], labels: ['低', '中', '高'] },
        });
        break;
      case 'concat':
        setValue('computeConfig', { type: 'concat', params: { fields: [], separator: ' ' } });
        break;
      case 'custom':
        setValue('computeConfig', { type: 'custom', expression: '' });
        break;
    }
  };

  // 重置表单
  const handleReset = () => {
    reset({
      columnName: '',
      selectedType: '' as any, // 重置为未选择状态
      nullable: true,
      storageMode: 'physical',
      metadata: {},
      computeConfig: {},
    });
    setSelectedPlugin(null);
    setPluginCommands([]);
    onClose();
  };

  // 提交（使用 react-hook-form 的 handleSubmit）
  const onSubmit = handleSubmit(async (data) => {
    try {
      const validateResult = await validateDatasetColumnName(datasetId, data.columnName);
      if (!validateResult.valid) {
        setError('columnName', {
          type: 'manual',
          message: validateResult.message || '列名不可用',
        });
        return;
      }

      const params: AddColumnParams = {
        datasetId,
        columnName: data.columnName,
        fieldType: data.selectedType, // 🆕 不再需要类型断言，zod enum 自动推导类型
        nullable: data.nullable,
        storageMode: data.storageMode,
      };

      if (data.storageMode === 'computed') {
        params.computeConfig = data.computeConfig as ComputeConfigState;
      } else {
        params.metadata =
          data.selectedType === 'button'
            ? buildButtonMetadataForPersistence(data.metadata)
            : data.metadata;
      }

      await addDatasetColumn(params);

      if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
        applyLocalDatasetSchema(datasetId, [
          ...currentDataset.schema,
          buildLocalSchemaColumn(params) as any,
        ]);
      }
      handleReset();
      onSuccess();
    } catch (error: unknown) {
      setError('root', {
        type: 'manual',
        message: error instanceof Error ? error.message : '添加失败',
      });
    }
  });

  // === 配置区域渲染 ===
  const renderConfigArea = () => {
    if (!selectedType) {
      return <div className="text-gray-500 text-center py-8">请先选择字段类型</div>;
    }

    if (isComputeType(selectedType)) {
      return renderComputeConfig(selectedType as ComputeType);
    } else {
      return renderFieldConfig(selectedType as FieldType);
    }
  };

  // 渲染数据列配置
  const renderFieldConfig = (type: FieldType) => {
    switch (type) {
      case 'text':
        return (
          <div className="space-y-4">
            <Controller
              name="nullable"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={field.value} onChange={field.onChange} />
                  <span>允许为空</span>
                </label>
              )}
            />
            <div>
              <label className="block text-sm font-medium mb-2">默认值</label>
              <Controller
                name="metadata.defaultValue"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="留空则无默认值"
                    value={field.value || ''}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>
        );

      case 'number':
        return (
          <div className="space-y-4">
            <Controller
              name="nullable"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={field.value} onChange={field.onChange} />
                  <span>允许为空</span>
                </label>
              )}
            />
            <div>
              <label className="block text-sm font-medium mb-2">数字格式</label>
              <Controller
                name="metadata.format"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={field.value || 'integer'}
                    onChange={field.onChange}
                  >
                    {NUMBER_FORMATS.map((fmt) => (
                      <option key={fmt.value} value={fmt.value}>
                        {fmt.label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">默认值</label>
              <Controller
                name="metadata.defaultValue"
                control={control}
                render={({ field }) => (
                  <input
                    type="number"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="留空则无默认值"
                    value={field.value || ''}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>
        );

      case 'date':
        return (
          <div className="space-y-4">
            <Controller
              name="nullable"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={field.value} onChange={field.onChange} />
                  <span>允许为空</span>
                </label>
              )}
            />
            <div>
              <label className="block text-sm font-medium mb-2">日期格式</label>
              <Controller
                name="metadata.dateFormat"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={field.value || 'YYYY/MM/DD'}
                    onChange={field.onChange}
                  >
                    {DATE_FORMATS.map((fmt) => (
                      <option key={fmt.value} value={fmt.value}>
                        {fmt.label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
            <Controller
              name="metadata.includeTime"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={field.value || false} onChange={field.onChange} />
                  <span>包含时间</span>
                </label>
              )}
            />
          </div>
        );

      case 'single_select':
      case 'multi_select':
        return (
          <div className="space-y-4">
            <Controller
              name="nullable"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={field.value} onChange={field.onChange} />
                  <span>允许为空</span>
                </label>
              )}
            />
            <div>
              <label className="block text-sm font-medium mb-2">选项列表</label>
              <Controller
                name="metadata.options"
                control={control}
                render={({ field }) => (
                  <textarea
                    className="w-full px-3 py-2 border rounded"
                    rows={5}
                    placeholder="每行一个选项"
                    value={(field.value || []).join('\n')}
                    onChange={(e) => {
                      const options = e.target.value.split('\n').filter((o) => o.trim());
                      field.onChange(options);
                    }}
                  />
                )}
              />
            </div>
            {type === 'multi_select' && (
              <div>
                <label className="block text-sm font-medium mb-2">分隔符</label>
                <Controller
                  name="metadata.separator"
                  control={control}
                  render={({ field }) => (
                    <input
                      type="text"
                      className="w-full px-3 py-2 border rounded"
                      value={field.value || ','}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>
            )}
          </div>
        );

      case 'attachment':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">最大文件大小（MB）</label>
              <Controller
                name="metadata.maxFileSize"
                control={control}
                render={({ field }) => (
                  <input
                    type="number"
                    className="w-full px-3 py-2 border rounded"
                    value={(field.value || 10485760) / (1024 * 1024)}
                    onChange={(e) => field.onChange(parseFloat(e.target.value) * 1024 * 1024)}
                  />
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">
                允许的文件类型（留空则不限制）
              </label>
              <Controller
                name="metadata.allowedTypes"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="例如: image/*, .pdf, .docx"
                    value={(field.value || []).join(', ')}
                    onChange={(e) => {
                      const types = e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter((t) => t);
                      field.onChange(types);
                    }}
                  />
                )}
              />
            </div>
          </div>
        );

      case 'button':
        return (
          <div className="space-y-4">
            {/* 按钮外观 */}
            <div>
              <label className="block text-sm font-medium mb-2">按钮文本</label>
              <Controller
                name="metadata.buttonLabel"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="执行"
                    value={field.value || ''}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">图标</label>
                <Controller
                  name="metadata.buttonIcon"
                  control={control}
                  render={({ field }) => (
                    <select
                      className="w-full px-3 py-2 border rounded"
                      value={field.value || '▶️'}
                      onChange={field.onChange}
                    >
                      {BUTTON_ICONS.map((icon) => (
                        <option key={icon.value} value={icon.value}>
                          {icon.value} {icon.label}
                        </option>
                      ))}
                    </select>
                  )}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">样式</label>
                <Controller
                  name="metadata.buttonVariant"
                  control={control}
                  render={({ field }) => (
                    <select
                      className="w-full px-3 py-2 border rounded"
                      value={field.value || 'primary'}
                      onChange={field.onChange}
                    >
                      {BUTTON_VARIANTS.map((variant) => (
                        <option key={variant.value} value={variant.value}>
                          {variant.label}
                        </option>
                      ))}
                    </select>
                  )}
                />
              </div>
            </div>

            {/* JS插件绑定 */}
            <div>
              <label className="block text-sm font-medium mb-2">
                JS插件 <span className="text-red-500">*</span>
              </label>
              <Controller
                name="metadata.pluginId"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={field.value || ''}
                    onChange={(e) => {
                      const pluginId = e.target.value;
                      const plugin = jsPlugins.find((p) => p.id === pluginId);
                      setSelectedPlugin(plugin ?? null);
                      field.onChange(pluginId);
                      setValue('metadata.pluginType', 'js');
                      setValue('metadata.methodId', undefined);
                    }}
                  >
                    <option value="">请选择插件</option>
                    {jsPlugins.map((plugin) => (
                      <option key={plugin.id} value={plugin.id}>
                        {plugin.name} (v{plugin.version})
                      </option>
                    ))}
                  </select>
                )}
              />
              {jsPlugins.length === 0 && (
                <p className="text-sm text-amber-600 mt-1">⚠️ 暂无可用插件，请先安装JS插件</p>
              )}
              {errors.metadata?.pluginId && (
                <p className="text-red-500 text-sm mt-1">{errors.metadata.pluginId.message}</p>
              )}
            </div>

            {/* 命令选择 */}
            {selectedPlugin && (
              <div>
                <label className="block text-sm font-medium mb-2">
                  命令 <span className="text-red-500">*</span>
                </label>
                <Controller
                  name="metadata.methodId"
                  control={control}
                  render={({ field }) => (
                    <select
                      className="w-full px-3 py-2 border rounded"
                      value={field.value || ''}
                      onChange={field.onChange}
                    >
                      <option value="">请选择命令</option>
                      {pluginCommands.map((cmd) => (
                        <option key={cmd.id} value={cmd.id}>
                          {cmd.title || cmd.id}
                        </option>
                      ))}
                    </select>
                  )}
                />
                {errors.metadata?.methodId && (
                  <p className="text-red-500 text-sm mt-1">{errors.metadata.methodId.message}</p>
                )}
              </div>
            )}

            {/* 参数说明 */}
            {(() => {
              const metadata = watch('metadata');
              return (
                metadata?.pluginId &&
                metadata?.methodId && (
                  <div className="bg-blue-50 border border-blue-200 rounded p-3">
                    <p className="text-sm font-medium text-blue-900 mb-2">📌 参数传递（固定）</p>
                    <ul className="text-sm text-blue-700 space-y-1">
                      <li>
                        • <code className="bg-blue-100 px-1 rounded">rowid</code> -
                        当前行的DuckDB行ID
                      </li>
                      <li>
                        • <code className="bg-blue-100 px-1 rounded">datasetId</code> - 当前数据表ID
                      </li>
                      <li className="text-blue-600 italic">
                        插件可通过 helpers.database.query() 查询所需数据
                      </li>
                    </ul>
                  </div>
                )
              );
            })()}

            {/* 确认消息 */}
            <div>
              <label className="block text-sm font-medium mb-2">确认消息（可选）</label>
              <Controller
                name="metadata.confirmMessage"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="确定要执行此操作吗？"
                    value={field.value || ''}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>

            {/* 显示结果 */}
            <Controller
              name="metadata.showResult"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={field.value !== false}
                    onChange={field.onChange}
                  />
                  <span>显示执行结果</span>
                </label>
              )}
            />
          </div>
        );

      default:
        return null;
    }
  };

  // 渲染计算列配置
  const renderComputeConfig = (type: ComputeType) => {
    switch (type) {
      case 'amount':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">单价字段</label>
              <Controller
                name="computeConfig.params.priceField"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  >
                    <option value="">请选择字段</option>
                    {numericFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">数量字段</label>
              <Controller
                name="computeConfig.params.quantityField"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  >
                    <option value="">请选择字段</option>
                    {numericFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
          </div>
        );

      case 'discount':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">折扣类型</label>
              <Controller
                name="computeConfig.params.discountType"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : 'percentage'}
                    onChange={field.onChange}
                  >
                    <option value="percentage">折扣率（%）</option>
                    <option value="amount">折扣额</option>
                  </select>
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">原价字段</label>
              <Controller
                name="computeConfig.params.originalPriceField"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  >
                    <option value="">请选择字段</option>
                    {numericFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">折后价字段</label>
              <Controller
                name="computeConfig.params.discountedPriceField"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  >
                    <option value="">请选择字段</option>
                    {numericFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
          </div>
        );

      case 'bucket':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">数值字段</label>
              <Controller
                name="computeConfig.params.field"
                control={control}
                render={({ field }) => (
                  <select
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  >
                    <option value="">请选择字段</option>
                    {numericFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">分组边界（逗号分隔）</label>
              <Controller
                name="computeConfig.params.boundaries"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="例如: 0,100,200"
                    value={Array.isArray(field.value) ? field.value.join(',') : ''}
                    onChange={(e) => {
                      const boundaries = e.target.value
                        .split(',')
                        .map((n) => parseFloat(n.trim()))
                        .filter((n) => !isNaN(n));
                      field.onChange(boundaries);
                    }}
                  />
                )}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">分组标签（逗号分隔）</label>
              <Controller
                name="computeConfig.params.labels"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    placeholder="例如: 低,中,高"
                    value={Array.isArray(field.value) ? field.value.join(',') : ''}
                    onChange={(e) => {
                      const labels = e.target.value
                        .split(',')
                        .map((l) => l.trim())
                        .filter((l) => l);
                      field.onChange(labels);
                    }}
                  />
                )}
              />
            </div>
          </div>
        );

      case 'concat':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">选择要拼接的字段</label>
              <Controller
                name="computeConfig.params.fields"
                control={control}
                render={({ field }) => {
                  const selectedFields: string[] = Array.isArray(field.value)
                    ? (field.value as string[])
                    : [];
                  return (
                    <div className="space-y-2 max-h-40 overflow-y-auto border rounded p-2">
                      {availableFields.map((f) => (
                        <label key={f.name} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedFields.includes(f.name)}
                            onChange={(e) => {
                              const newFields = e.target.checked
                                ? [...selectedFields, f.name]
                                : selectedFields.filter((name) => name !== f.name);
                              field.onChange(newFields);
                            }}
                          />
                          <span>{f.name}</span>
                        </label>
                      ))}
                    </div>
                  );
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">分隔符</label>
              <Controller
                name="computeConfig.params.separator"
                control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border rounded"
                    value={typeof field.value === 'string' ? field.value : ' '}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>
        );

      case 'custom':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">SQL 表达式</label>
              <Controller
                name="computeConfig.expression"
                control={control}
                render={({ field }) => (
                  <>
                    <textarea
                      className="w-full px-3 py-2 border rounded font-mono text-sm"
                      rows={6}
                      placeholder="例如: CASE WHEN amount > 1000 THEN '大额' ELSE '小额' END"
                      value={field.value || ''}
                      onChange={field.onChange}
                    />
                    {errors.computeConfig?.expression && (
                      <p className="text-red-500 text-sm mt-1">
                        {errors.computeConfig.expression.message}
                      </p>
                    )}
                  </>
                )}
              />
              <p className="text-xs text-gray-500 mt-1">可以引用任何现有列名，支持标准SQL函数</p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // 验证是否可以提交（简化，大部分验证由 zod 处理）
  const canSubmit = () => {
    const columnName = watch('columnName');
    const metadata = watch('metadata');
    const computeConfig = watch('computeConfig');

    if (!columnName || !selectedType || isSubmitting) return false;

    if (storageMode === 'computed') {
      // 🆕 增强计算列验证
      switch (selectedType) {
        case 'custom':
          return !!computeConfig?.expression;
        case 'amount':
          return !!computeConfig?.params?.priceField && !!computeConfig?.params?.quantityField;
        case 'discount':
          return (
            !!computeConfig?.params?.originalPriceField &&
            !!computeConfig?.params?.discountedPriceField
          );
        case 'bucket':
          return (
            !!computeConfig?.params?.field &&
            Array.isArray(computeConfig?.params?.boundaries) &&
            (computeConfig.params.boundaries as number[]).length > 0 &&
            Array.isArray(computeConfig?.params?.labels) &&
            (computeConfig.params.labels as string[]).length > 0
          );
        case 'concat':
          return (
            Array.isArray(computeConfig?.params?.fields) &&
            (computeConfig.params.fields as string[]).length > 0
          );
        default:
          return true;
      }
    } else {
      if (selectedType === 'button') {
        return !!metadata?.pluginId && !!metadata?.methodId;
      }
      return true;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleReset}
      title="添加列"
      maxWidth="lg"
      footer={
        <>
          <Button onClick={handleReset} variant="outline" disabled={isSubmitting}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit()}>
            {isSubmitting ? '添加中...' : '添加列'}
          </Button>
        </>
      }
    >
      <div style={{ height: '600px', display: 'flex', flexDirection: 'column' }}>
        {/* 固定区域：列名和类型选择 */}
        <div style={{ flexShrink: 0, paddingBottom: '16px' }}>
          {/* 列名 */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">列名 *</label>
            <Controller
              name="columnName"
              control={control}
              render={({ field }) => (
                <input
                  type="text"
                  className="w-full px-3 py-2 border rounded"
                  placeholder="请输入列名"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {errors.columnName && (
              <p className="text-red-500 text-sm mt-1">{errors.columnName.message}</p>
            )}
          </div>

          {/* 字段类型 */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">字段类型 *</label>
            <Controller
              name="selectedType"
              control={control}
              render={({ field }) => (
                <select
                  className="w-full px-3 py-2 border rounded"
                  value={field.value}
                  onChange={field.onChange}
                >
                  <option value="">请选择类型</option>
                  <optgroup label="━━━ 数据列 ━━━">
                    {FIELD_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.icon} {type.label} - {type.description}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="━━━ 计算列 ━━━">
                    {COMPUTE_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.icon} {type.label} - {type.description}
                      </option>
                    ))}
                  </optgroup>
                </select>
              )}
            />
            {errors.selectedType && (
              <p className="text-red-500 text-sm mt-1">{errors.selectedType.message}</p>
            )}
          </div>
        </div>

        {/* 可滚动配置区域 */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
          }}
        >
          {renderConfigArea()}
        </div>

        {/* 错误提示 */}
        {errors.root && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-600 text-sm">
            {errors.root.message}
          </div>
        )}
      </div>
    </Dialog>
  );
}
