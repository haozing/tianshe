/**
 * useDatasetFields Hook
 * 统一管理数据集字段信息的获取和计算
 * 解决Panel组件中重复的availableFields和numericFields逻辑
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDatasetStore } from '../stores/datasetStore';
import { datasetFacade } from '../services/datasets/datasetFacade';
import { isNumericType } from '../lib/field-type-helpers';

export interface FieldInfo {
  name: string;
  type: string;
  fieldType: string;
}

export interface UseDatasetFieldsOptions {
  /**
   * 是否需要计算数值字段
   * 默认: false
   */
  includeNumericFields?: boolean;
}

export interface UseDatasetFieldsResult {
  /**
   * 所有可用字段
   */
  availableFields: FieldInfo[];

  /**
   * 数值类型字段（仅当 includeNumericFields=true 时计算）
   */
  numericFields?: FieldInfo[];

  /**
   * 当前数据集信息
   */
  currentDataset: any;

  /**
   * 是否正在加载
   */
  isLoading: boolean;
}

interface DatasetSchemaField {
  name: string;
  duckdbType: string;
  fieldType?: string;
}

interface DatasetInfoLike {
  id: string;
  schema?: DatasetSchemaField[];
}

/**
 * 自定义Hook: 获取数据集字段信息
 *
 * @param datasetId - 数据集ID
 * @param options - 配置选项
 * @returns 字段信息和数据集状态
 *
 * @example
 * ```tsx
 * // 基础使用
 * const { availableFields, currentDataset } = useDatasetFields(datasetId);
 *
 * // 包含数值字段
 * const { availableFields, numericFields } = useDatasetFields(datasetId, {
 *   includeNumericFields: true
 * });
 * ```
 */
export function useDatasetFields(
  datasetId: string,
  options: UseDatasetFieldsOptions = {}
): UseDatasetFieldsResult {
  const { includeNumericFields = false } = options;
  const currentDataset = useDatasetStore((state) => state.currentDataset);
  const [loadedDataset, setLoadedDataset] = useState<DatasetInfoLike | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  const scopedCurrentDataset =
    currentDataset?.id === datasetId && Array.isArray(currentDataset?.schema)
      ? currentDataset
      : null;

  useEffect(() => {
    if (!datasetId) {
      setLoadedDataset(null);
      setLoading(false);
      return;
    }

    if (scopedCurrentDataset) {
      setLoadedDataset(scopedCurrentDataset);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = ++requestIdRef.current;
    setLoading(true);

    void datasetFacade
      .getDatasetInfo(datasetId)
      .then((response) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setLoadedDataset(
          response.success ? ((response.dataset as DatasetInfoLike | undefined) ?? null) : null
        );
      })
      .catch(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setLoadedDataset(null);
      })
      .finally(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [datasetId, scopedCurrentDataset]);

  const resolvedDataset = scopedCurrentDataset ?? loadedDataset;
  const hasDatasetSchema = Array.isArray(resolvedDataset?.schema);

  // 计算所有可用字段
  const availableFields = useMemo(() => {
    if (!resolvedDataset?.schema) return [];
    return resolvedDataset.schema.map((col: DatasetSchemaField) => ({
      name: col.name,
      type: col.duckdbType,
      fieldType: col.fieldType || 'text',
    }));
  }, [resolvedDataset]);

  // 计算数值字段（按需）
  const numericFields = useMemo(() => {
    if (!includeNumericFields) return undefined;
    return availableFields.filter((field: FieldInfo) => isNumericType(field.type));
  }, [availableFields, includeNumericFields]);

  // 判断是否正在加载
  const isLoading = useMemo(() => {
    return Boolean(datasetId) && !hasDatasetSchema && loading;
  }, [datasetId, hasDatasetSchema, loading]);

  return {
    availableFields,
    numericFields,
    currentDataset: resolvedDataset,
    isLoading,
  };
}
