import { beforeEach, describe, expect, it, vi } from 'vitest';

const dynamicImportMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/dynamic-import', () => ({
  dynamicImport: dynamicImportMock,
}));

import { ONNXRuntimeService } from './onnx-service';

class MockTensor {
  constructor(
    public type: string,
    public data: unknown,
    public dims: number[]
  ) {}
}

function createControlledSession() {
  const pending: Array<() => void> = [];
  let activeRuns = 0;
  let maxActiveRuns = 0;

  const session = {
    inputNames: ['input'],
    outputNames: ['output'],
    release: vi.fn(),
    run: vi.fn(async () => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      await new Promise<void>((resolve) => pending.push(resolve));
      activeRuns -= 1;
      return {
        output: new MockTensor('float32', new Float32Array([1, 2]), [1, 2]),
      };
    }),
  };

  return {
    session,
    releaseOne: () => pending.shift()?.(),
    releaseAll: () => {
      while (pending.length) pending.shift()?.();
    },
    getMaxActiveRuns: () => maxActiveRuns,
  };
}

function createImmediateSession(options: { executionProvider?: string } = {}) {
  return {
    inputNames: ['input'],
    outputNames: ['output'],
    executionProvider: options.executionProvider,
    release: vi.fn(),
    run: vi.fn(async () => ({
      output: new MockTensor('float32', new Float32Array([1, 2]), [1, 2]),
    })),
  };
}

describe('ONNXRuntimeService resource governance', () => {
  let service: ONNXRuntimeService;

  beforeEach(() => {
    ONNXRuntimeService.resetInstanceForTesting();
    service = ONNXRuntimeService.getInstance();
    dynamicImportMock.mockReset();
  });

  it('serializes inference per model by default', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({ modelId: 'serial-model', modelPath: 'model.onnx' });
    const first = service.run(modelId, createInput());
    const second = service.run(modelId, createInput());
    await vi.waitFor(() => expect(controlled.session.run).toHaveBeenCalledTimes(1));

    controlled.releaseOne();
    await first;
    await vi.waitFor(() => expect(controlled.session.run).toHaveBeenCalledTimes(2));
    controlled.releaseOne();
    await second;

    expect(controlled.getMaxActiveRuns()).toBe(1);
    await service.dispose();
  });

  it('allows configured model concurrency', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({
      modelId: 'parallel-model',
      modelPath: 'model.onnx',
      maxConcurrency: 2,
    });
    const first = service.run(modelId, createInput());
    const second = service.run(modelId, createInput());

    await vi.waitFor(() => expect(controlled.session.run).toHaveBeenCalledTimes(2));
    controlled.releaseAll();
    await Promise.all([first, second]);

    expect(controlled.getMaxActiveRuns()).toBe(2);
    await service.dispose();
  });

  it('fails inference when timeout is exceeded', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({ modelId: 'timeout-model', modelPath: 'model.onnx' });

    await expect(service.run(modelId, createInput(), { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'INFERENCE_FAILED',
    });
    controlled.releaseAll();
    await service.dispose();
  });

  it('rejects inputs that exceed the element budget before running the session', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({ modelId: 'budget-model', modelPath: 'model.onnx' });

    await expect(service.run(modelId, createInput([1, 4]), { maxInputElements: 3 })).rejects.toMatchObject(
      {
        code: 'INFERENCE_FAILED',
      }
    );
    expect(controlled.session.run).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('rejects unload while inference is active and keeps the model loaded', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({ modelId: 'active-model', modelPath: 'model.onnx' });
    const running = service.run(modelId, createInput());
    await vi.waitFor(() => expect(controlled.session.run).toHaveBeenCalledTimes(1));

    await expect(service.unloadModel(modelId)).rejects.toThrow(
      'Cannot unload model "active-model" while 1 inference run(s) are active'
    );
    expect(service.hasModel(modelId)).toBe(true);

    controlled.releaseOne();
    await running;
    await service.unloadModel(modelId);

    expect(service.hasModel(modelId)).toBe(false);
    expect(controlled.session.release).toHaveBeenCalledTimes(1);
  });

  it('rejects queued waiters when unload is requested during an active run', async () => {
    const controlled = createControlledSession();
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => controlled.session),
      },
    });

    const modelId = await service.loadModel({ modelId: 'queued-model', modelPath: 'model.onnx' });
    const first = service.run(modelId, createInput());
    const second = service.run(modelId, createInput());
    await vi.waitFor(() => expect(controlled.session.run).toHaveBeenCalledTimes(1));

    await expect(service.unloadModel(modelId)).rejects.toThrow(
      'Cannot unload model "queued-model" while 1 inference run(s) are active'
    );
    await expect(second).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });

    controlled.releaseOne();
    await first;
    await service.unloadModel(modelId);
  });

  it('evicts the least recently used idle model when the loaded model limit is reached', async () => {
    const createdSessions: any[] = [];
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => {
          const session = createImmediateSession();
          createdSessions.push(session);
          return session;
        }),
      },
    });

    await service.loadModel({ modelId: 'model-a', modelPath: 'a.onnx', maxLoadedModels: 2 });
    await service.loadModel({ modelId: 'model-b', modelPath: 'b.onnx', maxLoadedModels: 2 });
    await service.loadModel({ modelId: 'model-c', modelPath: 'c.onnx', maxLoadedModels: 2 });

    expect(service.hasModel('model-a')).toBe(false);
    expect(service.hasModel('model-b')).toBe(true);
    expect(service.hasModel('model-c')).toBe(true);
    expect(createdSessions[0].release).toHaveBeenCalledTimes(1);

    await service.dispose();
  });

  it('exposes execution provider diagnostics on model info', async () => {
    const session = createImmediateSession({ executionProvider: 'cpu' });
    dynamicImportMock.mockResolvedValue({
      Tensor: MockTensor,
      InferenceSession: {
        create: vi.fn(async () => session),
      },
    });

    const modelId = await service.loadModel({
      modelId: 'provider-model',
      modelPath: 'provider.onnx',
      executionProvider: 'cuda',
    });

    expect(service.getModelInfo(modelId)).toMatchObject({
      requestedExecutionProvider: 'cuda',
      configuredExecutionProviders: ['cuda', 'cpu'],
      effectiveExecutionProvider: 'cpu',
    });

    await service.dispose();
  });
});

function createInput(dims = [1, 2]) {
  return {
    input: {
      data: Array.from({ length: dims.reduce((total, dim) => total * dim, 1) }, (_, index) =>
        index + 1
      ),
      dims,
      type: 'float32' as const,
    },
  };
}
