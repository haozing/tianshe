import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showBrowserView } from '../utils';

describe('showBrowserView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('re-attaches detached view before showing in fullscreen mode', () => {
    const viewInfo = { attachedTo: undefined };

    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue(viewInfo),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn(),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1400,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-1', viewManager, windowManager, 'main', 'mcp');
    expect(shown).toBe(true);
    expect(viewManager.attachView).toHaveBeenCalledWith(
      'view-1',
      'main',
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
    );
    expect(viewManager.updateBounds).not.toHaveBeenCalled();
    expect(viewManager.setViewDisplayMode).toHaveBeenCalledWith('view-1', 'fullscreen');
    expect(viewManager.setViewSource).toHaveBeenCalledWith('view-1', 'mcp');
    expect(viewManager.setRightDockedPoolView).not.toHaveBeenCalled();
  });

  it('updates bounds directly when view is already attached to target window', () => {
    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue({ attachedTo: 'main' }),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn(),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1400,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-1', viewManager, windowManager, 'main', 'mcp');
    expect(shown).toBe(true);
    expect(viewManager.attachView).not.toHaveBeenCalled();
    expect(viewManager.updateBounds).toHaveBeenCalledTimes(1);
    expect(viewManager.setViewDisplayMode).toHaveBeenCalledWith('view-1', 'fullscreen');
  });

  it('detaches from old window before re-attaching to target window', () => {
    const viewInfo = { attachedTo: 'popup-login' };

    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue(viewInfo),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn(),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1400,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-1', viewManager, windowManager, 'main', 'mcp');
    expect(shown).toBe(true);
    expect(viewManager.detachView).toHaveBeenCalledWith('view-1');
    expect(viewManager.attachView).toHaveBeenCalledWith(
      'view-1',
      'main',
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
    );
    expect(viewManager.updateBounds).not.toHaveBeenCalled();
  });

  it('uses docked-right mode when requested', () => {
    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue({ attachedTo: undefined }),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn().mockReturnValue(true),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1600,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-2', viewManager, windowManager, {
      windowId: 'main',
      source: 'pool',
      layout: 'docked-right',
      rightDockSize: '40%',
    });

    expect(shown).toBe(true);
    expect(viewManager.attachView).toHaveBeenCalledWith(
      'view-2',
      'main',
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
    );
    expect(viewManager.setRightDockedPoolView).toHaveBeenCalledWith('view-2', '40%', undefined);
    expect(viewManager.updateBounds).not.toHaveBeenCalled();
    expect(viewManager.setViewDisplayMode).not.toHaveBeenCalled();
    expect(viewManager.setViewSource).toHaveBeenCalledWith('view-2', 'pool');
  });

  it('passes pluginId to docked-right setup when provided', () => {
    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue({ attachedTo: undefined }),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn().mockReturnValue(true),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1600,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-plugin-dock', viewManager, windowManager, {
      windowId: 'main',
      source: 'pool',
      layout: 'docked-right',
      rightDockSize: '35%',
      pluginId: 'plugin-a',
    });

    expect(shown).toBe(true);
    expect(viewManager.setRightDockedPoolView).toHaveBeenCalledWith(
      'view-plugin-dock',
      '35%',
      'plugin-a'
    );
  });

  it('returns false if docked-right setup fails', () => {
    const viewManager = {
      getActivityBarWidth: vi.fn().mockReturnValue(160),
      getView: vi.fn().mockReturnValue({ attachedTo: undefined }),
      attachView: vi.fn(),
      detachView: vi.fn(),
      updateBounds: vi.fn(),
      setViewDisplayMode: vi.fn(),
      setViewSource: vi.fn(),
      setRightDockedPoolView: vi.fn().mockReturnValue(false),
    } as any;

    const windowManager = {
      getWindowById: vi.fn().mockReturnValue({
        getContentBounds: vi.fn().mockReturnValue({
          x: 0,
          y: 0,
          width: 1600,
          height: 900,
        }),
      }),
    } as any;

    const shown = showBrowserView('view-3', viewManager, windowManager, {
      windowId: 'main',
      layout: 'docked-right',
    });

    expect(shown).toBe(false);
    expect(viewManager.setViewSource).not.toHaveBeenCalled();
  });
});
