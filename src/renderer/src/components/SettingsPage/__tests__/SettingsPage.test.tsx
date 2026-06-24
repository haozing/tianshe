import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../index';

vi.mock('../SchedulerPanel', () => ({
  SchedulerPanel: () => <div data-testid="scheduler-panel">SchedulerPanel</div>,
}));

vi.mock('../HttpApiPanel', () => ({
  HttpApiPanel: () => <div data-testid="http-api-panel">HttpApiPanel</div>,
}));

vi.mock('../CloudSnapshotPanel', () => ({
  CloudSnapshotPanel: () => <div data-testid="cloud-snapshot-panel">CloudSnapshotPanel</div>,
}));

vi.mock('../OcrPoolPanel', () => ({
  OcrPoolPanel: () => <div data-testid="ocr-panel">OcrPoolPanel</div>,
}));

vi.mock('../InternalBrowserPanel', () => ({
  InternalBrowserPanel: () => <div data-testid="internal-browser-panel">InternalBrowserPanel</div>,
}));

vi.mock('../BrowserRuntimePanel', () => ({
  BrowserRuntimePanel: () => <div data-testid="browser-runtime-panel">BrowserRuntimePanel</div>,
}));

vi.mock('../DatasetRecordEvidencePanel', () => ({
  DatasetRecordEvidencePanel: () => (
    <div data-testid="dataset-record-evidence-panel">DatasetRecordEvidencePanel</div>
  ),
}));

vi.mock('../SiteAdapterLabPanel', () => ({
  SiteAdapterLabPanel: () => <div data-testid="site-adapter-lab-panel">SiteAdapterLabPanel</div>,
}));

vi.mock('../SiteAdapterRepairStudioPanel', () => ({
  SiteAdapterRepairStudioPanel: () => (
    <div data-testid="site-adapter-repair-studio-panel">SiteAdapterRepairStudioPanel</div>
  ),
}));

describe('SettingsPage', () => {
  it('hides cloud snapshot settings in the open edition', () => {
    render(<SettingsPage />);

    expect(screen.getByTestId('scheduler-panel')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '云端快照' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-snapshot-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '内置浏览器' }));

    expect(screen.getByTestId('internal-browser-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '浏览器运行时' }));

    expect(screen.getByTestId('browser-runtime-panel')).toBeInTheDocument();

    expect(screen.queryByRole('tab', { name: 'Data Evidence' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Site Adapter Lab' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Repair Studio' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '开发者工具' }));

    expect(screen.getByText('v4 站点能力调试与修复')).toBeInTheDocument();
    expect(screen.getByTestId('dataset-record-evidence-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '站点适配器调试' }));

    expect(screen.getByTestId('site-adapter-lab-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '站点规则修复' }));

    expect(screen.getByTestId('site-adapter-repair-studio-panel')).toBeInTheDocument();
  });
});
