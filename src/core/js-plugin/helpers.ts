/**
 * JS 插件辅助工具
 *
 * 提供命名空间化的 API 接口，用于插件开发
 */

import type { DuckDBService } from '../../main/duckdb/service';
import type { JSPluginManifest } from '../../types/js-plugin';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { WindowManager } from '../../main/window-manager';
import { createLogger } from '../logger';

const logger = createLogger('PluginHelpers');

function createLazyNamespaceProxy<T extends object>(
  namespaceName: string,
  factory: () => T
): T {
  let instance: T | undefined;
  let initError: Error | undefined;

  const getInstance = (): T => {
    if (instance) {
      return instance;
    }

    if (initError) {
      throw initError;
    }

    try {
      instance = factory();
      return instance;
    } catch (error) {
      initError =
        error instanceof Error
          ? error
          : new Error(`Failed to initialize namespace "${namespaceName}": ${String(error)}`);
      logger.error(`[PluginHelpers] Failed to initialize namespace "${namespaceName}":`, initError);
      throw initError;
    }
  };

  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const current = getInstance();
      const value = Reflect.get(current as object, prop, receiver);
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(getInstance() as object, prop, value, receiver);
    },
    has(_target, prop) {
      return prop in (getInstance() as object);
    },
    ownKeys() {
      return Reflect.ownKeys(getInstance() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(getInstance() as object, prop);
      if (!descriptor) {
        return undefined;
      }
      return {
        ...descriptor,
        configurable: true,
      };
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(getInstance() as object);
    },
  });
}

// 导入命名空间
import { DatabaseNamespace } from './namespaces/database';
import { NetworkNamespace } from './namespaces/network';
import { UINamespace } from './namespaces/ui';
import { StorageNamespace } from './namespaces/storage';
import { UtilsNamespace } from './namespaces/utils';
import { WindowNamespace } from './namespaces/window';
import { PluginNamespace } from './namespaces/plugin';
import { FFINamespace } from './namespaces/ffi';
import { TaskQueueNamespace } from './namespaces/task-queue';
import { ButtonNamespace } from './namespaces/button';
import { SchedulerNamespace } from './namespaces/scheduler';
import { OpenAINamespace } from './namespaces/openai';
import { WebhookNamespace } from './namespaces/webhook';
import { RawNamespace } from './namespaces/raw';
import { AdvancedNamespace } from './namespaces/advanced';
import { ProfileNamespace } from './namespaces/profile';
import { AccountNamespace } from './namespaces/account';
import { SavedSiteNamespace } from './namespaces/saved-site';
import { CustomFieldNamespace } from './namespaces/custom-field';
import { CloudNamespace } from './namespaces/cloud';
import { ONNXNamespace } from './namespaces/onnx';
import { ImageNamespace } from './namespaces/image';
import { ImageSearchNamespace } from './namespaces/image-search';
import { OCRNamespace } from './namespaces/ocr';
import { CVNamespace } from './namespaces/cv';
import { VectorIndexNamespace } from './namespaces/vector-index';
import type { PluginContext } from './context';
import type { PluginRuntimeRegistry } from './runtime-registry';
import type { HookBus } from '../hookbus';
import type { WebhookSender } from '../../main/webhook/sender';
import { getBrowserPoolManager } from '../browser-pool';

