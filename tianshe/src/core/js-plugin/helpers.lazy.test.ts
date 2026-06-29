import { beforeEach, describe, expect, it, vi } from 'vitest';

const { AdvancedNamespaceMock, createNamespaceStub } = vi.hoisted(() => {
  const createNamespaceStub = (namespaceName: string) =>
    class {
      public readonly __namespaceName = namespaceName;

      constructor(..._args: unknown[]) {}
    };

  return {
    AdvancedNamespaceMock: vi.fn(),
    createNamespaceStub,
  };
});

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../browser-pool', () => ({
  getBrowserPoolManager: () => ({
    releaseByPlugin: vi.fn().mockResolvedValue({ browsers: 0, requests: 0 }),
  }),
}));

vi.mock('./namespaces/database', () => ({
  DatabaseNamespace: createNamespaceStub('database'),
}));
vi.mock('./namespaces/network', () => ({
  NetworkNamespace: createNamespaceStub('network'),
}));
vi.mock('./namespaces/ui', () => ({
  UINamespace: createNamespaceStub('ui'),
}));
vi.mock('./namespaces/storage', () => ({
  StorageNamespace: createNamespaceStub('storage'),
}));
vi.mock('./namespaces/utils', () => ({
  UtilsNamespace: createNamespaceStub('utils'),
}));
vi.mock('./namespaces/window', () => ({
  WindowNamespace: createNamespaceStub('window'),
}));
vi.mock('./namespaces/plugin', () => ({
  PluginNamespace: createNamespaceStub('plugin'),
}));
vi.mock('./namespaces/ffi', () => ({
  FFINamespace: createNamespaceStub('ffi'),
}));
vi.mock('./namespaces/task-queue', () => ({
  TaskQueueNamespace: createNamespaceStub('taskQueue'),
}));
vi.mock('./namespaces/button', () => ({
  ButtonNamespace: createNamespaceStub('button'),
}));
vi.mock('./namespaces/scheduler', () => ({
  SchedulerNamespace: createNamespaceStub('scheduler'),
}));
vi.mock('./namespaces/openai', () => ({
  OpenAINamespace: createNamespaceStub('openai'),
}));
vi.mock('./namespaces/webhook', () => ({
  WebhookNamespace: createNamespaceStub('webhook'),
}));
vi.mock('./namespaces/raw', () => ({
  RawNamespace: createNamespaceStub('raw'),
}));
vi.mock('./namespaces/advanced', () => ({
  AdvancedNamespace: AdvancedNamespaceMock,
}));
vi.mock('./namespaces/profile', () => ({
  ProfileNamespace: createNamespaceStub('profile'),
}));
vi.mock('./namespaces/account', () => ({
  AccountNamespace: createNamespaceStub('account'),
}));
vi.mock('./namespaces/saved-site', () => ({
  SavedSiteNamespace: createNamespaceStub('savedSite'),
}));
vi.mock('./namespaces/custom-field', () => ({
  CustomFieldNamespace: createNamespaceStub('customField'),
}));
vi.mock('./namespaces/cloud', () => ({
  CloudNamespace: createNamespaceStub('cloud'),
}));
vi.mock('./namespaces/onnx', () => ({
  ONNXNamespace: createNamespaceStub('onnx'),
}));
vi.mock('./namespaces/image', () => ({
  ImageNamespace: createNamespaceStub('image'),
}));
vi.mock('./namespaces/image-search', () => ({
  ImageSearchNamespace: createNamespaceStub('imageSearch'),
}));
vi.mock('./namespaces/ocr', () => ({
  OCRNamespace: createNamespaceStub('ocr'),
}));
vi.mock('./namespaces/cv', () => ({
  CVNamespace: createNamespaceStub('cv'),
}));
vi.mock('./namespaces/vector-index', () => ({
  VectorIndexNamespace: createNamespaceStub('vectorIndex'),
}));

import { PluginHelpers } from './helpers';

const createHelpers = () =>
  new PluginHelpers(
    {
      getProfileService: vi.fn().mockReturnValue({}),
      getProfileGroupService: vi.fn().mockReturnValue({}),
      getAccountService: vi.fn().mockReturnValue({}),
      getSavedSiteService: vi.fn().mockReturnValue({}),
    } as any,
    'lazy-plugin',
    {
      id: 'lazy-plugin',
      name: 'Lazy Plugin',
      version: '1.0.0',
      author: 'Test',
      main: 'index.js',
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

describe('PluginHelpers advanced namespace compatibility', () => {
  beforeEach(() => {
    AdvancedNamespaceMock.mockReset();
    AdvancedNamespaceMock.mockImplementation(function AdvancedNamespaceStub(this: any) {
      this.clipboard = { readText: vi.fn().mockReturnValue('ok') };
      this.desktopCapturer = {};
      this.fs = {};
    });
  });

  it('defers advanced namespace construction until first nested access', () => {
    const helpers = createHelpers();

    expect(AdvancedNamespaceMock).not.toHaveBeenCalled();

    void helpers.advanced;
    expect(AdvancedNamespaceMock).not.toHaveBeenCalled();

    expect(helpers.advanced.clipboard).toBeTruthy();
    expect(AdvancedNamespaceMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail helper construction when advanced initialization would throw', () => {
    AdvancedNamespaceMock.mockImplementation(() => {
      throw new TypeError('advanced init failed');
    });

    const helpers = createHelpers();

    expect(AdvancedNamespaceMock).not.toHaveBeenCalled();
    expect(() => helpers.advanced.clipboard).toThrow('advanced init failed');
    expect(AdvancedNamespaceMock).toHaveBeenCalledTimes(1);
  });
});
