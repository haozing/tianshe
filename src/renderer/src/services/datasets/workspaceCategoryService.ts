import { workspaceFacade } from './workspaceFacade';
import type { DatasetCategory, TableInfo } from '../../components/DatasetsPage/types';

export interface DatasetMeta {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  folderId?: string | null;
  tabGroupId?: string | null;
  isGroupDefault?: boolean;
}

interface FolderTreeNode {
  id: string;
  name: string;
  icon?: string;
  parentId?: string | null;
  pluginId?: string | null;
  children?: FolderTreeNode[];
  datasets?: Array<{
    id: string;
    name: string;
    tableOrder?: number;
  }>;
}

export interface WorkspaceSnapshot {
  categories: DatasetCategory[];
  datasets: DatasetMeta[];
}

export const TABLE_PREFIX = 'table_';

export function shouldShowInSidebar(
  dataset?: Pick<DatasetMeta, 'tabGroupId' | 'isGroupDefault'>
): boolean {
  if (!dataset) return true;
  return !dataset.tabGroupId || dataset.isGroupDefault === true;
}

export function toTableId(datasetId: string): string {
  return `${TABLE_PREFIX}${datasetId}`;
}

export function getDatasetIdFromTableId(tableId: string | null): string | null {
  if (!tableId || !tableId.startsWith(TABLE_PREFIX)) {
    return null;
  }

  return tableId.slice(TABLE_PREFIX.length);
}

export async function buildWorkspaceCategories(datasets: DatasetMeta[]): Promise<DatasetCategory[]> {
  const datasetMetaMap = new Map(datasets.map((item) => [item.id, item] as const));
  const folderResponse = await workspaceFacade.getFolderTree();

  const rootDatasets = datasets.filter((dataset) => !dataset.folderId && shouldShowInSidebar(dataset));
  const rootCategories: DatasetCategory[] = rootDatasets.map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    tables: [
      {
        id: toTableId(dataset.id),
        name: dataset.name,
        datasetId: dataset.id,
        rowCount: dataset.rowCount,
        columnCount: dataset.columnCount,
      },
    ],
    isFolder: false,
  }));

  if (!folderResponse.success || !Array.isArray(folderResponse.tree)) {
    return rootCategories;
  }

  const folderNodes: FolderTreeNode[] = [];
  const walkFolders = (folders: FolderTreeNode[], parentId: string | null = null) => {
    for (const folder of folders) {
      folderNodes.push({
        ...folder,
        parentId,
      });
      if (Array.isArray(folder.children) && folder.children.length > 0) {
        walkFolders(folder.children, folder.id);
      }
    }
  };

  walkFolders(folderResponse.tree);

  const customPagesByFolderId = new Map<string, TableInfo[]>();

  await Promise.all(
    folderNodes
      .filter((folder) => folder.pluginId)
      .map(async (folder) => {
        try {
          const pagesResult = await workspaceFacade.getCustomPages(folder.pluginId!);
          if (!pagesResult.success || !Array.isArray(pagesResult.pages)) {
            customPagesByFolderId.set(folder.id, []);
            return;
          }

          const embeddedPages = pagesResult.pages
            .filter((page: any) => page.display_mode === 'embedded')
            .map(
              (page: any): TableInfo => ({
                id: `custompage_${page.page_id}`,
                name: page.title,
                datasetId: folder.pluginId!,
                isCustomPage: true,
                customPageInfo: page,
              })
            );

          customPagesByFolderId.set(folder.id, embeddedPages);
        } catch (error) {
          console.warn(
            `[DatasetsWorkspace] Failed to load custom pages for plugin ${folder.pluginId}:`,
            error
          );
          customPagesByFolderId.set(folder.id, []);
        }
      })
  );

  const folderCategories: DatasetCategory[] = folderNodes.map((folder) => {
    const normalTables: TableInfo[] = (folder.datasets ?? [])
      .filter((dataset) => shouldShowInSidebar(datasetMetaMap.get(dataset.id)))
      .map((dataset) => ({
        id: toTableId(dataset.id),
        name: dataset.name,
        datasetId: dataset.id,
        rowCount: datasetMetaMap.get(dataset.id)?.rowCount,
        columnCount: datasetMetaMap.get(dataset.id)?.columnCount,
      }));

    return {
      id: folder.id,
      name: folder.name,
      icon: folder.icon,
      isFolder: true,
      parentId: folder.parentId ?? null,
      pluginId: folder.pluginId ?? null,
      tables: [...normalTables, ...(customPagesByFolderId.get(folder.id) ?? [])],
    };
  });

  return [...folderCategories, ...rootCategories];
}

export function syncWorkspaceCategoryMetadata(
  categories: DatasetCategory[],
  datasets: DatasetMeta[]
): DatasetCategory[] {
  const datasetMetaMap = new Map(datasets.map((dataset) => [dataset.id, dataset] as const));

  return categories.map((category) => {
    const syncedTables = category.tables.map((table) => {
      if (table.isCustomPage) {
        return table;
      }

      const dataset = datasetMetaMap.get(table.datasetId);
      if (!dataset) {
        return table;
      }

      return {
        ...table,
        name: dataset.name,
        rowCount: dataset.rowCount,
        columnCount: dataset.columnCount,
      };
    });

    if (!category.isFolder) {
      const rootDataset =
        datasetMetaMap.get(category.id) ??
        (syncedTables.length > 0 ? datasetMetaMap.get(syncedTables[0].datasetId) : undefined);

      if (rootDataset) {
        return {
          ...category,
          name: rootDataset.name,
          tables: syncedTables,
        };
      }
    }

    return {
      ...category,
      tables: syncedTables,
    };
  });
}
