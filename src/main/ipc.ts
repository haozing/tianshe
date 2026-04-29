/**
 * IPC 处理器 - 重构版本
 * 职责：协调各个专门的 IPC 处理器
 *
 * 架构改进：
 * - 将原来的 God Class（883行，10个职责）拆分成专门处理器
 * - IPCHandler 现在是一个 Coordinator，负责初始化和协调各个处理器
 * - 每个专门处理器只处理一类相关的 IPC 消息
 */

import { BrowserWindow } from 'electron';
import { LogStorageService } from './log-storage-service';
import { DownloadManager } from './download';
import { DuckDBService } from './duckdb/service';
import { WindowManager } from './window-manager';
import { WebContentsViewManager } from './webcontentsview-manager';

// 导入专门处理器
import { DatasetIPCHandler } from './ipc-handlers/dataset-handler';
import { ViewIPCHandler } from './ipc-handlers/view-handler';
import { QueryTemplateIPCHandler } from './ipc-handlers/query-template-handler';
import { SystemIPCHandler } from './ipc-handlers/system-handler';
import { FileIPCHandler } from './ipc-handlers/file-handler';

/**
 * IPC 处理器协调器
 * 负责：初始化、协调各个专门的 IPC 处理器
 */
export class IPCHandler {
  // 专门处理器
  private datasetHandler: DatasetIPCHandler;
  private viewHandler: ViewIPCHandler;
  private queryTemplateHandler: QueryTemplateIPCHandler;
  private systemHandler: SystemIPCHandler;
  private fileHandler: FileIPCHandler;

  constructor(
    private logger: LogStorageService,
    private downloadManager: DownloadManager,
    private duckdbService: DuckDBService,
    private mainWindow: BrowserWindow,
    private windowManager: WindowManager,
    private viewManager: WebContentsViewManager
  ) {
    // 初始化所有专门处理器
    this.datasetHandler = new DatasetIPCHandler(duckdbService);
    this.viewHandler = new ViewIPCHandler(viewManager, windowManager);
    this.queryTemplateHandler = new QueryTemplateIPCHandler(duckdbService);
    this.systemHandler = new SystemIPCHandler(logger, downloadManager, mainWindow);
    this.fileHandler = new FileIPCHandler(mainWindow);

    // 注册所有处理器
    this.registerAllHandlers();

    // 设置事件转发
    this.setupEventForwarding();
  }

  /**
   * 注册所有专门处理器
   */
  private registerAllHandlers(): void {
    this.datasetHandler.register();
    this.viewHandler.register();
    this.queryTemplateHandler.register();
    this.systemHandler.register();
    this.fileHandler.register();

    // 注意：registerDatasetFolderHandlers 已在 main/index.ts 的 initializeServices() 中提前调用
    // 这是为了让 JSPluginManager 能够在初始化时获取 folderManager

    console.log('✅ All IPC handlers registered');
  }

  /**
   * 设置事件转发（从后端到前端）
   */
  private setupEventForwarding(): void {
    // 事件映射：{ emitter, events[] }
    const eventMappings = [
      {
        emitter: this.downloadManager,
        events: [
          'download:started',
          'download:progress',
          'download:completed',
          'download:cancelled',
          'download:interrupted',
        ],
      },
    ];

    // 自动注册所有事件转发
    eventMappings.forEach(({ emitter, events }) => {
      events.forEach((event) => {
        emitter.on(event, (data: any) => {
          this.sendToRenderer(event, data);
        });
      });
    });
  }

  /**
   * 发送事件到渲染进程
   */
  private sendToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}
