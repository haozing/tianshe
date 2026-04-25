/**
 * MobileNetExtractor 单元测试
 *
 * 测试 MobileNet 特征提取器的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// 使用 vi.hoisted 确保 mock 函数在模块加载前定义
const {
  mockSharpResize,
  mockSharpRemoveAlpha,
  mockSharpRaw,
  mockSharpToBuffer,
  mockSharp,
  mockLoadModel,
  mockUnloadModel,
  mockRun,
} = vi.hoisted(() => {
  const sharpResizeMock = vi.fn();
  const sharpRemoveAlphaMock = vi.fn();
  const sharpRawMock = vi.fn();
  const sharpToBufferMock = vi.fn();
  const sharpMock = vi.fn();
  const loadModelMock = vi.fn();
  const unloadModelMock = vi.fn();
  const runMock = vi.fn();

  return {
    mockSharpResize: sharpResizeMock,
    mockSharpRemoveAlpha: sharpRemoveAlphaMock,
    mockSharpRaw: sharpRawMock,
    mockSharpToBuffer: sharpToBufferMock,
    mockSharp: sharpMock,
    mockLoadModel: loadModelMock,
    mockUnloadModel: unloadModelMock,
    mockRun: runMock,
  };
});

// Mock dynamic-import
vi.mock('../utils/dynamic-import', () => ({
  dynamicImport: vi.fn().mockImplementation(async (moduleName: string) => {
    if (moduleName === 'sharp') {
      return { default: mockSharp };
    }
    throw new Error(`Unexpected module: ${moduleName}`);
  }),
}));

// Mock onnx-runtime
vi.mock('../onnx-runtime', () => ({
  getONNXService: vi.fn().mockReturnValue({
    loadModel: mockLoadModel,
    unloadModel: mockUnloadModel,
    run: mockRun,
  }),
  imageToNCHW: vi.fn().mockReturnValue(new Float32Array(1 * 3 * 224 * 224)),
  l2Normalize: vi.fn((vec: number[]) => {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-image')),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn().mockReturnValue({
      on: vi.fn((event, cb) => {
        if (event === 'finish') setTimeout(cb, 10);
        return { close: vi.fn() };
      }),
      close: vi.fn(),
    }),
    unlink: vi.fn(),
  };
});

// 现在可以安全地导入被测模块
import { MobileNetExtractor, createMobileNetExtractor } from './mobilenet-extractor';
import * as fs from 'fs';

describe('MobileNetExtractor', () => {
  let extractor: MobileNetExtractor;

  beforeEach(() => {
    vi.clearAllMocks();

    // 设置 sharp mock 返回值
    mockSharpResize.mockReturnThis();
    mockSharpRemoveAlpha.mockReturnThis();
    mockSharpRaw.mockReturnThis();
    mockSharpToBuffer.mockResolvedValue(Buffer.alloc(224 * 224 * 3));
    mockSharp.mockReturnValue({
      resize: mockSharpResize,
      removeAlpha: mockSharpRemoveAlpha,
      raw: mockSharpRaw,
      toBuffer: mockSharpToBuffer,
    });

    // 设置 ONNX mock 返回值
    mockLoadModel.mockResolvedValue('model-id-123');
    mockUnloadModel.mockResolvedValue(undefined);
    mockRun.mockResolvedValue({
      outputs: {
        output: {
          data: new Float32Array(576).fill(0.1),
          dims: [1, 576],
        },
      },
    });

    extractor = new MobileNetExtractor({
      modelPath: '/path/to/model.onnx',
      inputSize: [224, 224],
      featureDim: 576,
      normalizeOutput: true,
    });
  });

  afterEach(async () => {
    await extractor.dispose();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await extractor.initialize();

      expect(mockLoadModel).toHaveBeenCalledWith({
        modelPath: '/path/to/model.onnx',
        executionProvider: 'cpu',
      });
    });

    it('should only initialize once', async () => {
      await extractor.initialize();
      await extractor.initialize();

      expect(mockLoadModel).toHaveBeenCalledTimes(1);
    });

    it('should throw error if model path not set', async () => {
      const noPathExtractor = new MobileNetExtractor();

      await expect(noPathExtractor.initialize()).rejects.toThrow('Model path is required');
    });

    it('should throw error if model file not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      await expect(extractor.initialize()).rejects.toThrow('Model file not found');
    });

    it('should throw error if sharp not available', async () => {
      const { dynamicImport } = await import('../utils/dynamic-import');
      vi.mocked(dynamicImport).mockRejectedValueOnce(new Error('Cannot find sharp'));

      const newExtractor = new MobileNetExtractor({ modelPath: '/path/to/model.onnx' });
      await expect(newExtractor.initialize()).rejects.toThrow('sharp is required');
    });
  });

  describe('extract', () => {
    beforeEach(async () => {
      await extractor.initialize();
    });

    it('should extract features from Buffer', async () => {
      const imageBuffer = Buffer.from('fake-image-data');

      const features = await extractor.extract(imageBuffer);

      expect(mockSharp).toHaveBeenCalledWith(imageBuffer);
      expect(features).toHaveLength(576);
      expect(features.every((v) => typeof v === 'number')).toBe(true);
    });

    it('should extract features from file path', async () => {
      const imagePath = '/path/to/image.png';

      const features = await extractor.extract(imagePath);

      expect(fs.readFileSync).toHaveBeenCalledWith(imagePath);
      expect(features).toHaveLength(576);
    });

    it('should resize image to input size', async () => {
      await extractor.extract(Buffer.from('test'));

      expect(mockSharpResize).toHaveBeenCalledWith(224, 224, { fit: 'fill' });
    });

    it('should remove alpha channel', async () => {
      await extractor.extract(Buffer.from('test'));

      expect(mockSharpRemoveAlpha).toHaveBeenCalled();
    });

    it('should throw error if not initialized', async () => {
      // 创建新的 extractor，不调用 initialize
      const newExtractor = new MobileNetExtractor({ modelPath: '/path/to/model.onnx' });
      // 注意：不调用 initialize()，直接调用 extract

      await expect(newExtractor.extract(Buffer.from('test'))).rejects.toThrow('not initialized');
    });

    it('should throw error for non-existent file', async () => {
      // 注意：extractor 已在 beforeEach 中通过 initialize() 初始化
      // 此时 existsSync 需要在 extract 时返回 false（只影响本次调用）
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      await expect(extractor.extract('/non-existent.png')).rejects.toThrow('Image file not found');
    });

    it('should normalize output features', async () => {
      const { l2Normalize } = await import('../onnx-runtime');

      await extractor.extract(Buffer.from('test'));

      expect(l2Normalize).toHaveBeenCalled();
    });

    it('should not normalize if disabled', async () => {
      const noNormExtractor = new MobileNetExtractor({
        modelPath: '/path/to/model.onnx',
        normalizeOutput: false,
      });
      await noNormExtractor.initialize();

      const { l2Normalize } = await import('../onnx-runtime');
      vi.mocked(l2Normalize).mockClear();

      await noNormExtractor.extract(Buffer.from('test'));

      expect(l2Normalize).not.toHaveBeenCalled();
      await noNormExtractor.dispose();
    });

    it('should handle model output larger than featureDim', async () => {
      mockRun.mockResolvedValueOnce({
        outputs: {
          output: {
            data: new Float32Array(1000).fill(0.1),
            dims: [1, 1000],
          },
        },
      });

      const features = await extractor.extract(Buffer.from('test'));

      expect(features.length).toBeLessThanOrEqual(576);
    });
  });

  describe('extractBatch', () => {
    beforeEach(async () => {
      await extractor.initialize();
    });

    it('should extract features from multiple images', async () => {
      const images = [Buffer.from('image1'), Buffer.from('image2'), Buffer.from('image3')];

      const results = await extractor.extractBatch(images);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.length === 576)).toBe(true);
    });
  });

  describe('getFeatureDim', () => {
    it('should return configured feature dimension', () => {
      expect(extractor.getFeatureDim()).toBe(576);
    });
  });

  describe('getInputSize', () => {
    it('should return configured input size', () => {
      expect(extractor.getInputSize()).toEqual([224, 224]);
    });
  });

  describe('dispose', () => {
    it('should dispose and unload model', async () => {
      await extractor.initialize();
      await extractor.dispose();

      expect(mockUnloadModel).toHaveBeenCalledWith('model-id-123');
    });

    it('should be safe to call multiple times', async () => {
      await extractor.initialize();
      await extractor.dispose();
      await extractor.dispose();
      // 不应该抛出错误
    });
  });

  describe('static methods', () => {
    describe('isModelDownloaded', () => {
      it('should return true if model exists', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);

        expect(MobileNetExtractor.isModelDownloaded('/path/to/model.onnx')).toBe(true);
      });

      it('should return false if model not exists', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        expect(MobileNetExtractor.isModelDownloaded('/path/to/model.onnx')).toBe(false);
      });
    });

    describe('getModelPath', () => {
      it('should return correct model path', () => {
        const modelPath = MobileNetExtractor.getModelPath('/models', 'mobilenetv3-small');

        expect(modelPath).toBe(path.join('/models', 'mobilenetv3-small.onnx'));
      });

      it('should use default model name', () => {
        const modelPath = MobileNetExtractor.getModelPath('/models');

        expect(modelPath).toContain('mobilenetv3-small.onnx');
      });
    });
  });
});

describe('createMobileNetExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // 重新设置 mock
    mockSharpResize.mockReturnThis();
    mockSharpRemoveAlpha.mockReturnThis();
    mockSharpRaw.mockReturnThis();
    mockSharpToBuffer.mockResolvedValue(Buffer.alloc(224 * 224 * 3));
    mockSharp.mockReturnValue({
      resize: mockSharpResize,
      removeAlpha: mockSharpRemoveAlpha,
      raw: mockSharpRaw,
      toBuffer: mockSharpToBuffer,
    });
    mockLoadModel.mockResolvedValue('model-id-123');
    mockUnloadModel.mockResolvedValue(undefined);
    mockRun.mockResolvedValue({
      outputs: {
        output: {
          data: new Float32Array(576).fill(0.1),
          dims: [1, 576],
        },
      },
    });
  });

  it('should create and initialize extractor', async () => {
    const extractor = await createMobileNetExtractor('/models');

    expect(extractor).toBeInstanceOf(MobileNetExtractor);
    expect(mockLoadModel).toHaveBeenCalled();

    await extractor.dispose();
  });

  it('should pass execution provider option', async () => {
    const extractor = await createMobileNetExtractor('/models', {
      executionProvider: 'cuda',
    });

    expect(mockLoadModel).toHaveBeenCalledWith(
      expect.objectContaining({
        executionProvider: 'cuda',
      })
    );

    await extractor.dispose();
  });

  it('should auto-download if enabled and model missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // Mock downloadModel 不做实际下载
    const downloadSpy = vi.spyOn(MobileNetExtractor, 'downloadModel').mockResolvedValue(undefined);

    // 下载后模型存在
    vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValue(true);

    const extractor = await createMobileNetExtractor('/models', {
      autoDownload: true,
    });

    expect(downloadSpy).toHaveBeenCalled();

    downloadSpy.mockRestore();
    await extractor.dispose();
  });
});