/**
 * 插件辅助工具类
 *
 * 提供多个命名空间的 API：
 *
 * === 基础 API ===
 * - helpers.plugin.* - 插件自省（获取插件信息、数据表、配置等）
 * - helpers.database.* - 数据库操作（查询、插入、更新、删除等）
 * - helpers.network.* - 网络请求（GET、POST、PUT、DELETE、Webhook）
 * - helpers.ui.* - UI 操作（通知、获取当前数据集）
 * - helpers.storage.* - 存储管理（配置、持久化数据）
 * - helpers.utils.* - 工具函数（验证、格式化、ID 生成等）
 * - helpers.openai.* - OpenAI API（对话、嵌入、图像、语音、批量处理）
 * - helpers.profile.* - 浏览器配置/编排（Profile 管理、launch、池化回收）
 * - helpers.window.* - 窗口管理（创建模态窗口、登录窗口等）
 * - helpers.savedSite.* - 平台管理（saved_sites CRUD、抖店平台确保）
 * - helpers.ffi.* - FFI 调用（加载 DLL/动态库、调用函数、回调机制）
 * - helpers.taskQueue.* - 任务队列管理（并发控制、批量任务、进度监控）
 * - helpers.scheduler.* - 定时任务调度（Cron、固定间隔、一次性执行）
 * - helpers.customField.* - 云端自定义字段（实体/字段/索引/记录/关系）
 *
 * === AI/ML API ===
 * - helpers.onnx.* - ONNX 模型推理（加载模型、推理、预处理、后处理）
 * - helpers.imageSearch.* - 图像相似度搜索（模板匹配、HNSW 索引）
 * - helpers.ocr.* - OCR 文字识别（PP-OCRv4、中英文识别、文字查找）
 * - helpers.cv.* - OpenCV 通用图像处理（opencv-js + worker 并行）
 * - helpers.vectorIndex.* - 向量索引（HNSW、相似度搜索、索引持久化）
 *
 * === 原生 API ===
 * - helpers.raw.* - Electron 原生 API
 *   - helpers.raw.webContents.* - WebContents 核心方法
 *
 * === 高级 API（需要权限声明）===
 * - helpers.advanced.* - 高级 Electron API
 *   - helpers.advanced.clipboard.* - 系统剪贴板操作
 *   - helpers.advanced.desktopCapturer.* - 桌面截图/录制
 *   - helpers.advanced.fs.* - 文件系统访问（沙箱限制）
 *
 * === 浏览器公共接口（推荐方式）===
 * 通过 browser 实例直接访问：
 * - browser.native.* - 原生输入事件（isTrusted=true）
 * - browser.getCookies()/setCookie()/clearCookies() - Cookie 操作
 * - browser.getUserAgent() - 读取当前 User-Agent
 * - browser.screenshot()/screenshotDetailed()/snapshot() - 截图与页面快照
 * - browser.startNetworkCapture()/getNetworkEntries()/waitForResponse() - 网络捕获
 *
 * @example
 * // 插件自省
 * const info = helpers.plugin.getInfo();
 * const datasetId = helpers.plugin.getDataTableId('doudian_products');
 *
 * @example
 * // 数据库操作
 * const rows = await helpers.database.query('dataset_123');
 * await helpers.database.insert('dataset_123', { name: 'Product A' });
 *
 * @example
 * // 网络请求
 * const data = await helpers.network.get('https://api.example.com/data');
 * await helpers.network.post(url, { key: 'value' });
 *
 * @example
 * // UI 通知
 * await helpers.ui.success('操作成功！');
 * await helpers.ui.error('操作失败！');
 *
 * @example
 * // 存储管理
 * await helpers.storage.setConfig('apiKey', 'your-key');
 * const apiKey = await helpers.storage.getConfig('apiKey');
 *
 * @example
 * // 工具函数
 * const id = helpers.utils.generateId();
 * const batches = helpers.utils.chunk(array, 100);
 *
 * @example
 * // OpenAI API
 * helpers.openai.setApiKey('sk-xxx');
 * const response = await helpers.openai.chat({
 *   messages: [{ role: 'user', content: '你好' }],
 *   model: 'gpt-4o'
 * });
 * // 流式对话
 * for await (const chunk of helpers.openai.chatStream({
 *   messages: [{ role: 'user', content: '写一首诗' }]
 * })) {
 *   process.stdout.write(chunk.content);
 * }
 *
  * @example
  * // 浏览器自动化
  * const handle = await helpers.profile.launch('store-profile-1', {
  *   visible: true
  * });
  * try {
  *   await handle.browser.goto('https://example.com');
  *   await handle.browser.click('#login-btn');
  * } finally {
  *   await handle.release();
  * }
 *
 * @example
 * // 任务队列管理（并发控制）
 * const queue = await helpers.taskQueue.create({
 *   concurrency: 3,  // 最多同时运行 3 个任务
 *   timeout: 120000,
 *   retry: 2
 * });
 * for (const item of items) {
 *   queue.add(async () => {
 *     await processItem(item);
 *   }, { name: item.name });
 * }
 * await queue.onIdle();
 *
 * @example
 * // 浏览器子命名空间（推荐方式）
 * const handle = await helpers.profile.launch('store-profile-1', { visible: true });
 * const browser = handle.browser;
 * await browser.goto('https://example.com');
 *
 * // 原生点击（isTrusted=true，更难被检测）
 * const bounds = await browser.getElementBounds('#button');
 * await browser.native.click(bounds.centerX, bounds.centerY);
 *
 * // Cookie / User-Agent
 * const cookies = await browser.getCookies();
 * const userAgent = await browser.getUserAgent();
 *
 * // 截图/页面快照
 * const screenshot = await browser.screenshot();
 * const snapshot = await browser.snapshot({ includeNetwork: 'smart' });
 *
 * // 网络捕获
 * await browser.startNetworkCapture({ captureBody: true });
 * const metrics = browser.getNetworkEntries({ type: 'api' });
 * await handle.release();
 *
 * @example
 * // 桌面截图（高权限，需声明）
 * const screens = await helpers.advanced.desktopCapturer.getScreens();
 * console.log('可用屏幕:', screens.map(s => s.name));
 */
