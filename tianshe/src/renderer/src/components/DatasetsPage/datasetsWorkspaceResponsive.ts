export type DatasetsWorkspaceViewportTier = 'narrow' | 'regular' | 'wide';

export interface DatasetsWorkspaceViewportMetrics {
  tier: DatasetsWorkspaceViewportTier;
  viewportWidth: number;
  sidebarExpandedWidth: string;
  sidebarCollapsedWidth: string;
  headerPaddingInline: number;
  headerPaddingTop: number;
  headerPaddingBottom: number;
  bulkBarPaddingInline: number;
  bulkBarPaddingBlock: number;
  emptyStateMaxWidth: string;
  emptyStatePaddingInline: number;
  emptyStatePaddingBlock: number;
  importPanelMaxWidth: string;
  importPanelMaxHeight: string;
}

const DEFAULT_VIEWPORT_WIDTH = 1280;

export function normalizeDatasetsWorkspaceViewportWidth(viewportWidth?: number | null): number {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return DEFAULT_VIEWPORT_WIDTH;
  }

  return viewportWidth;
}

export function getDatasetsWorkspaceViewportMetrics(
  viewportWidth?: number | null
): DatasetsWorkspaceViewportMetrics {
  const normalizedViewportWidth = normalizeDatasetsWorkspaceViewportWidth(viewportWidth);

  if (normalizedViewportWidth <= 480) {
    return {
      tier: 'narrow',
      viewportWidth: normalizedViewportWidth,
      sidebarExpandedWidth: '14rem',
      sidebarCollapsedWidth: '3.75rem',
      headerPaddingInline: 12,
      headerPaddingTop: 10,
      headerPaddingBottom: 9,
      bulkBarPaddingInline: 10,
      bulkBarPaddingBlock: 7,
      emptyStateMaxWidth: '23rem',
      emptyStatePaddingInline: 18,
      emptyStatePaddingBlock: 22,
      importPanelMaxWidth: '22rem',
      importPanelMaxHeight: '86vh',
    };
  }

  if (normalizedViewportWidth <= 900) {
    return {
      tier: 'regular',
      viewportWidth: normalizedViewportWidth,
      sidebarExpandedWidth: '15rem',
      sidebarCollapsedWidth: '4rem',
      headerPaddingInline: 14,
      headerPaddingTop: 11,
      headerPaddingBottom: 10,
      bulkBarPaddingInline: 12,
      bulkBarPaddingBlock: 8,
      emptyStateMaxWidth: '25rem',
      emptyStatePaddingInline: 22,
      emptyStatePaddingBlock: 28,
      importPanelMaxWidth: '25rem',
      importPanelMaxHeight: '82vh',
    };
  }

  return {
    tier: 'wide',
    viewportWidth: normalizedViewportWidth,
    sidebarExpandedWidth: '15rem',
    sidebarCollapsedWidth: '4rem',
    headerPaddingInline: 16,
    headerPaddingTop: 12,
    headerPaddingBottom: 10,
    bulkBarPaddingInline: 12,
    bulkBarPaddingBlock: 8,
    emptyStateMaxWidth: '28rem',
    emptyStatePaddingInline: 28,
    emptyStatePaddingBlock: 32,
    importPanelMaxWidth: '28rem',
    importPanelMaxHeight: '78vh',
  };
}
