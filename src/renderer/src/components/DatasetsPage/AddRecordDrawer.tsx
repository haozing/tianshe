/**
 * Add Record Drawer Component
 * 右侧滑出的表单，用于添加新记录
 * 使用 react-hook-form 管理单条记录表单（form tab）
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { X, Plus, Calendar, Paperclip, FileText, Upload, Zap } from 'lucide-react';
import { useDatasetStore } from '../../stores/datasetStore';
import {
  batchInsertDatasetRecords,
  importDatasetRecordsFromBase64,
  importDatasetRecordsFromFile,
  insertDatasetRecord,
  updateDatasetColumnMetadata,
} from '../../services/datasets/datasetMutationService';
import {
  datasetEvents,
  type DatasetImportRecordsProgressEvent,
} from '../../services/datasets/datasetEvents';
import { useEventSubscription } from '../../hooks/useElectronAPI';
import { SingleSelectField } from './fields/SingleSelectField';
import { MultiSelectField } from './fields/MultiSelectField';
import { DatePickerField } from './fields/DatePickerField';
import { AttachmentField } from './fields/AttachmentField';
import { ButtonField } from './fields/ButtonField';
import { ButtonFieldConfig } from './fields/ButtonFieldConfig';
import { buildPatchedColumnSchema } from './schemaPatch';
import { DataParser } from '../../utils/data-parser';
import {
  filterSystemFields,
  filterSystemFieldsFromArray,
  filterSystemFieldsFromSchema,
  filterWritableFieldsFromSchema,
  normalizeRecordValues,
  normalizeRecordsArray,
  validateRecord,
  validateRecords,
  formatUserFriendlyError,
} from '../../utils/field-utils';
import { toast } from '../../lib/toast';

interface AddRecordDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  datasetId: string;
  readOnly?: boolean;
  onSubmitSuccess?: (options?: {
    refreshView?: boolean;
    refreshWorkspace?: boolean;
  }) => void;
}

type TabType = 'form' | 'file';

type DatasetFieldType =
  | 'text'
  | 'hyperlink'
  | 'number'
  | 'single_select'
  | 'multi_select'
  | 'date'
  | 'attachment'
  | 'button';

type FormValue = string | number | boolean | string[] | null | undefined;
type FormData = Record<string, FormValue>;

interface ColumnMetadata {
  options?: string[];
  colorMap?: Record<string, string>;
  separator?: string;
  includeTime?: boolean;
  [key: string]: unknown;
}

interface ColumnSchema {
  name: string;
  fieldType?: DatasetFieldType;
  duckdbType?: string;
  metadata?: ColumnMetadata | null;
  storageMode?: 'physical' | 'computed';
  computeConfig?: Record<string, unknown> | null;
  locked?: boolean;
}

type FileWithPath = File & { path?: string };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof btoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  const bufferCtor = (globalThis as any).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString('base64');
  }
  throw new Error('Base64 encoder is not available');
}

export function AddRecordDrawer({
  isOpen,
  onClose,
  datasetId,
  readOnly = false,
  onSubmitSuccess,
}: AddRecordDrawerProps) {
  const {
    currentDataset,
    queryResult,
    getDatasetInfo,
    applyLocalDatasetSchema,
    applyLocalRecordInsert,
  } = useDatasetStore();
  const [activeTab, setActiveTab] = useState<TabType>('form');
  const [continueAdding, setContinueAdding] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [configuringButtonField, setConfiguringButtonField] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<number>(0);
  const [importMessage, setImportMessage] = useState<string>('');
  const [isBatchSubmitting, setIsBatchSubmitting] = useState(false); // 批量导入状态

  // 使用 react-hook-form 管理单条记录表单数据
  const {
    watch,
    setValue,
    reset,
    handleSubmit: createHandleSubmit,
    formState: { isSubmitting },
  } = useForm<FormData>({
    defaultValues: {},
  });

  // 获取所有表单值
  const formData = watch();

  // 根据当前tab决定使用哪个submitting状态
  const currentSubmitting = activeTab === 'form' ? isSubmitting : isBatchSubmitting;
  const fieldInputClassName =
    'flex-1 rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-sm text-slate-700 transition-colors focus:border-sky-200 focus:bg-white focus:outline-none';
  const drawerLabelClassName = 'text-sm text-slate-700';

  useEventSubscription<DatasetImportRecordsProgressEvent>(
    datasetEvents.subscribeToImportRecordsProgress,
    (progress) => {
      if (progress.datasetId !== datasetId) return;
      setImportProgress(progress.progress);
      setImportMessage(progress.message || '');
    }
  );

  // 🔄 当抽屉打开时，重置所有状态和表单数据
  useEffect(() => {
    if (isOpen) {
      // 1️⃣ 重置提交相关状态
      setImportProgress(0);
      setImportMessage('');

      // 2️⃣ 重置文件上传状态
      setPastedText('');
      setUploadedFiles([]);
      setActiveTab('form');
      setConfiguringButtonField(null);

      // 3️⃣ 使用 reset() 重置表单数据
      if (currentDataset?.schema) {
        const initialData: FormData = {};
        const userFields = getWritableSchema();
        userFields.forEach((col) => {
          initialData[col.name] = '';
        });
        reset(initialData);
      }
    }
  }, [isOpen, currentDataset, reset]);

  const handleFieldChange = (fieldName: string, value: FormValue) => {
    setValue(fieldName, value);
  };

  // 获取列的所有唯一值（用于单选/多选字段）
  const getColumnUniqueValues = (columnName: string): string[] => {
    if (!queryResult || !queryResult.rows || queryResult.rows.length === 0) {
      return [];
    }

    const uniqueValues = Array.from(
      new Set(
        queryResult.rows
          .map((row) => {
            const record = row as Record<string, unknown>;
            return record[columnName];
          })
          .filter((val) => val !== null && val !== undefined && val !== '')
          .map((val) => String(val))
      )
    ).sort();

    return uniqueValues;
  };

  const getStringValue = (value: FormValue): string => (typeof value === 'string' ? value : '');
  const getWritableSchema = (): ColumnSchema[] =>
    filterWritableFieldsFromSchema((currentDataset?.schema || []) as ColumnSchema[]);

  const persistColumnMetadata = async (columnName: string, metadata: ColumnMetadata) => {
    await updateDatasetColumnMetadata(datasetId, columnName, metadata);

    if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
      applyLocalDatasetSchema(
        datasetId,
        buildPatchedColumnSchema(currentDataset.schema as any, columnName, { metadata }) as any
      );
      return;
    }

    await getDatasetInfo(datasetId);
  };

  const handleSubmit = createHandleSubmit(async (data) => {
    if (!datasetId) return;
    if (readOnly) {
      toast.warning('数据未就绪，暂不支持新增记录');
      return;
    }

    try {
      // ✅ 过滤掉系统字段（双重保险：前端已经不展示，这里再次过滤）
      const writableSchema = getWritableSchema();
      const writableFieldNames = new Set(writableSchema.map((col) => col.name));
      const cleanedFormData = Object.fromEntries(
        Object.entries(filterSystemFields<FormData>(data)).filter(([key]) =>
          writableFieldNames.has(key)
        )
      ) as FormData;

      // 🆕 验证数据类型
      const validation = validateRecord(cleanedFormData, writableSchema);
      if (!validation.isValid) {
        toast.error('数据验证失败', validation.errors.join('\n'));
        return;
      }

      // ✅ 规范化空值：空字符串在非文本字段中转换为 NULL
      const normalizedData = normalizeRecordValues(cleanedFormData, writableSchema);

      await insertDatasetRecord(datasetId, normalizedData);

      const localInsert = applyLocalRecordInsert(datasetId, normalizedData);
      onSubmitSuccess?.({
        refreshView: !localInsert.rowAppended,
        refreshWorkspace: !localInsert.countUpdated,
      });

      if (continueAdding) {
        // 使用 reset() 重置表单继续添加
        const resetData: FormData = {};
        writableSchema.forEach((col) => {
          resetData[col.name] = '';
        });
        reset(resetData);
        // 🆕 添加成功提示
        toast.success('记录添加成功！');
      } else {
        // 关闭抽屉
        onClose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 🆕 使用用户友好的错误消息
      const friendlyError = formatUserFriendlyError(message);
      toast.error('添加失败', friendlyError);
    }
  });

  /**
   * 处理批量提交（文件上传或粘贴内容）
   * 文件上传始终走后端导入，避免 CSV 字段包含逗号导致前端解析错列。
   */
  const handleBatchSubmit = async () => {
    if (!datasetId) return;
    if (readOnly) {
      toast.warning('数据未就绪，暂不支持新增记录');
      return;
    }

    setIsBatchSubmitting(true);
    setImportProgress(0);
    setImportMessage('');

    try {
      let useBackendImport = false;
      let filePath = '';
      let fileToImport: File | null = null;

      // 优先处理文件上传（始终走后端）
      if (uploadedFiles.length > 0) {
        const file = uploadedFiles[0];
        fileToImport = file;
        // 获取文件的真实路径（通过 file.path 属性，electron 环境下可用）
        const fileWithPath: FileWithPath = file;
        filePath = fileWithPath.path || '';

        useBackendImport = true;
      }

      if (useBackendImport) {
        // 🔥 后端处理（支持 CSV/Excel、编码检测）
        let result: { success: boolean; recordsInserted?: number } | null = null;
        if (filePath) {
          result = await importDatasetRecordsFromFile(datasetId, filePath);
        } else if (fileToImport) {
          const buffer = await fileToImport.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          result = await importDatasetRecordsFromBase64(datasetId, base64, fileToImport.name);
        }

        if (!result) {
          toast.error('无法获取文件路径', '请使用「选择文件」按钮重新选择文件');
          return;
        }

        const localInsert = applyLocalRecordInsert(datasetId, {}, {
          insertedCount: result.recordsInserted ?? 1,
        });
        toast.success(`成功导入 ${result.recordsInserted} 条记录！`);
        onSubmitSuccess?.({
          refreshView: true,
          refreshWorkspace: !localInsert.countUpdated,
        });
        setUploadedFiles([]);
        setPastedText('');
        onClose();
      } else {
        // 前端处理（仅粘贴内容）
        let contentToParse = '';

        if (pastedText.trim()) {
          // 粘贴内容
          contentToParse = pastedText;
        } else {
          // 两者都没有
          toast.warning('请先粘贴数据或选择文件');
          return;
        }

        // 解析数据
        const userFields = getWritableSchema();
        const expectedColumns = userFields.map((col) => col.name);
        const parseResult = DataParser.parse(contentToParse, expectedColumns);

        if (!parseResult.success) {
          toast.error('数据解析失败', `${parseResult.error}，请确保数据格式正确`);
          return;
        }

        if (parseResult.data.length === 0) {
          toast.warning('没有有效的数据');
          return;
        }

        // 批量插入
        const cleanedRecords = filterSystemFieldsFromArray(parseResult.data);
        const writableSchema = getWritableSchema();

        // 🆕 验证数据类型
        const validation = validateRecords(cleanedRecords, writableSchema);
        if (!validation.isValid) {
          // 限制显示的错误数量，避免弹窗过长
          const maxErrors = 10;
          const displayErrors = validation.errors.slice(0, maxErrors);
          const remaining = validation.errors.length - maxErrors;
          let errorMessage = displayErrors.join('\n');
          if (remaining > 0) {
            errorMessage += `\n...还有 ${remaining} 个错误`;
          }
          toast.error('数据验证失败', errorMessage);
          setIsBatchSubmitting(false);
          return;
        }

        const normalizedRecords = normalizeRecordsArray(cleanedRecords, writableSchema);

        await batchInsertDatasetRecords(datasetId, normalizedRecords);

        const localInsert = applyLocalRecordInsert(datasetId, {}, {
          insertedCount: parseResult.data.length,
        });
        toast.success(`成功添加 ${parseResult.data.length} 条记录！`);
        onSubmitSuccess?.({
          refreshView: true,
          refreshWorkspace: !localInsert.countUpdated,
        });
        setPastedText('');
        setUploadedFiles([]);
        onClose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 🆕 使用用户友好的错误消息
      const friendlyError = formatUserFriendlyError(message);
      toast.error('操作失败', friendlyError);
    } finally {
      setIsBatchSubmitting(false);
      setImportProgress(0);
      setImportMessage('');
    }
  };

  // 获取字段类型图标
  const getFieldIcon = (fieldType: DatasetFieldType | undefined) => {
    switch (fieldType) {
      case 'text':
      case 'hyperlink':
        return <span className="text-gray-400 text-sm font-medium">A=</span>;
      case 'number':
        return <span className="text-gray-400 text-sm font-medium">#</span>;
      case 'single_select':
        return <span className="text-gray-400 text-lg">○</span>;
      case 'multi_select':
        return <span className="text-gray-400 text-lg">○</span>;
      case 'date':
        return <Calendar className="w-4 h-4 text-gray-400" />;
      case 'attachment':
        return <Paperclip className="w-4 h-4 text-gray-400" />;
      case 'button':
        return <Zap className="w-4 h-4 text-gray-400" />;
      default:
        return <span className="text-gray-400 text-sm font-medium">A=</span>;
    }
  };

  const renderFieldInput = (column: ColumnSchema) => {
    const { name, fieldType, metadata } = column;
    const value = getStringValue(formData[name]);

    // 根据字段类型渲染不同的输入控件
    switch (fieldType) {
      case 'text':
      case 'hyperlink':
        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <input
              type="text"
              value={value}
              onChange={(e) => handleFieldChange(name, e.target.value)}
              placeholder="请输入内容"
              className={fieldInputClassName}
            />
          </div>
        );

      case 'number':
        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <input
              type="number"
              value={value}
              onChange={(e) => handleFieldChange(name, e.target.value)}
              placeholder="请输入内容"
              className={fieldInputClassName}
            />
          </div>
        );

      case 'single_select': {
        // 合并预设选项和实际数据中的唯一值
        const uniqueValues = getColumnUniqueValues(name);
        const predefinedOptions = metadata?.options || [];
        const allOptions = Array.from(new Set([...predefinedOptions, ...uniqueValues])).sort();

        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <div className="flex-1">
              <SingleSelectField
                value={value}
                options={allOptions}
                colorMap={metadata?.colorMap}
                onChange={(newValue) => handleFieldChange(name, newValue)}
                onCreateOption={(newOption) => {
                  const nextMetadata: ColumnMetadata = {
                    ...(metadata || {}),
                    options: Array.from(new Set([...(metadata?.options || []), newOption])).sort(),
                  };

                  void persistColumnMetadata(name, nextMetadata).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    toast.error('更新选项失败', message);
                  });
                }}
              />
            </div>
          </div>
        );
      }

      case 'multi_select': {
        // 合并预设选项和实际数据中的唯一值
        const multiUniqueValues = getColumnUniqueValues(name);
        const multiPredefinedOptions = metadata?.options || [];
        const multiAllOptions = Array.from(
          new Set([...multiPredefinedOptions, ...multiUniqueValues])
        ).sort();

        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <div className="flex-1">
              <MultiSelectField
                value={value}
                options={multiAllOptions}
                separator={metadata?.separator || ','}
                onChange={(newValue) => handleFieldChange(name, newValue)}
              />
            </div>
          </div>
        );
      }

      case 'date':
        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <div className="flex-1">
              <DatePickerField
                value={value}
                includeTime={metadata?.includeTime}
                onChange={(newValue) => handleFieldChange(name, newValue)}
              />
            </div>
          </div>
        );

      case 'attachment':
        return (
          <div key={name} className="flex items-start gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0 pt-2">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <div className="flex-1">
              <AttachmentField
                value={value}
                datasetId={datasetId}
                onChange={(newValue) => handleFieldChange(name, newValue)}
              />
            </div>
          </div>
        );

      case 'button':
        return (
          <div key={name} className="flex items-start gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0 pt-2">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <div className="flex-1">
              <ButtonField
                metadata={metadata}
                onConfigure={() => setConfiguringButtonField(name)}
              />
              {/* Button Configuration Modal */}
              {configuringButtonField === name && (
                <div className="shell-floating-backdrop fixed inset-0 z-[100] flex items-center justify-center">
                  <div className="shell-floating-panel flex max-h-[90vh] w-[600px] flex-col">
                    {/* Modal Header */}
                    <div className="shell-floating-panel__header flex items-center justify-between px-6 py-4">
                      <h3 className="text-lg font-semibold text-slate-900">配置按钮字段</h3>
                      <button
                        onClick={() => setConfiguringButtonField(null)}
                        className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    {/* Modal Content */}
                    <div className="flex-1 overflow-y-auto px-6 py-4">
                      <ButtonFieldConfig
                        value={metadata || {}}
                        columns={filterSystemFieldsFromSchema(
                          (currentDataset?.schema || []) as ColumnSchema[]
                        ).map((col) => ({
                          name: col.name,
                          type: col.fieldType || col.duckdbType || 'text',
                        }))}
                        onChange={async (newConfig) => {
                          try {
                            await persistColumnMetadata(name, newConfig);
                          } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            toast.error('配置保存失败', message);
                          }
                        }}
                      />
                    </div>
                    {/* Modal Footer */}
                    <div className="shell-floating-panel__footer flex justify-end gap-3 px-6 py-4">
                      <button
                        onClick={() => setConfiguringButtonField(null)}
                        className="rounded-xl border border-white/80 bg-white/80 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-white"
                      >
                        取消
                      </button>
                      <button
                        onClick={() => setConfiguringButtonField(null)}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-800"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      default:
        return (
          <div key={name} className="flex items-center gap-4 py-1.5">
            <div className="flex items-center gap-2 w-32 flex-shrink-0">
              {getFieldIcon(fieldType)}
              <label className={drawerLabelClassName}>{name}</label>
            </div>
            <input
              type="text"
              value={value}
              onChange={(e) => handleFieldChange(name, e.target.value)}
              placeholder="请输入内容"
              className={fieldInputClassName}
            />
          </div>
        );
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="shell-floating-backdrop fixed inset-0 bg-black bg-opacity-20 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="shell-drawer-surface fixed right-0 top-0 bottom-0 z-50 flex w-[480px] flex-col">
        {/* Tab Switcher with Close Button */}
        <div className="shell-drawer-header flex items-center justify-between px-6">
          <div className="flex">
            <button
              onClick={() => setActiveTab('form')}
              className={`
                flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors
                ${
                  activeTab === 'form'
                    ? 'border-sky-500 text-sky-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }
              `}
            >
              <FileText className="w-4 h-4" />
              <span>表单</span>
            </button>
            <button
              onClick={() => setActiveTab('file')}
              className={`
                flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors
                ${
                  activeTab === 'file'
                    ? 'border-sky-500 text-sky-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }
              `}
            >
              <Upload className="w-4 h-4" />
              <span>文件&粘贴</span>
            </button>
          </div>

          {/* Close Button */}
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {activeTab === 'form' ? (
            // Form Content
            <>
              {/* ✅ 过滤掉系统字段（如 _row_id），只渲染用户可编辑的字段 */}
              {getWritableSchema().map((column) => renderFieldInput(column))}
            </>
          ) : (
            // File & Paste Content
            <div className="space-y-6">
              {/* File Upload Area */}
              <div>
                <label className="mb-3 block text-sm font-medium text-slate-700">上传文件</label>
                <div
                  className="shell-soft-card cursor-pointer border-2 border-dashed border-slate-200 p-8 text-center transition-colors hover:border-slate-300"
                  onDrop={(e) => {
                    e.preventDefault();
                    const files = Array.from(e.dataTransfer.files);
                    setUploadedFiles((prev) => [...prev, ...files]);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.multiple = true;
                    input.onchange = (event: Event) => {
                      const target = event.target as HTMLInputElement | null;
                      const files = target?.files ? Array.from(target.files) : [];
                      setUploadedFiles((prev) => [...prev, ...files]);
                    };
                    input.click();
                  }}
                >
                  <Upload className="mx-auto mb-3 h-12 w-12 text-slate-400" />
                  <p className="mb-1 text-sm text-slate-600">点击或拖拽文件到此处上传</p>
                  <p className="text-xs text-slate-400">支持 CSV、XLSX、XLS、JSON 文件</p>
                </div>

                {/* Uploaded Files List */}
                {uploadedFiles.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {uploadedFiles.map((file, idx) => (
                      <div
                        key={idx}
                        className="shell-soft-card flex items-center justify-between px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <Paperclip className="h-4 w-4 text-slate-400" />
                          <span className="text-sm text-slate-700">{file.name}</span>
                          <span className="text-xs text-slate-400">
                            ({(file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            setUploadedFiles((prev) => prev.filter((_, i) => i !== idx));
                          }}
                          className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Paste Area */}
              <div>
                <label className="mb-3 block text-sm font-medium text-slate-700">粘贴内容</label>
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder={`支持以下格式粘贴：
• Excel 表格 (复制后直接粘贴)
• CSV 格式 (逗号分隔)
• JSON 数组 [{"列名": "值"}]

示例（TSV格式）：
产品名称	价格	状态
产品A	99.9	在售
产品B	199	下架`}
                  className="h-64 w-full resize-none rounded-2xl border border-white/80 bg-white/75 px-3 py-3 font-mono text-sm text-slate-700 transition-colors focus:border-sky-200 focus:bg-white focus:outline-none"
                  style={{ whiteSpace: 'pre' }}
                />
                <p className="mt-2 text-xs text-slate-500">
                  支持从 Excel、CSV、JSON 等格式粘贴，自动识别格式。含逗号字段建议用 TSV 或 JSON
                  粘贴，避免 CSV 列错位。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shell-drawer-footer px-6 py-4">
          <div className="flex items-center justify-between">
            {/* Left side - depends on active tab */}
            {activeTab === 'form' ? (
              <button className="flex items-center gap-1 text-sm text-slate-500 transition-colors hover:text-slate-700">
                <Plus className="w-4 h-4" />
                <span>新增字段</span>
              </button>
            ) : (
              <div className="text-xs text-slate-500">
                {uploadedFiles.length > 0 && `已选择 ${uploadedFiles.length} 个文件`}
                {uploadedFiles.length === 0 && pastedText && '已输入内容'}
              </div>
            )}

            {/* Right side: checkbox and submit button */}
            <div className="flex items-center gap-3">
              {/* 只在表单模式显示"继续添加"选项 */}
              {activeTab === 'form' && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={continueAdding}
                    onChange={(e) => setContinueAdding(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                  <span>提交后继续添加记录</span>
                </label>
              )}

              <button
                onClick={activeTab === 'form' ? handleSubmit : handleBatchSubmit}
                disabled={
                  readOnly ||
                  currentSubmitting ||
                  (activeTab === 'file' && !pastedText.trim() && uploadedFiles.length === 0)
                }
                className={`
                  rounded-xl py-2 px-6 text-sm font-medium transition-all
                  ${
                    readOnly ||
                    currentSubmitting ||
                    (activeTab === 'file' && !pastedText.trim() && uploadedFiles.length === 0)
                      ? 'cursor-not-allowed bg-slate-300 text-slate-500'
                      : 'bg-slate-900 text-white hover:bg-slate-800 active:scale-95'
                  }
                `}
              >
                {currentSubmitting ? (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{activeTab === 'form' ? '提交中...' : '批量添加中...'}</span>
                  </div>
                ) : activeTab === 'form' ? (
                  '提交'
                ) : uploadedFiles.length > 0 ? (
                  `导入 ${uploadedFiles.length} 个文件`
                ) : pastedText.trim() ? (
                  '批量添加 →'
                ) : (
                  '批量添加'
                )}
              </button>
            </div>
          </div>

          {/* 进度条显示 */}
          {isBatchSubmitting && importProgress > 0 && activeTab === 'file' && (
            <div className="mt-4 space-y-2">
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-sky-600 transition-all duration-300"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
              {importMessage && (
                <p className="text-center text-xs text-slate-600">{importMessage}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
