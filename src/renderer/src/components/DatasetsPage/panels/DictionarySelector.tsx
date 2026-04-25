/**
 * 词库选择器
 * 用于选择黑名单/白名单词库数据集
 */
import { useState, useEffect } from 'react';
import { Database, FileText } from 'lucide-react';
import {
  getDatasetFieldNames,
  listDatasetSummaries,
} from '../../../services/datasets/datasetPanelService';

interface DictionarySelectorProps {
  datasetId?: string; // 选中的数据集ID
  fieldName?: string; // 选中的字段名
  onChange: (datasetId: string, fieldName: string) => void;
}

export function DictionarySelector({ datasetId, fieldName, onChange }: DictionarySelectorProps) {
  const [datasets, setDatasets] = useState<any[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [datasetInfo, setDatasetInfo] = useState<any>(null);

  // 加载所有数据集
  useEffect(() => {
    loadDatasets();
  }, []);

  // 加载选中数据集的字段和信息
  useEffect(() => {
    if (datasetId) {
      loadFields(datasetId);
      loadDatasetInfo(datasetId);
    } else {
      setFields([]);
      setDatasetInfo(null);
    }
  }, [datasetId]);

const loadDatasets = async () => {
    try {
      setDatasets(await listDatasetSummaries());
    } catch (error) {
      console.error('[DictionarySelector] Failed to load datasets:', error);
    }
  };

const loadFields = async (id: string) => {
    try {
      setLoading(true);
      const columnNames = await getDatasetFieldNames(id);
      setFields(columnNames);

      // 如果还没有选中字段，自动选择第一个
      if (!fieldName && columnNames.length > 0) {
        onChange(id, columnNames[0]);
      }
    } catch (error) {
      console.error('[DictionarySelector] Failed to load fields:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadDatasetInfo = async (id: string) => {
    try {
      const dataset = datasets.find((ds) => ds.id === id);
      setDatasetInfo(dataset);
    } catch (error) {
      console.error('[DictionarySelector] Failed to load dataset info:', error);
    }
  };

  const handleDatasetChange = (id: string) => {
    onChange(id, '');
  };

  const handleFieldChange = (field: string) => {
    if (datasetId) {
      onChange(datasetId, field);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
        <div className="flex-1">
          <select
            value={datasetId || ''}
            onChange={(e) => handleDatasetChange(e.target.value)}
            className="shell-field-input w-full px-3 py-2 text-sm"
          >
            <option value="">选择词库数据集</option>
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.rowCount?.toLocaleString() || 0} 行)
              </option>
            ))}
          </select>
        </div>

        {datasetId && (
          <div className="w-full">
            <select
              value={fieldName || ''}
              onChange={(e) => handleFieldChange(e.target.value)}
              disabled={loading || fields.length === 0}
              className="shell-field-input w-full px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="">选择字段</option>
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {datasetId && datasetInfo && (
        <div className="shell-soft-card flex items-center gap-4 px-4 py-3 text-xs text-slate-600">
          <div className="flex items-center gap-1">
            <Database className="w-3.5 h-3.5" />
            <span>{datasetInfo.rowCount?.toLocaleString() || 0} 个词</span>
          </div>
          {datasetInfo.updatedAt && (
            <div className="flex items-center gap-1">
              <FileText className="w-3.5 h-3.5" />
              <span>更新于 {new Date(datasetInfo.updatedAt).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      )}

      {!datasetId && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-500">
          请选择一个包含黑名单/白名单词的数据集
        </div>
      )}
    </div>
  );
}
