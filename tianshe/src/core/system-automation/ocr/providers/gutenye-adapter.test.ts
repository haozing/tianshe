/**
 * GutenOCRAdapter 单元测试
 *
 * 测试 PP-OCRv4 OCR 适配器的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GutenOCRAdapter } from './gutenye-adapter';

// Mock @gutenye/ocr-node
const mockOcrDetect = vi.fn();
const mockOcrCreate = vi.fn();

vi.mock('../../../utils/dynamic-import', () => ({
  dynamicImport: vi.fn().mockImplementation(async (moduleName: string) => {
    if (moduleName === '@gutenye/ocr-node') {
      return {
        create: mockOcrCreate,
      };
    }
    throw new Error(`Unexpected module: ${moduleName}`);
  }),
}));

// Helper function to create box from frame-like dimensions
// box format: [[左上x,左上y], [右上x,右上y], [右下x,右下y], [左下x,左下y]]
function createBox(
  left: number,
  top: number,
  width: number,
  height: number
): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [left, top], // top-left
    [left + width, top], // top-right
    [left + width, top + height], // bottom-right
    [left, top + height], // bottom-left
  ];
}

describe('GutenOCRAdapter', () => {
  let adapter: GutenOCRAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GutenOCRAdapter();

    // 设置默认的 mock OCR 实例
    mockOcrCreate.mockResolvedValue({
      detect: mockOcrDetect,
    });
  });

  afterEach(async () => {
    await adapter.terminate();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await adapter.initialize();

      expect(mockOcrCreate).toHaveBeenCalledWith({
        isDebug: false,
        debugOutputDir: undefined,
      });
    });

    it('should only initialize once', async () => {
      await adapter.initialize();
      await adapter.initialize();

      expect(mockOcrCreate).toHaveBeenCalledTimes(1);
    });

    it('should pass debug options', async () => {
      await adapter.initialize({ isDebug: true, debugOutputDir: '/tmp/debug' });

      expect(mockOcrCreate).toHaveBeenCalledWith({
        isDebug: true,
        debugOutputDir: '/tmp/debug',
      });
    });

    it('should handle concurrent initialization', async () => {
      // 模拟慢初始化
      mockOcrCreate.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ detect: mockOcrDetect }), 50))
      );

      const [result1, result2] = await Promise.all([adapter.initialize(), adapter.initialize()]);

      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
      expect(mockOcrCreate).toHaveBeenCalledTimes(1);
    });

    it('should throw error if module not found', async () => {
      const { dynamicImport } = await import('../../../utils/dynamic-import');
      vi.mocked(dynamicImport).mockRejectedValueOnce(
        Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
      );

      const newAdapter = new GutenOCRAdapter();
      await expect(newAdapter.initialize()).rejects.toThrow(
        'OCR requires @gutenye/ocr-node package'
      );
    });
  });

  describe('recognize', () => {
    // @gutenye/ocr-node 实际返回格式: 数组，每个元素有 text, mean, box
    const mockOcrResult = [
      {
        text: '新闻',
        mean: 0.95,
        box: createBox(20, 10, 50, 20),
      },
      {
        text: 'hao123',
        mean: 0.88,
        box: createBox(80, 10, 60, 20),
      },
      {
        text: '百度一下',
        mean: 0.72,
        box: createBox(200, 100, 120, 40),
      },
    ];

    beforeEach(() => {
      mockOcrDetect.mockResolvedValue(mockOcrResult);
    });

    it('should recognize text from Buffer', async () => {
      const imageBuffer = Buffer.from('fake-image-data');

      const results = await adapter.recognize(imageBuffer);

      expect(mockOcrDetect).toHaveBeenCalledWith(imageBuffer);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        text: '新闻',
        confidence: 95,
        bounds: { x: 20, y: 10, width: 50, height: 20 },
      });
    });

    it('should recognize text from file path', async () => {
      const imagePath = '/path/to/image.png';

      const results = await adapter.recognize(imagePath);

      expect(mockOcrDetect).toHaveBeenCalledWith(imagePath);
      expect(results).toHaveLength(3);
    });

    it('should filter by minConfidence', async () => {
      const imageBuffer = Buffer.from('fake-image-data');

      const results = await adapter.recognize(imageBuffer, { minConfidence: 80 });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.confidence >= 80)).toBe(true);
    });

    it('should handle empty results', async () => {
      mockOcrDetect.mockResolvedValue([]);

      const results = await adapter.recognize(Buffer.from('empty'));

      expect(results).toHaveLength(0);
    });

    it('should handle null result', async () => {
      mockOcrDetect.mockResolvedValue(null);

      const results = await adapter.recognize(Buffer.from('null-result'));

      expect(results).toHaveLength(0);
    });

    it('should handle undefined result', async () => {
      mockOcrDetect.mockResolvedValue(undefined);

      const results = await adapter.recognize(Buffer.from('undefined-result'));

      expect(results).toHaveLength(0);
    });

    it('should handle non-array result', async () => {
      mockOcrDetect.mockResolvedValue({ text: 'not-an-array' });

      const results = await adapter.recognize(Buffer.from('invalid-result'));

      expect(results).toHaveLength(0);
    });

    it('should trim text content', async () => {
      mockOcrDetect.mockResolvedValue([
        {
          text: '  空格文本  ',
          mean: 0.9,
          box: createBox(0, 0, 100, 20),
        },
      ]);

      const results = await adapter.recognize(Buffer.from('trim-test'));

      expect(results[0].text).toBe('空格文本');
    });

    it('should auto-initialize if not initialized', async () => {
      const results = await adapter.recognize(Buffer.from('auto-init'));

      expect(mockOcrCreate).toHaveBeenCalled();
      expect(results).toHaveLength(3);
    });

    it('should throw error on OCR failure', async () => {
      mockOcrDetect.mockRejectedValue(new Error('OCR engine error'));

      await expect(adapter.recognize(Buffer.from('error'))).rejects.toThrow('OCR engine error');
    });
  });

  describe('recognizeDetailed', () => {
    const mockOcrResult = [
      {
        text: '第一行文本',
        mean: 0.95,
        box: createBox(20, 10, 100, 20),
      },
      {
        text: '第二行文本',
        mean: 0.88,
        box: createBox(20, 40, 100, 20),
      },
    ];

    beforeEach(() => {
      mockOcrDetect.mockResolvedValue(mockOcrResult);
    });

    it('should return detailed results with lines', async () => {
      const results = await adapter.recognizeDetailed(Buffer.from('detailed'));

      expect(results).toHaveLength(2);
      expect(results[0].lines).toBeDefined();
      expect(results[0].lines).toHaveLength(1);
      expect(results[0].lines![0].text).toBe('第一行文本');
    });

    it('should not include words (PP-OCR limitation)', async () => {
      const results = await adapter.recognizeDetailed(Buffer.from('detailed'));

      expect(results[0].words).toBeUndefined();
    });

    it('should filter by minConfidence', async () => {
      const results = await adapter.recognizeDetailed(Buffer.from('detailed'), {
        minConfidence: 90,
      });

      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('第一行文本');
    });
  });

  describe('terminate', () => {
    it('should terminate successfully', async () => {
      await adapter.initialize();
      await adapter.terminate();

      // 再次初始化应该成功
      mockOcrCreate.mockClear();
      await adapter.initialize();
      expect(mockOcrCreate).toHaveBeenCalled();
    });

    it('should be safe to call multiple times', async () => {
      await adapter.initialize();
      await adapter.terminate();
      await adapter.terminate();
      // 不应该抛出错误
    });
  });

  describe('bounds conversion from box', () => {
    it('should correctly convert box to bounds', async () => {
      mockOcrDetect.mockResolvedValue([
        {
          text: 'test',
          mean: 0.9,
          box: createBox(50, 100, 200, 30),
        },
      ]);

      const results = await adapter.recognize(Buffer.from('bounds-test'));

      expect(results[0].bounds).toEqual({
        x: 50,
        y: 100,
        width: 200,
        height: 30,
      });
    });

    it('should handle tilted text box', async () => {
      // 模拟倾斜的文本框
      mockOcrDetect.mockResolvedValue([
        {
          text: 'tilted',
          mean: 0.9,
          box: [
            [10, 15], // top-left (slightly higher)
            [110, 10], // top-right
            [115, 35], // bottom-right (slightly lower)
            [15, 40], // bottom-left
          ] as [[number, number], [number, number], [number, number], [number, number]],
        },
      ]);

      const results = await adapter.recognize(Buffer.from('tilted-test'));

      // 应该取最小/最大值来计算边界框
      expect(results[0].bounds.x).toBe(10); // min of left points
      expect(results[0].bounds.y).toBe(10); // min of top points
      expect(results[0].bounds.width).toBe(105); // max right - min left = 115 - 10
      expect(results[0].bounds.height).toBe(30); // max bottom - min top = 40 - 10
    });
  });

  describe('confidence conversion', () => {
    it('should convert mean (0-1) to confidence (0-100)', async () => {
      mockOcrDetect.mockResolvedValue([
        {
          text: 'test',
          mean: 0.5,
          box: createBox(0, 0, 100, 20),
        },
        {
          text: 'test2',
          mean: 1.0,
          box: createBox(0, 0, 100, 20),
        },
        {
          text: 'test3',
          mean: 0.0,
          box: createBox(0, 0, 100, 20),
        },
      ]);

      const results = await adapter.recognize(Buffer.from('confidence-test'));

      expect(results[0].confidence).toBe(50);
      expect(results[1].confidence).toBe(100);
      expect(results[2].confidence).toBe(0);
    });
  });
});

describe('GutenOCRAdapter Integration Scenarios', () => {
  let adapter: GutenOCRAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GutenOCRAdapter();

    mockOcrCreate.mockResolvedValue({
      detect: mockOcrDetect,
    });
  });

  afterEach(async () => {
    await adapter.terminate();
  });

  it('should handle typical web page OCR scenario', async () => {
    // 模拟典型网页 OCR 结果 (实际 @gutenye/ocr-node 格式)
    mockOcrDetect.mockResolvedValue([
      { text: '新闻', mean: 0.95, box: createBox(37, 30, 32, 18) },
      { text: 'hao123', mean: 0.92, box: createBox(77, 30, 50, 18) },
      { text: '地图', mean: 0.94, box: createBox(140, 30, 32, 18) },
      { text: '百度', mean: 0.98, box: createBox(683, 155, 80, 50) },
      { text: '百度一下', mean: 0.96, box: createBox(1015, 269, 80, 36) },
    ]);

    const results = await adapter.recognize(Buffer.from('webpage-screenshot'));

    // 查找特定文本
    const news = results.find((r) => r.text === '新闻');
    expect(news).toBeDefined();
    expect(news!.confidence).toBeGreaterThan(90);

    const baidu = results.find((r) => r.text === '百度');
    expect(baidu).toBeDefined();
    expect(baidu!.bounds.x).toBeGreaterThan(600);
  });

  it('should handle Chinese and English mixed text', async () => {
    mockOcrDetect.mockResolvedValue([
      { text: 'Hello 世界', mean: 0.88, box: createBox(10, 10, 100, 20) },
      { text: 'AI写作 AI PPT', mean: 0.85, box: createBox(10, 50, 150, 20) },
    ]);

    const results = await adapter.recognize(Buffer.from('mixed-text'));

    expect(results).toHaveLength(2);
    expect(results[0].text).toContain('Hello');
    expect(results[0].text).toContain('世界');
  });

  it('should handle image with no text', async () => {
    mockOcrDetect.mockResolvedValue([]);

    const results = await adapter.recognize(Buffer.from('pure-image'));

    expect(results).toHaveLength(0);
  });
});
