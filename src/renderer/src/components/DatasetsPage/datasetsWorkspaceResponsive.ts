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
      sidebarExpandedWidth: '15rem',
      sidebarCollapsedWidth: '4rem',
      headerPaddingInline: 16,
      headerPaddingTop: 14,
      headerPaddingBottom: 12,
      bulkBarPaddingInline: 12,
      bulkBarPaddingBlock: 9,
      emptyStateMaxWidth: '24rem',
      emptyStatePaddingInline: 20,
      emptyStatePaddingBlock: 24,
      importPanelMaxWidth: '22rem',
      importPanelMaxHeight: '86vh',
    };
  }

  if (normalizedViewportWidth <= 900) {
    return {
      tier: 'regular',
      viewportWidth: normalizedViewportWidth,
      sidebarExpandedWidth: '16rem',
      sidebarCollapsedWidth: '4.25rem',
      headerPaddingInline: 20,
      headerPaddingTop: 16,
      headerPaddingBottom: 14,
      bulkBarPaddingInline: 14,
      bulkBarPaddingBlock: 10,
      emptyStateMaxWidth: '26rem',
      emptyStatePaddingInline: 24,
      emptyStatePaddingBlock: 32,
      importPanelMaxWidth: '25rem',
      importPanelMaxHeight: '82vh',
    };
  }

  return {
    tier: 'wide',
    viewportWidth: normalizedViewportWidth,
    sidebarExpandedWidth: '17rem',
    sidebarCollapsedWidth: '4.5rem',
    headerPaddingInline: 24,
    headerPaddingTop: 18,
    headerPaddingBottom: 16,
    bulkBarPaddingInline: 16,
    bulkBarPaddingBlock: 10,
    emptyStateMaxWidth: '28rem',
    emptyStatePaddingInline: 32,
    emptyStatePaddingBlock: 40,
    importPanelMaxWidth: '28rem',
    importPanelMaxHeight: '78vh',
  };
}
