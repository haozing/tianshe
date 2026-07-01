import { describe, expect, it, vi } from 'vitest';
import { WebContentsViewPluginPageController } from './webcontentsview-plugin-page-controller';
import type { ViewRegistration, WebContentsViewInfo } from './webcontentsview-manager';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Users\\tester\\AppData\\Roaming\\Tianshe'),
  },
}));

function createController() {
  const registry = new Map<string, ViewRegistration>();
  const pool = new Map<string, WebContentsViewInfo>();
  const deps = {
    registry,
    pool,
    registerView: vi.fn((registration: ViewRegistration) => {
      registry.set(registration.id, registration);
    }),
    activateView: vi.fn(),
    closeView: vi.fn(),
    detachView: vi.fn(),
    getActivePluginId: vi.fn(() => null),
    setActivePluginId: vi.fn(),
  };

  return {
    controller: new WebContentsViewPluginPageController(deps),
    registry,
    pool,
    deps,
  };
}

describe('WebContentsViewPluginPageController', () => {
  it('registers plugin pages with per-plugin partitions', () => {
    const { controller, registry } = createController();

    const pluginAViewId = controller.registerPluginPageView('plugin-a', {
      id: 'dashboard',
      title: 'Plugin A',
      icon: 'A',
      source: { type: 'local', path: 'index.html' },
    });
    const pluginBViewId = controller.registerPluginPageView('plugin-b', {
      id: 'dashboard',
      title: 'Plugin B',
      icon: 'B',
      source: { type: 'local', path: 'index.html' },
    });

    expect(pluginAViewId).toBe('plugin-page:plugin-a:dashboard');
    expect(pluginBViewId).toBe('plugin-page:plugin-b:dashboard');
    expect(registry.get(pluginAViewId)?.partition).toBe('persist:plugin-page:plugin-a');
    expect(registry.get(pluginBViewId)?.partition).toBe('persist:plugin-page:plugin-b');
    expect(registry.get(pluginAViewId)?.metadata?.pluginId).toBe('plugin-a');
    expect(registry.get(pluginBViewId)?.metadata?.pluginId).toBe('plugin-b');
  });

  it('injects plugin API wrappers without embedding pluginId as raw JavaScript string input', () => {
    const { controller } = createController();
    const script = (controller as any).buildPluginPageInjectionScript("plugin-'quoted", [
      'readState',
    ]);

    expect(script).toContain(`const pluginId = "plugin-'quoted";`);
    expect(script).toContain('const apiList = ["readState"];');
    expect(script).toContain('window.pluginAPI[pluginId]');
    expect(script).toContain('callPluginAPI(apiName, ...args)');
    expect(script).not.toContain("callPluginAPI('plugin-'quoted'");
    expect(script).not.toContain("window.pluginAPI['plugin-'quoted']");
  });
});
