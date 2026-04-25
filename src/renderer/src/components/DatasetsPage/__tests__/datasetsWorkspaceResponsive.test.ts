import { describe, expect, it } from 'vitest';
import {
  getDatasetsWorkspaceViewportMetrics,
  normalizeDatasetsWorkspaceViewportWidth,
} from '../datasetsWorkspaceResponsive';

describe('datasetsWorkspaceResponsive', () => {
  it('normalizes invalid viewport widths to a safe desktop baseline', () => {
    expect(normalizeDatasetsWorkspaceViewportWidth(undefined)).toBe(1280);
    expect(normalizeDatasetsWorkspaceViewportWidth(null)).toBe(1280);
    expect(normalizeDatasetsWorkspaceViewportWidth(NaN)).toBe(1280);
    expect(normalizeDatasetsWorkspaceViewportWidth(0)).toBe(1280);
  });

  it.each([
    [
      390,
      {
        tier: 'narrow',
        sidebarExpandedWidth: '15rem',
        sidebarCollapsedWidth: '4rem',
        headerPaddingInline: 16,
        importPanelMaxWidth: '22rem',
      },
    ],
    [
      768,
      {
        tier: 'regular',
        sidebarExpandedWidth: '16rem',
        sidebarCollapsedWidth: '4.25rem',
        headerPaddingInline: 20,
        importPanelMaxWidth: '25rem',
      },
    ],
    [
      1440,
      {
        tier: 'wide',
        sidebarExpandedWidth: '17rem',
        sidebarCollapsedWidth: '4.5rem',
        headerPaddingInline: 24,
        importPanelMaxWidth: '28rem',
      },
    ],
  ] as const)(
    'returns the high-density workspace metrics for viewport %s',
    (viewportWidth, expected) => {
      expect(getDatasetsWorkspaceViewportMetrics(viewportWidth)).toMatchObject(expected);
    }
  );
});
