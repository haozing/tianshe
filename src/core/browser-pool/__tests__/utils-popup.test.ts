import { describe, it, expect, vi, beforeEach } from 'vitest';
import { showBrowserViewInPopup } from '../utils';

const { mockMaybeOpenInternalBrowserDevTools } = vi.hoisted(() => ({
  mockMaybeOpenInternalBrowserDevTools: vi.fn(),
}));

vi.mock('../../../main/internal-browser-devtools', () => ({
  maybeOpenInternalBrowserDevTools: mockMaybeOpenInternalBrowserDevTools,
}));

describe('showBrowserViewInPopup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockMaybeOpenInternalBrowserDevTools.mockReset();
  });

  it('view 不存在应返回 null', () => {
    const viewManager = {
      getView: vi.fn().mockReturnValue(undefined),
    } as any;

    const windowManager = {
      createPopupWindow: vi.fn(),
      setPopupViewId: vi.fn(),
    } as any;

    const popupId = showBrowserViewInPopup('missing-view', viewManager, windowManager);
    expect(popupId).toBeNull();
    expect(windowManager.createPopupWindow).not.toHaveBeenCalled();
  });

  it('应附加到弹窗并更新 attachedTo/bounds，resize 时同步 bounds', () => {
    const view = {
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      webContents: {},
    };

    const viewInfo: any = {
      view,
      attachedTo: 'main',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      lastAccessedAt: 0,
    };

    const viewManager = {
      getView: vi.fn().mockReturnValue(viewInfo),
      detachView: vi.fn().mockImplementation(() => {
        viewInfo.attachedTo = undefined;
        viewInfo.bounds = undefined;
      }),
      attachViewOffscreen: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
    } as any;

    let capturedOnClose: (() => void) | undefined;
    const popupWindow: any = {
      contentView: {
        addChildView: vi.fn(),
      },
      getContentBounds: vi.fn().mockReturnValue({ width: 800, height: 600 }),
      isDestroyed: vi.fn().mockReturnValue(false),
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'resize') {
          popupWindow.__onResize = handler;
        }
      }),
      __onResize: undefined as undefined | (() => void),
    };

    const windowManager = {
      createPopupWindow: vi.fn((_popupId: string, config?: any) => {
        capturedOnClose = config?.onClose;
        return popupWindow;
      }),
      setPopupViewId: vi.fn(),
    } as any;

    const onCloseUser = vi.fn();
    const popupId = showBrowserViewInPopup('view-1', viewManager, windowManager, {
      onClose: onCloseUser,
      width: 800,
      height: 600,
    });

    expect(popupId).toBeTypeOf('string');
    expect(windowManager.createPopupWindow).toHaveBeenCalledTimes(1);
    expect(popupWindow.contentView.addChildView).toHaveBeenCalledWith(view);

    // 初次设置 bounds
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 });
    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(viewInfo.attachedTo).toBe(`popup-${popupId}`);
    expect(viewInfo.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(viewInfo.lastAccessedAt).toBeGreaterThan(0);

    expect(windowManager.setPopupViewId).toHaveBeenCalledWith(popupId, 'view-1');
    expect(viewManager.setViewDisplayMode).toHaveBeenCalledWith('view-1', 'popup');
    expect(viewManager.setViewSource).toHaveBeenCalledWith('view-1', 'account');
    expect(mockMaybeOpenInternalBrowserDevTools).toHaveBeenCalledWith(viewInfo.view.webContents, {
      override: undefined,
      mode: 'detach',
    });

    // resize 时更新 bounds
    popupWindow.getContentBounds.mockReturnValue({ width: 900, height: 700 });
    popupWindow.__onResize?.();
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 900, height: 700 });
    expect(viewInfo.bounds).toEqual({ x: 0, y: 0, width: 900, height: 700 });

    // 触发弹窗关闭回调
    expect(capturedOnClose).toBeTypeOf('function');
    capturedOnClose?.();

    expect(viewManager.detachView).toHaveBeenCalledWith('view-1');
    expect(viewManager.attachViewOffscreen).toHaveBeenCalledWith('view-1', 'main');
    expect(viewManager.setViewDisplayMode).toHaveBeenCalledWith('view-1', 'offscreen');
    expect(onCloseUser).toHaveBeenCalledTimes(1);
  });
});
