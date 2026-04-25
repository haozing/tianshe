import type { CustomPageInfo } from '../../../../types/js-plugin';

export interface DatasetCategory {
  id: string;
  name: string;
  icon?: string;
  tables: TableInfo[];
  isFolder?: boolean;
  parentId?: string | null;
  pluginId?: string | null;
}

export interface TableInfo {
  id: string;
  name: string;
  datasetId: string;
  rowCount?: number;
  columnCount?: number;
  isCustomPage?: boolean;
  customPageInfo?: CustomPageInfo;
}