export class PluginHelpers {
  /** 插件自省命名空间 */
  public plugin!: PluginNamespace;

  /** 数据库操作命名空间 */
  public readonly database: DatabaseNamespace;

  /** 网络请求命名空间 */
  public readonly network: NetworkNamespace;

  /** UI 操作命名空间 */
  public readonly ui: UINamespace;

  /** 存储管理命名空间 */
  public readonly storage: StorageNamespace;

  /** 工具函数命名空间 */
  public readonly utils: UtilsNamespace;

  /** 窗口管理命名空间 */
  public readonly window: WindowNamespace;

  /** FFI 调用命名空间 */
  public readonly ffi: FFINamespace;

  /** 任务队列管理命名空间 */
  public readonly taskQueue: TaskQueueNamespace;

  /** 按钮管理命名空间 */
  public readonly button: ButtonNamespace;

  /** 定时任务调度命名空间 */
  public readonly scheduler: SchedulerNamespace;

  /** OpenAI API 命名空间 */
  public readonly openai: OpenAINamespace;

  /** Webhook 回调命名空间 */
  public readonly webhook: WebhookNamespace;

  /**
   * 原生 API 命名空间
   *
   * 提供 WebContents 核心方法的直接访问。
   * 注意：原生输入、Session、截图等功能已迁移到 browser 实例的子命名空间。
   *
   * @example
   * // WebContents 操作
   * const url = helpers.raw.webContents.getURL(browser);
   * await helpers.raw.webContents.executeJavaScript(browser, 'console.log("hello")');
   */
  public readonly raw: RawNamespace;

  /**
   * 高级 API 命名空间
   *
   * 提供需要特殊权限的高级能力：
   * - advanced.clipboard.* - 系统剪贴板操作
   * - advanced.desktopCapturer.* - 桌面截图/录制
   * - advanced.fs.* - 文件系统访问（沙箱限制）
   *
   * @example
   * // 剪贴板操作
   * helpers.advanced.clipboard.writeText('Hello');
   *
   * @example
   * // 桌面截图
   * const screens = await helpers.advanced.desktopCapturer.getScreens();
   */
  public readonly advanced: AdvancedNamespace;

