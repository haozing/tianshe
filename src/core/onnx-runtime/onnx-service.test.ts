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
