/**
 * Dataset Table Component
 * TanStack Table-based table with editing, column management, and incremental loading
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';

import { selectActiveQueryConfig, useDatasetStore } from '../../stores/datasetStore';
import {
  deleteDatasetColumn,
  reorderDatasetColumns,
  updateDatasetColumn,
  updateDatasetColumnDisplayConfig,
  updateDatasetRecord,
} from '../../services/datasets/datasetMutationService';
import { TanStackDataTable } from './TanStackDataTable';
import { createColumnsFromSchema } from './TanStackDataTable/columns';
import type { ColumnSchema } from './TanStackDataTable/columns';
import { buildDeletedSchema, buildRenamedSchema } from './schemaPatch';
import { toast } from '../../lib/toast';
import { isSystemField, isVirtualColumnFieldType, isWritableColumn } from '../../utils/field-utils';
import {
  getDisplayHiddenColumnNames,
  getMergedHiddenColumnNames,
  normalizeColumnNameList,
} from '../../../../utils/dataset-column-capabilities';
import type { QueryConfig } from '../../../../core/query-engine/types';

type DatasetRow = Record<string, unknown>;
const isInternalGroupHelperColumn = (columnName: string) => columnName.startsWith('__group_');

type QueryAwareColumnSchema = ColumnSchema & {
  metadata?: ColumnSchema['metadata'] & {
    querySourceName?: string;
    queryDerived?: boolean;
  };
};

interface DatasetTableProps {
  datasetId: string;
  rowHeight?: 'normal' | 'compact' | 'comfortable' | number;
  onRowSelectionChange?: (selectedRows: DatasetRow[]) => void;
  onAddColumn?: () => void;
  showColumnManager?: boolean; // 是否显示列管理面板
  onColumnManagerChange?: (show: boolean) => void; // 列管理面板显示状态变化回调
  readOnly?: boolean; // 只读模式（数据未就绪时）
}

export function DatasetTable({
  datasetId,
  rowHeight = 'normal',
  onRowSelectionChange,
  onAddColumn,
  showColumnManager = false,
  onColumnManagerChange,
  readOnly = false,
}: DatasetTableProps) {
  const {
    queryResult,
    refreshDatasetView,
    currentDataset,
    clearQueryResult,
    loadMoreData,
    hasMore,
    loadingMore,
    applyLocalDatasetSchema,
    applyLocalRecordUpdate,
    updateActiveQueryTemplate,
  } = useDatasetStore();
  const activeQueryConfig = useDatasetStore(selectActiveQueryConfig);
  const [rowData, setRowData] = useState<DatasetRow[]>([]);
  const [columnSchema, setColumnSchema] = useState<ColumnSchema[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // 单元格编辑状态
  const [savingCells, setSavingCells] = useState<Set<string>>(new Set());
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map());

  const countContext = useMemo(() => {
    const filter = activeQueryConfig?.filter;
    const hasFilter = !!filter && Array.isArray(filter.conditions) && filter.conditions.length > 0;
    const hasSample = !!activeQueryConfig?.sample;
    return { hasFilter, hasSample };
  }, [activeQueryConfig]);
  const datasetSchema = useMemo(
    () =>
      currentDataset && currentDataset.id === datasetId && Array.isArray(currentDataset.schema)
        ? currentDataset.schema
        : [],
    [currentDataset, datasetId]
  );
  const queryHiddenColumnsSet = useMemo(
    () => new Set(normalizeColumnNameList(activeQueryConfig?.columns?.hide)),
    [activeQueryConfig?.columns?.hide]
  );
  const queryShownColumnsSet = useMemo(
    () => new Set(normalizeColumnNameList(activeQueryConfig?.columns?.show)),
    [activeQueryConfig?.columns?.show]
  );
  const querySelectedColumnsSet = useMemo(
    () => new Set(normalizeColumnNameList(activeQueryConfig?.columns?.select)),
    [activeQueryConfig?.columns?.select]
  );
  const hasExplicitSelectProjection = querySelectedColumnsSet.size > 0;
  const datasetHiddenColumnsSet = useMemo(
    () => new Set(getDisplayHiddenColumnNames(datasetSchema)),
    [datasetSchema]
  );
  const schemaColumnMap = useMemo(
    () => new Map(columnSchema.map((column) => [column.name, column] as const)),
    [columnSchema]
  );
  const queryRenameDisplayToSource = useMemo(() => {
    const reverse = new Map<string, string>();
    const renameConfig = activeQueryConfig?.columns?.rename ?? {};

    for (const [sourceName, displayName] of Object.entries(renameConfig)) {
      if (
        typeof sourceName !== 'string' ||
        sourceName.length === 0 ||
        typeof displayName !== 'string' ||
        displayName.length === 0
      ) {
        continue;
      }

      if (!reverse.has(displayName)) {
        reverse.set(displayName, sourceName);
      }
    }

    return reverse;
  }, [activeQueryConfig?.columns?.rename]);
  const queryColumnRefs = useMemo(
    () =>
      (Array.isArray(queryResult?.columns) ? queryResult.columns : [])
        .filter(
          (columnName) =>
            !isSystemField(columnName) && !isInternalGroupHelperColumn(columnName)
        )
        .map((displayName) => ({
          displayName,
          sourceName: queryRenameDisplayToSource.get(displayName) ?? displayName,
        })),
    [queryRenameDisplayToSource, queryResult?.columns]
  );
  const hiddenColumnsSet = useMemo(
    () =>
      new Set(
        getMergedHiddenColumnNames(
          datasetSchema,
          activeQueryConfig?.columns?.hide,
          activeQueryConfig?.columns?.show,
          activeQueryConfig?.columns?.select
        )
      ),
    [
      activeQueryConfig?.columns?.hide,
      activeQueryConfig?.columns?.select,
      activeQueryConfig?.columns?.show,
      datasetSchema,
    ]
  );
  const hasSameColumnSet = useCallback((left: Set<string>, right: Set<string>) => {
    if (left.size !== right.size) {
      return false;
    }

    for (const value of left) {
      if (!right.has(value)) {
        return false;
      }
    }

    return true;
  }, []);
  const orderColumnNames = useCallback(
    (columnNames: Iterable<string>) => {
      const pending = new Set(normalizeColumnNameList(Array.from(columnNames)));
      const ordered: string[] = [];

      for (const column of columnSchema) {
        if (pending.delete(column.name)) {
          ordered.push(column.name);
        }
      }

      for (const columnName of pending) {
        ordered.push(columnName);
      }

      return ordered;
    },
    [columnSchema]
  );

  const refreshDatasetRef = useRef(refreshDatasetView);
  useEffect(() => {
    refreshDatasetRef.current = refreshDatasetView;
  }, [refreshDatasetView]);

  // 使用 ref 存储回调函数，避免触发 columns 的 useMemo 重复计算
  // 注意：先创建空 ref，稍后在 useEffect 中更新
  const handleCellValueChangeRef = useRef<
    ((rowId: number, columnId: string, newValue: unknown) => void) | null
  >(null);
  const handleAddColumnRef = useRef<(() => void) | null>(null);

  // Load dataset data when datasetId changes
  useEffect(() => {
    if (datasetId) {
      setLoading(true);
      // 清空旧数据，避免显示错误的数据
      setRowData([]);
      setColumnSchema([]);
      // Clear query result first
      clearQueryResult();
      void refreshDatasetView(datasetId);
    }

    // 🆕 清理函数：取消查询当组件卸载或切换数据集时
    return () => {
      if (datasetId) {
        useDatasetStore.getState().cancelQuery(datasetId);
      }
    };
  }, [datasetId, clearQueryResult, refreshDatasetView]);

  // Update column schema based on dataset schema
  useEffect(() => {
    if (!currentDataset || currentDataset.id !== datasetId) {
      return;
    }

    if (currentDataset.schema) {
      const schema: ColumnSchema[] = currentDataset.schema.map((col) => ({
        name: col.name,
        duckdbType: col.duckdbType,
        fieldType: col.fieldType,
        nullable: col.nullable,
        metadata: col.metadata,
        storageMode: col.storageMode as 'physical' | 'computed' | undefined,
        computeConfig: col.computeConfig,
        width: col.displayConfig?.width,
      }));

      // 统计有多少列缺少 fieldType
      const missingFieldType = schema.filter((col) => !col.fieldType);
      if (missingFieldType.length > 0) {
        console.warn(
          `[DatasetTable] ${missingFieldType.length} columns missing fieldType:`,
          missingFieldType.map((col) => col.name)
        );
      }
      setColumnSchema(schema);
      setLoading(false);
    } else {
      // ⚠️ 如果没有 schema，也要记录并显式设置
      console.warn('[DatasetTable] currentDataset exists but schema is missing');
      console.warn('[DatasetTable] Dataset:', {
        id: currentDataset.id,
        name: currentDataset.name,
        rowCount: currentDataset.rowCount,
        columnCount: currentDataset.columnCount,
      });
      console.warn('[DatasetTable] Setting columnSchema to empty array');
      setColumnSchema([]);
      setLoading(false);
    }
  }, [currentDataset, datasetId]);

  // Update row data based on query result
  useEffect(() => {
    if (queryResult && queryResult.rows && Array.isArray(queryResult.rows)) {
      const rows = queryResult.rows as DatasetRow[];
      setRowData(rows);
      setLoading(false);
    } else if (queryResult && queryResult.rows === undefined) {
      // 查询结果无效，设置为空数组
      setRowData([]);
      setLoading(false);
    }
  }, [queryResult]);

  // Derive display schema from actual query columns to avoid showing "blank" columns
  // when query-template projections change (e.g. aggregate/group/columns.rename).
  const displaySchema = useMemo((): QueryAwareColumnSchema[] => {
    if (queryColumnRefs.length === 0) {
      return columnSchema.filter(
        (column) => !isSystemField(column.name) && !hiddenColumnsSet.has(column.name)
      );
    }

    const queryDisplayBySource = new Map(
      queryColumnRefs.map((columnRef) => [columnRef.sourceName, columnRef.displayName] as const)
    );
    const querySourceColumnSet = new Set(queryColumnRefs.map((columnRef) => columnRef.sourceName));
    const hasRowIdentity =
      (Array.isArray(queryResult?.columns) ? queryResult.columns : []).includes('_row_id') ||
      rowData.some((row) => typeof row._row_id === 'number');
    const hasExplicitProjection = Boolean(
      activeQueryConfig?.columns &&
      ((activeQueryConfig.columns.select?.length ?? 0) > 0 ||
        Object.keys(activeQueryConfig.columns.rename ?? {}).length > 0)
    );
    const shouldRetainVirtualSchemaColumns = hasRowIdentity && !hasExplicitProjection;
    const sampleRow = rowData.length > 0 ? rowData[0] : undefined;

    const inferDuckdbType = (value: unknown): string => {
      if (typeof value === 'number') return 'DOUBLE';
      if (typeof value === 'boolean') return 'BOOLEAN';
      if (value instanceof Date) return 'TIMESTAMP';
      return 'VARCHAR';
    };

    const withQuerySourceMetadata = (
      column: ColumnSchema,
      displayName: string,
      sourceName: string,
      queryDerived: boolean
    ): QueryAwareColumnSchema => ({
      ...column,
      name: displayName,
      metadata: {
        ...(column.metadata ?? {}),
        querySourceName: sourceName,
        queryDerived,
      },
    });

    const derivedSchema: QueryAwareColumnSchema[] = [];
    const seen = new Set<string>();

    // 优先按 schema 顺序（支持后端列重排），再补充查询结果中的派生列
    for (const schemaCol of columnSchema) {
      if (isSystemField(schemaCol.name)) continue;
      if (hiddenColumnsSet.has(schemaCol.name)) continue;
      const displayName = queryDisplayBySource.get(schemaCol.name);
      if (
        !displayName &&
        !(shouldRetainVirtualSchemaColumns && isVirtualColumnFieldType(schemaCol.fieldType))
      ) {
        continue;
      }
      if (!displayName) {
        if (seen.has(schemaCol.name)) continue;
        seen.add(schemaCol.name);
        derivedSchema.push(schemaCol);
        continue;
      }
      if (seen.has(displayName)) continue;
      seen.add(displayName);
      derivedSchema.push(
        displayName === schemaCol.name
          ? schemaCol
          : withQuerySourceMetadata(schemaCol, displayName, schemaCol.name, true)
      );
    }

    for (const columnRef of queryColumnRefs) {
      if (
        hiddenColumnsSet.has(columnRef.sourceName) ||
        hiddenColumnsSet.has(columnRef.displayName) ||
        seen.has(columnRef.displayName)
      ) {
        continue;
      }
      seen.add(columnRef.displayName);

      const baseCol = schemaColumnMap.get(columnRef.sourceName);
      if (baseCol) {
        derivedSchema.push(
          columnRef.displayName === columnRef.sourceName
            ? baseCol
            : withQuerySourceMetadata(baseCol, columnRef.displayName, columnRef.sourceName, true)
        );
        continue;
      }

      const sampleValue = sampleRow ? sampleRow[columnRef.displayName] : undefined;
      derivedSchema.push({
        name: columnRef.displayName,
        duckdbType: inferDuckdbType(sampleValue),
        fieldType: 'text',
        nullable: true,
        locked: true, // query-template derived columns are read-only
        metadata: {
          description: '查询模板生成列（只读）',
          querySourceName: columnRef.sourceName,
          queryDerived: true,
        },
      });
    }

    return derivedSchema.length > 0 ? derivedSchema : columnSchema;
  }, [activeQueryConfig, columnSchema, hiddenColumnsSet, queryColumnRefs, queryResult?.columns, rowData, schemaColumnMap]);
  const displayColumnMap = useMemo(
    () => new Map(displaySchema.map((column) => [column.name, column] as const)),
    [displaySchema]
  );
  const activeGrouping = useMemo(() => {
    const groupField = activeQueryConfig?.group?.field;
    if (!groupField) {
      return [];
    }

    const displayName =
      queryColumnRefs.find((columnRef) => columnRef.sourceName === groupField)?.displayName ??
      activeQueryConfig?.columns?.rename?.[groupField] ??
      groupField;

    return displayColumnMap.has(displayName) ? [displayName] : [];
  }, [
    activeQueryConfig?.columns?.rename,
    activeQueryConfig?.group?.field,
    displayColumnMap,
    queryColumnRefs,
  ]);
  const resolveQuerySourceName = useCallback(
    (columnName: string) => {
      const metadataSource = displayColumnMap.get(columnName)?.metadata?.querySourceName;
      return metadataSource || queryRenameDisplayToSource.get(columnName) || columnName;
    },
    [displayColumnMap, queryRenameDisplayToSource]
  );
  const normalizeColumnsConfig = useCallback(
    (columns?: QueryConfig['columns']) => {
      if (!columns) {
        return undefined;
      }

      const nextSelect = orderColumnNames(normalizeColumnNameList(columns.select));
      const nextHide = orderColumnNames(normalizeColumnNameList(columns.hide));
      const nextShow = orderColumnNames(normalizeColumnNameList(columns.show));
      const nextRenameEntries = Object.entries(columns.rename ?? {}).filter(
        ([sourceName, displayName]) =>
          typeof sourceName === 'string' &&
          sourceName.length > 0 &&
          typeof displayName === 'string' &&
          displayName.length > 0 &&
          sourceName !== displayName
      );

      const nextColumnsConfig: QueryConfig['columns'] = {
        ...columns,
        select: nextSelect.length > 0 ? nextSelect : undefined,
        hide: nextHide.length > 0 ? nextHide : undefined,
        show: nextShow.length > 0 ? nextShow : undefined,
        rename: nextRenameEntries.length > 0 ? Object.fromEntries(nextRenameEntries) : undefined,
      };
      const hasColumnConfig =
        (nextColumnsConfig.select?.length ?? 0) > 0 ||
        (nextColumnsConfig.hide?.length ?? 0) > 0 ||
        (nextColumnsConfig.show?.length ?? 0) > 0 ||
        Object.keys(nextColumnsConfig.rename ?? {}).length > 0;

      return hasColumnConfig ? nextColumnsConfig : undefined;
    },
    [orderColumnNames]
  );

  const columnManagerColumns = useMemo(
    () =>
      columnSchema
        .filter((column) => !isSystemField(column.name))
        .map((column) => {
          const isSelectedInView =
            !hasExplicitSelectProjection || querySelectedColumnsSet.has(column.name);
          const isDefaultHidden = datasetHiddenColumnsSet.has(column.name);
          const isViewHidden = queryHiddenColumnsSet.has(column.name);

          return {
            id: column.name,
            header: column.name,
            duckdbType: column.duckdbType,
            isVisible: isSelectedInView && !hiddenColumnsSet.has(column.name),
            isDefaultHidden,
            isViewHidden,
            isViewForcedVisible:
              !isViewHidden &&
              (queryShownColumnsSet.has(column.name) ||
                (hasExplicitSelectProjection &&
                  isDefaultHidden &&
                  querySelectedColumnsSet.has(column.name))),
            isViewExcludedByProjection: hasExplicitSelectProjection && !querySelectedColumnsSet.has(column.name),
          };
        }),
    [
      columnSchema,
      datasetHiddenColumnsSet,
      hasExplicitSelectProjection,
      hiddenColumnsSet,
      queryHiddenColumnsSet,
      querySelectedColumnsSet,
      queryShownColumnsSet,
    ]
  );

  // Handle adding new column
  const handleAddColumn = useCallback(() => {
    onAddColumn?.();
  }, [onAddColumn]);

  const buildColumnsConfigUpdate = useCallback(
    (
      nextQueryHiddenColumns: Set<string>,
      nextQueryShownColumns: Set<string>,
      nextQuerySelectedColumns?: Set<string> | null
    ) => {
      const currentColumnsConfig = activeQueryConfig?.columns;
      const nextHide = orderColumnNames(nextQueryHiddenColumns);
      const nextShow = orderColumnNames(nextQueryShownColumns);
      const nextSelect =
        nextQuerySelectedColumns === undefined
          ? currentColumnsConfig?.select
          : nextQuerySelectedColumns && nextQuerySelectedColumns.size > 0
            ? orderColumnNames(nextQuerySelectedColumns)
            : undefined;
      const nextColumnsConfig = {
        ...currentColumnsConfig,
        select: nextSelect && nextSelect.length > 0 ? nextSelect : undefined,
        hide: nextHide.length > 0 ? nextHide : undefined,
        show: nextShow.length > 0 ? nextShow : undefined,
      };
      const hasColumnConfig =
        (nextColumnsConfig.select?.length ?? 0) > 0 ||
        (nextColumnsConfig.hide?.length ?? 0) > 0 ||
        (nextColumnsConfig.show?.length ?? 0) > 0 ||
        Object.keys(nextColumnsConfig.rename ?? {}).length > 0;

      return hasColumnConfig ? nextColumnsConfig : undefined;
    },
    [activeQueryConfig?.columns, orderColumnNames]
  );

  const handleToggleColumnVisibility = useCallback(
    async (columnId: string, nextVisible: boolean) => {
      const isDatasetHidden = datasetHiddenColumnsSet.has(columnId);
      const nextQueryHiddenColumns = new Set(queryHiddenColumnsSet);
      const nextQueryShownColumns = new Set(queryShownColumnsSet);

      if (hasExplicitSelectProjection) {
        const nextQuerySelectedColumns = new Set(querySelectedColumnsSet);

        if (!nextVisible && querySelectedColumnsSet.has(columnId) && querySelectedColumnsSet.size <= 1) {
          toast.warning('当前视图至少保留 1 列');
          return false;
        }

        if (nextVisible) {
          nextQuerySelectedColumns.add(columnId);
          nextQueryHiddenColumns.delete(columnId);
        } else {
          nextQuerySelectedColumns.delete(columnId);
        }

        nextQueryShownColumns.delete(columnId);

        const columns = buildColumnsConfigUpdate(
          nextQueryHiddenColumns,
          nextQueryShownColumns,
          nextQuerySelectedColumns
        );
        await updateActiveQueryTemplate(datasetId, { columns });
        return true;
      }

      if (nextVisible) {
        nextQueryHiddenColumns.delete(columnId);
        if (isDatasetHidden) {
          nextQueryShownColumns.add(columnId);
        } else {
          nextQueryShownColumns.delete(columnId);
        }
      } else {
        nextQueryShownColumns.delete(columnId);
        if (isDatasetHidden) {
          nextQueryHiddenColumns.delete(columnId);
        } else {
          nextQueryHiddenColumns.add(columnId);
        }
      }

      const columns = buildColumnsConfigUpdate(nextQueryHiddenColumns, nextQueryShownColumns);
      await updateActiveQueryTemplate(datasetId, { columns });
      return true;
    },
    [
      buildColumnsConfigUpdate,
      datasetHiddenColumnsSet,
      datasetId,
      hasExplicitSelectProjection,
      queryHiddenColumnsSet,
      querySelectedColumnsSet,
      queryShownColumnsSet,
      updateActiveQueryTemplate,
    ]
  );

  const handleSetDefaultColumnVisibility = useCallback(
    async (columnId: string, nextVisible: boolean) => {
      const nextDefaultHidden = !nextVisible;
      const isDatasetHidden = datasetHiddenColumnsSet.has(columnId);

      if (nextDefaultHidden === isDatasetHidden) {
        return;
      }

      const isCurrentlyVisible = !hiddenColumnsSet.has(columnId);
      const nextQueryShownColumns = new Set(queryShownColumnsSet);

      if (hasExplicitSelectProjection) {
        nextQueryShownColumns.delete(columnId);
      } else if (nextDefaultHidden) {
        if (isCurrentlyVisible && !queryHiddenColumnsSet.has(columnId)) {
          nextQueryShownColumns.add(columnId);
        }
      } else {
        nextQueryShownColumns.delete(columnId);
      }

      const queryShowChanged = !hasSameColumnSet(nextQueryShownColumns, queryShownColumnsSet);

      if (nextDefaultHidden && queryShowChanged) {
        await updateActiveQueryTemplate(datasetId, {
          columns: buildColumnsConfigUpdate(new Set(queryHiddenColumnsSet), nextQueryShownColumns),
        });
      }

      await updateDatasetColumnDisplayConfig({
        datasetId,
        columnName: columnId,
        displayConfig: {
          hidden: nextDefaultHidden,
        },
      });

      if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
        applyLocalDatasetSchema(
          datasetId,
          currentDataset.schema.map((column) =>
            column.name === columnId
              ? {
                  ...column,
                  displayConfig: {
                    ...column.displayConfig,
                    hidden: nextDefaultHidden,
                  },
                }
              : column
          )
        );
      }

      if (!nextDefaultHidden && queryShowChanged) {
        await updateActiveQueryTemplate(datasetId, {
          columns: buildColumnsConfigUpdate(new Set(queryHiddenColumnsSet), nextQueryShownColumns),
        });
      }
    },
    [
      applyLocalDatasetSchema,
      buildColumnsConfigUpdate,
      currentDataset,
      datasetHiddenColumnsSet,
      datasetId,
      hasExplicitSelectProjection,
      hasSameColumnSet,
      hiddenColumnsSet,
      queryHiddenColumnsSet,
      queryShownColumnsSet,
      updateActiveQueryTemplate,
    ]
  );

  // Handle scroll end (load more data)
  const handleScrollEnd = useCallback(() => {
    if (datasetId && hasMore && !loadingMore && !loading) {
      loadMoreData(datasetId);
    }
  }, [datasetId, hasMore, loadingMore, loading, loadMoreData]);

  // Handle cell value change
  const handleCellValueChange = useCallback(
    async (rowId: number, columnId: string, newValue: unknown) => {
      if (readOnly) {
        toast.info('数据未就绪，暂不支持直接编辑');
        return;
      }

      const targetColumn = displayColumnMap.get(columnId);
      if (targetColumn && !isWritableColumn(targetColumn)) {
        toast.info(`列 "${columnId}" 当前不可直接编辑`);
        return;
      }
      const sourceColumnId = resolveQuerySourceName(columnId);
      const persistedSourceColumn = schemaColumnMap.get(sourceColumnId);

      const cellKey = `${rowId}-${columnId}`;

      // 标记单元格为保存中
      setSavingCells((prev) => new Set(prev).add(cellKey));
      setCellErrors((prev) => {
        const newMap = new Map(prev);
        newMap.delete(cellKey);
        return newMap;
      });

      // Save to database
      try {
        await updateDatasetRecord(datasetId, rowId, {
          [persistedSourceColumn ? sourceColumnId : columnId]: newValue,
        });

        const applied = applyLocalRecordUpdate(datasetId, rowId, { [columnId]: newValue });
        if (!applied) {
          // 重新查询当前数据（模板/直查模式）以应用 clean/filter/sort 等配置
          await refreshDatasetRef.current(datasetId, { refreshSchema: false });
        }
      } catch (error) {
        console.error('[DatasetTable] Failed to update record:', error);
        const message = error instanceof Error ? error.message : '未知错误';
        setCellErrors((prev) => {
          const newMap = new Map(prev);
          newMap.set(cellKey, message);
          return newMap;
        });
        toast.error('保存失败', message);
        // Reload data
        await refreshDatasetRef.current(datasetId, { refreshSchema: false });
      } finally {
        // 清除保存中状态
        setSavingCells((prev) => {
          const newSet = new Set(prev);
          newSet.delete(cellKey);
          return newSet;
        });
      }
    },
    [applyLocalRecordUpdate, datasetId, displayColumnMap, readOnly, resolveQuerySourceName, schemaColumnMap]
  );

  const handleRenameColumn = useCallback(
    async (columnName: string, newName: string) => {
      if (readOnly) {
        toast.info('数据未就绪，暂不支持列编辑');
        return;
      }

      const trimmed = newName.trim();
      if (!trimmed || trimmed === columnName) return;
      const schema = currentDataset?.schema || [];
      const schemaColumnNames = new Set(schema.map((col) => col.name));
      const sourceColumnName = resolveQuerySourceName(columnName);
      const isQueryProjectionColumn =
        sourceColumnName !== columnName || !schemaColumnNames.has(columnName);

      const visibleDisplayColumns = new Set(displaySchema.map((column) => column.name));
      visibleDisplayColumns.delete(columnName);
      if (visibleDisplayColumns.has(trimmed)) {
        toast.warning(`列名 "${trimmed}" 已存在`);
        return;
      }

      if (isQueryProjectionColumn) {
        const nextRename = { ...(activeQueryConfig?.columns?.rename ?? {}) };
        if (trimmed === sourceColumnName) {
          delete nextRename[sourceColumnName];
        } else {
          nextRename[sourceColumnName] = trimmed;
        }

        const columns = normalizeColumnsConfig({
          ...(activeQueryConfig?.columns ?? {}),
          rename: nextRename,
        });

        await updateActiveQueryTemplate(datasetId, { columns });
        toast.success(`列已重命名为 "${trimmed}"`);
        return;
      }

      const duplicate = schema.some((col) => col.name === trimmed);
      if (duplicate) {
        toast.warning(`列名 "${trimmed}" 已存在`);
        return;
      }

      try {
        await updateDatasetColumn({
          datasetId,
          columnName,
          newName: trimmed,
        });

        if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
          applyLocalDatasetSchema(
            datasetId,
            buildRenamedSchema(currentDataset.schema as any, columnName, trimmed) as any
          );
        }

        toast.success(`列已重命名为 "${trimmed}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error('重命名失败', message);
      }
    },
    [
      readOnly,
      currentDataset,
      datasetId,
      activeQueryConfig?.columns,
      applyLocalDatasetSchema,
      displaySchema,
      normalizeColumnsConfig,
      resolveQuerySourceName,
      updateActiveQueryTemplate,
    ]
  );

  const handleDeleteColumn = useCallback(
    async (columnName: string) => {
      if (readOnly) {
        toast.info('数据未就绪，暂不支持删除列');
        return;
      }

      const schemaColumnNames = new Set((currentDataset?.schema || []).map((col) => col.name));
      const sourceColumnName = resolveQuerySourceName(columnName);
      const isQueryProjectionColumn =
        sourceColumnName !== columnName || !schemaColumnNames.has(columnName);

      if (isQueryProjectionColumn) {
        try {
          const removed = await handleToggleColumnVisibility(sourceColumnName, false);
          if (removed !== false) {
            toast.success(`列 "${columnName}" 已从当前视图移除`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toast.error('删除列失败', message);
        }
        return;
      }

      const confirmed = window.confirm(`确定要删除列 "${columnName}" 吗？\n\n该操作不可撤销。`);
      if (!confirmed) return;

      try {
        let forceDeleted = false;
        const result = await deleteDatasetColumn({
          datasetId,
          columnName,
          force: false,
        });

        if (!result.success) {
          const shouldForce = window.confirm(
            `删除失败：${result.error || '未知错误'}\n\n是否强制删除（同时删除依赖的计算列）？`
          );
          if (!shouldForce) return;

          const forced = await deleteDatasetColumn({
            datasetId,
            columnName,
            force: true,
          });

          if (!forced.success) {
            toast.error('删除失败', forced.error || '未知错误');
            return;
          }

          forceDeleted = true;
        }

        if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
          applyLocalDatasetSchema(
            datasetId,
            buildDeletedSchema(currentDataset.schema as any, columnName, {
              force: forceDeleted,
            }) as any
          );
        }

        toast.success(`列 "${columnName}" 已删除`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error('删除列失败', message);
      }
    },
    [
      readOnly,
      currentDataset,
      datasetId,
      applyLocalDatasetSchema,
      handleToggleColumnVisibility,
      resolveQuerySourceName,
    ]
  );

  const handleReorderColumns = useCallback(
    async (columnNames: string[]) => {
      if (readOnly) {
        toast.info('数据未就绪，暂不支持重排序列');
        return;
      }

      const fullSchemaOrder = (currentDataset?.schema || []).map((col) => col.name);
      const nonSystemSchemaOrder = fullSchemaOrder.filter((name) => !isSystemField(name));
      const nonSystemSchemaSet = new Set(nonSystemSchemaOrder);
      if (nonSystemSchemaOrder.length === 0) {
        toast.warning('当前数据集没有可排序列');
        return;
      }

      const normalizedVisibleOrder: string[] = [];
      const seen = new Set<string>();
      for (const name of columnNames) {
        if (!nonSystemSchemaSet.has(name) || seen.has(name)) continue;
        seen.add(name);
        normalizedVisibleOrder.push(name);
      }

      if (normalizedVisibleOrder.length === 0) {
        toast.warning('当前视图不包含可排序的实体列');
        return;
      }

      // 后端要求完整 schema 顺序；若当前视图是部分列（例如 query projection），补齐剩余列。
      const normalizedNonSystemOrder =
        normalizedVisibleOrder.length === nonSystemSchemaOrder.length
          ? normalizedVisibleOrder
          : [
              ...normalizedVisibleOrder,
              ...nonSystemSchemaOrder.filter((name) => !seen.has(name)),
            ];

      // 保持系统字段在原位置，仅重排业务列
      let nonSystemIndex = 0;
      const normalizedOrder = fullSchemaOrder.map((name) =>
        isSystemField(name) ? name : normalizedNonSystemOrder[nonSystemIndex++]
      );

      try {
        await reorderDatasetColumns({
          datasetId,
          columnNames: normalizedOrder,
        });

        if (currentDataset?.id === datasetId && Array.isArray(currentDataset.schema)) {
          const schemaMap = new Map(currentDataset.schema.map((column) => [column.name, column]));
          const reorderedSchema = normalizedOrder
            .map((name) => schemaMap.get(name))
            .filter((column) => column != null);

          if (reorderedSchema.length === currentDataset.schema.length) {
            applyLocalDatasetSchema(datasetId, reorderedSchema as any);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error('重排序失败', message);
      }
    },
    [readOnly, currentDataset, datasetId, applyLocalDatasetSchema]
  );

  // 更新 ref 的值（在所有回调函数定义之后）
  useEffect(() => {
    handleCellValueChangeRef.current = handleCellValueChange;
    handleAddColumnRef.current = handleAddColumn;
  });

  // Generate column definitions from schema
  const columns = useMemo(() => {
    // ✅ 即使 columnSchema 为空，也调用 createColumnsFromSchema
    // 这样至少会显示选择列（checkbox）和添加列按钮
    const generatedColumns = createColumnsFromSchema(displaySchema, rowData, {
      enableCheckbox: true,
      enableAddColumn: !readOnly,
      enableSorting: false,
      editable: !readOnly,
      readOnly,
      datasetId: datasetId,
      colorRules: activeQueryConfig?.color?.rules,
      savingCells: savingCells, // 🆕 传递保存状态
      cellErrors: cellErrors, // 🆕 传递错误信息
      onCellValueChange: (rowIndex, columnId, newValue) => {
        handleCellValueChangeRef.current?.(rowIndex, columnId, newValue);
      },
      onAddColumn: () => {
        handleAddColumnRef.current?.();
      },
    });

    return generatedColumns;
  }, [displaySchema, rowData, datasetId, activeQueryConfig, savingCells, cellErrors, readOnly]);

  // Show empty state if no dataset
  if (!datasetId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <div className="text-center">
          <p className="text-lg mb-2">请选择一个数据表</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* TanStack 表格区域 - 包含底部汇总行 */}
      <TanStackDataTable
        data={rowData}
        columns={columns}
        grouping={activeGrouping}
        loading={loading}
        loadingMore={loadingMore}
        emptyMessage={datasetId ? '暂无数据' : '请选择一个数据表'}
        rowHeight={rowHeight}
        onRowSelectionChange={onRowSelectionChange}
        onCellValueChange={handleCellValueChange}
        editable={!readOnly}
        showFooter={true}
        showColumnManager={showColumnManager}
        onColumnManagerChange={onColumnManagerChange}
        columnManagerColumns={columnManagerColumns}
        onToggleColumnVisibility={async (columnId, nextVisible) => {
          await handleToggleColumnVisibility(columnId, nextVisible);
        }}
        onSetDefaultColumnVisibility={handleSetDefaultColumnVisibility}
        onAddColumn={handleAddColumn}
        onRenameColumn={handleRenameColumn}
        onDeleteColumn={handleDeleteColumn}
        onReorderColumns={handleReorderColumns}
        onScrollEnd={handleScrollEnd}
        hasMore={hasMore}
        totalRowCount={currentDataset?.rowCount}
        filteredTotalCount={queryResult?.filteredTotalCount} // 🆕 传递筛选后的总行数
        countContext={countContext}
        colorRules={activeQueryConfig?.color?.rules}
      />
    </div>
  );
}
