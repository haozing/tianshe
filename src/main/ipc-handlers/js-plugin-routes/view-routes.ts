import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import { handleIPCError } from '../../ipc-utils';
import type { WebContentsViewManager } from '../../webcontentsview-manager';
import { DEFAULT_VIEW_BOUNDS } from '../../../constants/layout';

export function registerJSPluginViewRoutes(viewManager: WebContentsViewManager): void {
  registerShowPluginView(viewManager);
  registerHidePluginView(viewManager);
  registerGetPluginViewInfo(viewManager);
  registerSetPluginViewBounds(viewManager);
  registerGetLayoutInfo(viewManager);
}

function registerShowPluginView(viewManager: WebContentsViewManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:show-view',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      pluginId: string,
      bounds?: { x: number; y: number; width: number; height: number }
    ) => {
      try {
        const viewInfo = viewManager.getPluginViews(pluginId);

        if (!viewInfo.pageViewId) {
          throw new Error(`Plugin ${pluginId} does not have a page view`);
        }

        viewManager.applyPluginDockLayout(pluginId);

        let viewBounds = bounds;

        if (!viewBounds) {
          const calculatedBounds = viewManager.calculatePluginBounds(pluginId);

          if (calculatedBounds) {
            viewBounds = calculatedBounds;
            console.log(`✅ Using layout from manifest for plugin ${pluginId}:`, viewBounds);
          } else {
            viewBounds = DEFAULT_VIEW_BOUNDS;
            console.log(`⚠️ Using default bounds for plugin ${pluginId}:`, viewBounds);
          }
        }

        await viewManager.activateView(viewInfo.pageViewId);
        await viewManager.loadPluginPageView(viewInfo.pageViewId, pluginId);
        viewManager.attachView(viewInfo.pageViewId, 'main', viewBounds);

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerHidePluginView(viewManager: WebContentsViewManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:hide-view',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const viewInfo = viewManager.getPluginViews(pluginId);

        if (!viewInfo.pageViewId) {
          throw new Error(`Plugin ${pluginId} does not have a page view`);
        }

        viewManager.detachView(viewInfo.pageViewId);

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetPluginViewInfo(viewManager: WebContentsViewManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-view-info',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const viewInfo = viewManager.getPluginViews(pluginId);

        return {
          success: true,
          viewInfo: {
            hasPageView: !!viewInfo.pageViewId,
            pageViewId: viewInfo.pageViewId,
            tempViewCount: viewInfo.tempViewIds.length,
            tempViewIds: viewInfo.tempViewIds,
          },
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerSetPluginViewBounds(viewManager: WebContentsViewManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:set-view-bounds',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      pluginId: string,
      bounds: { x?: number; y?: number; width?: number; height?: number }
    ) => {
      try {
        const viewInfo = viewManager.getPluginViews(pluginId);

        if (!viewInfo.pageViewId) {
          throw new Error(`Plugin ${pluginId} does not have a page view`);
        }

        const currentBounds = viewManager.getViewBounds(viewInfo.pageViewId);
        const baseBounds =
          currentBounds ?? viewManager.calculatePluginBounds(pluginId) ?? DEFAULT_VIEW_BOUNDS;

        const fullBounds = {
          x: bounds.x ?? baseBounds.x,
          y: bounds.y ?? baseBounds.y,
          width: bounds.width ?? baseBounds.width,
          height: bounds.height ?? baseBounds.height,
        };

        viewManager.updateBounds(viewInfo.pageViewId, fullBounds);

        console.log(`✅ Updated plugin view bounds for ${pluginId}:`, fullBounds);

        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetLayoutInfo(viewManager: WebContentsViewManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-layout-info',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, _pluginId: string) => {
      try {
        const layoutInfo = viewManager.getPluginLayoutInfo();
        if (!layoutInfo) {
          throw new Error('Main window not found');
        }

        return {
          success: true,
          layoutInfo,
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}