  /**
   * 浏览器配置命名空间 (v2)
   *
   * 提供访问用户配置的浏览器 Profile 的能力
   *
   * @example
   * // 列出可用配置
   * const profiles = await helpers.profile.list();
   *
   * // 获取单个配置
   * const profile = await helpers.profile.get('profile-id');
   *
   * // 启动浏览器（通过浏览器池）
   * const handle = await helpers.profile.launch('profile-id');
   * await handle.browser.goto('https://example.com');
   * await handle.release(); // 使用完毕释放
   */
  public readonly profile: ProfileNamespace;

  /**
   * 账号管理命名空间
   * 提供管理绑定到 Profile 的账号的能力
   */
  public readonly account: AccountNamespace;

  /**
   * 平台管理命名空间
   * 提供 saved_sites 的 CRUD 和平台初始化能力
   */
  public readonly savedSite: SavedSiteNamespace;
  public readonly cloud: CloudNamespace;

  /**
   * 云端自定义字段命名空间
   * 提供实体/字段/索引/记录/关系的完整云端 API 封装
   */
  public readonly customField: CustomFieldNamespace;

  /**
   * ONNX 模型推理命名空间
   *
   * 提供 ONNX 模型加载和推理能力：
   * - 加载任意 ONNX 模型（MobileNet、ResNet 等）
   * - 执行推理
   * - 图像预处理
   * - 后处理工具（softmax、topK）
   *
   * @example
   * // 加载分类模型
   * const modelId = await helpers.onnx.loadModel('./models/mobilenet.onnx');
   *
   * // 预处理图像
   * const input = await helpers.onnx.preprocessImage('./img.jpg', {
   *   targetSize: [224, 224],
   *   normalize: 'imagenet'
   * });
   *
   * // 执行推理
   * const result = await helpers.onnx.run(modelId, { input });
   *
   * // 后处理
   * const probs = helpers.onnx.softmax(result.output.data);
   * const top5 = helpers.onnx.topK(probs, 5);
   */
  public readonly onnx: ONNXNamespace;

  /**
   * 图像相似度对比命名空间（pHash -> SSIM）
   */
  public readonly image: ImageNamespace;

  /**
   * 图像搜索命名空间
   *
   * 基于 MobileNetV3-Small + HNSW 的图像相似度搜索：
   * - 自动下载和管理特征提取模型
   * - 高效的向量索引搜索（O(log n)）
   * - 模板库管理和持久化
   *
   * @example
   * // 初始化（首次使用会自动下载模型）
   * await helpers.imageSearch.initialize();
   *
   * // 添加模板
   * await helpers.imageSearch.addTemplate('button-ok', './templates/ok.png');
   *
   * // 搜索相似图片
   * const results = await helpers.imageSearch.search('./screenshot.png', {
   *   topK: 5,
   *   threshold: 0.8
   * });
   *
   * // 直接比较两张图片
   * const similarity = await helpers.imageSearch.compare('./img1.png', './img2.png');
   */
  public readonly imageSearch: ImageSearchNamespace;

  /**
   * OCR 文字识别命名空间
   *
   * 基于 PP-OCRv4 提供高精度的中英文识别
   *
   * @example
   * // 识别图片中的文字
   * const results = await helpers.ocr.recognize('./screenshot.png');
   * for (const r of results) {
   *   console.log(`${r.text} (${r.confidence}%)`);
   * }
   *
   * // 查找特定文字的位置
   * const bounds = await helpers.ocr.findText('./screenshot.png', '登录');
   * if (bounds) {
   *   console.log(`找到位置: (${bounds.x}, ${bounds.y})`);
   * }
   *
   * // 检查是否包含某文字
   * const hasLogin = await helpers.ocr.hasText('./screenshot.png', '登录');
   */
  public readonly ocr: OCRNamespace;

  /**
   * OpenCV 通用图像处理命名空间
   *
   * 提供与 OCR 解耦的 OpenCV 能力（opencv-js + worker 并行）。
   */
  public readonly cv: CVNamespace;

