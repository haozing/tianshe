import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomPageViewer } from '../CustomPageViewer';

const mockRenderCustomPage = vi.hoisted(() => vi.fn());
const mockSendPageMessage = vi.hoisted(() => vi.fn());
const mockUseEventSubscription = vi.hoisted(() => vi.fn());

vi.mock('../../../services/datasets/pluginFacade', () => ({
  pluginFacade: {
    renderCustomPage: mockRenderCustomPage,
    sendPageMessage: mockSendPageMessage,
  },
}));

vi.mock('../../../hooks/useElectronAPI', () => ({
  useEventSubscription: mockUseEventSubscription,
}));

describe('CustomPageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEventSubscription.mockImplementation(() => undefined);
    mockSendPageMessage.mockResolvedValue({ result: null, error: null });
  });

  it('shows the loading shell state while the plugin page is preparing and becomes visible after ready', async () => {
    mockRenderCustomPage.mockResolvedValue({
      success: true,
      html: '<!doctype html><html><body><div>Plugin page</div></body></html>',
    });

    render(
      <CustomPageViewer
        page={{ plugin_id: 'plugin-1', page_id: 'page-1', title: '插件详情' } as any}
        datasetId="dataset-1"
      />
    );

    expect(screen.getByText('正在加载插件页面')).toBeInTheDocument();
    expect(screen.getByText('正在准备 插件详情 的渲染环境，请稍候。')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockRenderCustomPage).toHaveBeenCalledWith('plugin-1', 'page-1', 'dataset-1');
    });

    const iframe = screen.getByTitle('插件详情') as HTMLIFrameElement;
    const readySource = iframe.contentWindow ?? null;

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: readySource,
          data: { type: 'plugin-page-ready' },
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('正在加载插件页面')).not.toBeInTheDocument();
      expect(iframe.className).not.toContain('invisible');
    });
  });

  it('shows the shell error state and retries loading when reload is clicked', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mockRenderCustomPage
      .mockRejectedValueOnce(new Error('render failed'))
      .mockResolvedValueOnce({
        success: true,
        html: '<!doctype html><html><body><div>Recovered</div></body></html>',
      });

    render(
      <CustomPageViewer
        page={{ plugin_id: 'plugin-2', page_id: 'page-2', title: '异常页' } as any}
        datasetId="dataset-2"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('插件页面加载失败')).toBeInTheDocument();
      expect(screen.getByText('render failed')).toBeInTheDocument();
    });

    const reloadButton = screen.getByRole('button', { name: '重新加载' });
    expect(reloadButton.className).toContain('shell-field-control');

    fireEvent.click(reloadButton);

    await waitFor(() => {
      expect(mockRenderCustomPage).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('插件页面加载失败')).not.toBeInTheDocument();
      expect(screen.getByText('正在加载插件页面')).toBeInTheDocument();
    });

    consoleErrorSpy.mockRestore();
  });
});
