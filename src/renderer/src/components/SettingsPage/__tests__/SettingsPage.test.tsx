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

describe('SettingsPage', () => {
  it('hides cloud snapshot settings in the open edition', () => {
    render(<SettingsPage />);

    expect(screen.getByTestId('scheduler-panel')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '云端快照' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-snapshot-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '内置浏览器' }));

    expect(screen.getByTestId('internal-browser-panel')).toBeInTheDocument();
  });
});