  /**
   * 向量索引命名空间
   *
   * 提供通用的向量相似度搜索能力，基于 HNSW 算法
   *
   * @example
   * // 创建向量索引
   * const indexId = await helpers.vectorIndex.create({
   *   dim: 384,
   *   space: 'cosine'
   * });
   *
   * // 添加向量
   * await helpers.vectorIndex.add(indexId, 'doc-1', embedding1, { title: 'Doc 1' });
   *
   * // 搜索相似向量
   * const results = await helpers.vectorIndex.search(indexId, queryEmbedding, {
   *   topK: 10,
   *   threshold: 0.7
   * });
   */
  public readonly vectorIndex: VectorIndexNamespace;

  /** 清理函数列表（用于自动资源清理）*/
  private disposers: Array<() => void | Promise<void>> = [];

  /** 插件上下文引用（延迟设置） */
  private _context: PluginContext | null = null;

  private disposed = false;

  constructor(
    private duckdb: DuckDBService,
    private pluginId: string,
    private manifest: JSPluginManifest,
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager,
    private hookBus: HookBus,
    private webhookSender: WebhookSender,
    private runtimeRegistry?: PluginRuntimeRegistry
  ) {
    // 初始化所有命名空间
    this.database = new DatabaseNamespace(duckdb, pluginId);
    this.network = new NetworkNamespace(pluginId);
    this.ui = new UINamespace(pluginId);
    this.storage = new StorageNamespace(duckdb, pluginId, manifest);
    this.utils = new UtilsNamespace(pluginId, this);
    this.window = new WindowNamespace(
      pluginId,
      windowManager,
      viewManager,
      duckdb.getProfileService()
    );
    this.ffi = new FFINamespace(pluginId, manifest);
    this.taskQueue = new TaskQueueNamespace(pluginId, runtimeRegistry);
    this.button = new ButtonNamespace(duckdb, pluginId, () => this._context);
    this.scheduler = new SchedulerNamespace(pluginId);
    this.openai = new OpenAINamespace(pluginId, this.storage);
    this.webhook = new WebhookNamespace(pluginId, hookBus, webhookSender);

    // 原生 API 命名空间
    this.raw = new RawNamespace(pluginId);
    // advanced 依赖 Electron 主进程环境，延迟到真正访问时再初始化，
    // 避免新增命名空间把不使用它的旧插件一起拖挂。
    this.advanced = createLazyNamespaceProxy('advanced', () => new AdvancedNamespace(pluginId));

    // v2: 浏览器配置命名空间（直接访问服务，支持池化浏览器）
    this.profile = new ProfileNamespace(
      pluginId,
      duckdb.getProfileService(),
      duckdb.getProfileGroupService(),
      viewManager,
      windowManager,
      (key: string) => this.storage.getConfig(key)
    );

    // v2: 账号管理命名空间
    this.account = new AccountNamespace(pluginId, duckdb.getAccountService());

    // v2: 平台管理命名空间
    this.savedSite = new SavedSiteNamespace(pluginId, duckdb.getSavedSiteService());
    this.cloud = new CloudNamespace(pluginId);

    // 云端自定义字段命名空间
    this.customField = new CustomFieldNamespace(pluginId);

    // ONNX 模型推理命名空间
    this.onnx = new ONNXNamespace(pluginId);

    // 图像相似度对比命名空间（pHash -> SSIM）
    this.image = new ImageNamespace(pluginId);

    // 图像搜索命名空间
    this.imageSearch = new ImageSearchNamespace(pluginId);

    // OCR 文字识别命名空间
    this.ocr = new OCRNamespace(pluginId);

    // OpenCV 通用图像处理命名空间
    this.cv = new CVNamespace(pluginId);

    // 向量索引命名空间
    this.vectorIndex = new VectorIndexNamespace(pluginId);
  }

