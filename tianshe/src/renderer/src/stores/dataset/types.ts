export interface DatasetInfo {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  createdAt: number;
  lastQueriedAt?: number;
  schema?: Array<{
    name: string;
    duckdbType: string;
    fieldType?: string;
    nullable?: boolean;
    metadata?: any;
    storageMode?: string;
    computeConfig?: any;
    validationRules?: any[];
    displayConfig?: {
      width?: number;
      frozen?: boolean;
      order?: number;
      hidden?: boolean;
      pinned?: 'left' | 'right';
    };
  }>;
  folderId?: string | null;
  tableOrder?: number;
  tabGroupId?: string | null;
  tabOrder?: number;
  isGroupDefault?: boolean;
}

export type DatasetSchemaColumn = NonNullable<DatasetInfo['schema']>[number];