  /**
   * 设置当前操作的数据集ID（内部方法）
   *
   * 用于在 UI 扩展上下文中设置当前数据集
   *
   * @internal
   */
  setCurrentDataset(datasetId: string | null): void {
    this.ui.setCurrentDataset(datasetId);
  }

  /**
   * 设置插件上下文（内部方法）
   *
   * 在 PluginContext 创建后调用，初始化 plugin 命名空间
   *
   * @internal
   */
  setContext(context: PluginContext): void {
    this._context = context;
    this.plugin = new PluginNamespace(this.pluginId, context);
  }

  /**
   * 注册资源清理函数（内部方法）
   *
   * 在插件停止时自动调用，用于清理定时器、事件监听器等资源
   *
   * @internal
   */
  registerDisposer(disposer: () => void | Promise<void>): void {
    this.disposers.push(disposer);
  }

  /**
   * 清理资源（内部方法）
   *
   * 在插件停止时调用，清理所有注册的资源
   *
   * @internal
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      logger.debug(`[PluginHelpers] Resources already disposed for plugin: ${this.pluginId}`);
      return;
    }

    this.disposed = true;
    logger.info(`[PluginHelpers] Disposing resources for plugin: ${this.pluginId}`);

    // 1. 清理所有注册的 disposers（定时器、事件监听器等）
    for (const disposer of this.disposers) {
      try {
        await disposer();
      } catch (error) {
        logger.error(`[PluginHelpers] Disposer failed for plugin ${this.pluginId}:`, error);
      }
    }
    this.disposers = [];

    // 2. 清理任务队列（停止所有正在运行的任务）
    try {
      await this.taskQueue.stopAll();
      logger.debug(`  ✓ Task queues stopped`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to stop task queues:`, error);
    }

    // 2.5. 清理定时任务调度器
    try {
      await this.scheduler.dispose();
      logger.debug(`  ✓ Scheduler disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose scheduler:`, error);
    }

    // 2.6. 清理 Webhook 监听器（防止热重载后重复注册）
    try {
      this.webhook.dispose();
      logger.debug(`  ✓ Webhook listeners disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose webhook:`, error);
    }

    // 3. 清理浏览器池中该插件持有的资源
    try {
      const poolManager = getBrowserPoolManager();
      const released = await poolManager.releaseByPlugin(this.pluginId);
      if (released.browsers > 0 || released.requests > 0) {
        console.log(
          `  ✓ Browser pool resources released (browsers: ${released.browsers}, requests: ${released.requests})`
        );
      }
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to release browser pool resources:`, error);
    }

    // 4. ✅ 修复：清理 FFI 资源（卸载动态库、释放回调函数）
    try {
      this.ffi.dispose();
      logger.debug(`  ✓ FFI resources disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose FFI:`, error);
    }

    // 5. 清理 ONNX 模型资源
    try {
      await this.onnx.dispose();
      logger.debug(`  ✓ ONNX resources disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose ONNX:`, error);
    }

    // 6. 清理图像搜索资源
    try {
      await this.imageSearch.dispose();
      logger.debug(`  ✓ Image search resources disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose image search:`, error);
    }

    // 7. 清理 OCR 资源
    try {
      await this.ocr.dispose();
      logger.debug(`  ✓ OCR resources disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose OCR:`, error);
    }

    // 7.5. 清理 OpenCV 资源（当前为全局 worker 池，不会在插件卸载时终止）
    try {
      await this.cv.dispose();
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose OpenCV:`, error);
    }

    // 8. 清理向量索引资源
    try {
      await this.vectorIndex.dispose();
      logger.debug(`  ✓ Vector index resources disposed`);
    } catch (error) {
      logger.error(`[PluginHelpers] Failed to dispose vector index:`, error);
    }

    logger.info(`[PluginHelpers] Resources disposed for plugin: ${this.pluginId}`);
  }
}
