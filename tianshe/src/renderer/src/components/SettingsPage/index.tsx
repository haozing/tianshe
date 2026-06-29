/**
 * SettingsPage - settings home.
 */

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { SchedulerPanel } from './SchedulerPanel';
import { HttpApiPanel } from './HttpApiPanel';
import { OcrPoolPanel } from './OcrPoolPanel';
import { CloudSnapshotPanel } from './CloudSnapshotPanel';
import { InternalBrowserPanel } from './InternalBrowserPanel';
import { BrowserRuntimePanel } from './BrowserRuntimePanel';
import { DatasetRecordEvidencePanel } from './DatasetRecordEvidencePanel';
import { SiteAdapterLabPanel } from './SiteAdapterLabPanel';
import { SiteAdapterRepairStudioPanel } from './SiteAdapterRepairStudioPanel';
import { PageFrameHeader } from '../layout/PageFrameHeader';
import { isCloudSnapshotAvailable } from '../../lib/edition';

function DeveloperToolsPanel() {
  const [activeTool, setActiveTool] = useState('data-evidence');

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold">v4 站点能力调试与修复</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          这些工具用于排查站点适配器、记录来源追溯和修复发布流程，面向高级用户和开发调试场景。
        </p>
      </div>

      <Tabs value={activeTool} onValueChange={setActiveTool} className="w-full">
        <TabsList className="h-auto rounded-lg border bg-white/80 p-1">
          <TabsTrigger className="h-8 rounded-md px-3 py-0" value="data-evidence">
            数据来源追溯
          </TabsTrigger>
          <TabsTrigger className="h-8 rounded-md px-3 py-0" value="site-adapter-lab">
            站点适配器调试
          </TabsTrigger>
          <TabsTrigger className="h-8 rounded-md px-3 py-0" value="site-adapter-repair">
            站点规则修复
          </TabsTrigger>
        </TabsList>

        <TabsContent value="data-evidence" className="mt-3">
          <DatasetRecordEvidencePanel />
        </TabsContent>

        <TabsContent value="site-adapter-lab" className="mt-3">
          <SiteAdapterLabPanel />
        </TabsContent>

        <TabsContent value="site-adapter-repair" className="mt-3">
          <SiteAdapterRepairStudioPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState('scheduler');
  const cloudSnapshotAvailable = isCloudSnapshotAvailable();
  const text = {
    title: '\u8bbe\u7f6e',
    subtitle: '\u7cfb\u7edf\u914d\u7f6e\u548c\u9ad8\u7ea7\u529f\u80fd\u7ba1\u7406',
    scheduler: '\u5b9a\u65f6\u4efb\u52a1',
    cloudSnapshot: '云端快照',
  };

  return (
    <div className="settings-page shell-content-surface flex h-full flex-col">
      <PageFrameHeader className="settings-page-header" title="系统设置" subtitle={text.subtitle} />

      <div className="settings-page-scroll shell-content-muted flex-1 overflow-auto p-3">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="settings-page-tabs-list h-auto rounded-lg border bg-white/80 p-1">
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="scheduler">
              {text.scheduler}
            </TabsTrigger>
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="http-api">
              HTTP API
            </TabsTrigger>
            {cloudSnapshotAvailable ? (
              <TabsTrigger className="h-8 rounded-md px-3 py-0" value="cloud-snapshot">
                {text.cloudSnapshot}
              </TabsTrigger>
            ) : null}
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="ocr">
              OCR
            </TabsTrigger>
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="internal-browser">
              内置浏览器
            </TabsTrigger>
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="browser-runtime">
              浏览器运行时
            </TabsTrigger>
            <TabsTrigger className="h-8 rounded-md px-3 py-0" value="developer-tools">
              开发者工具
            </TabsTrigger>
          </TabsList>

          <TabsContent value="scheduler" className="mt-3">
            <SchedulerPanel />
          </TabsContent>

          <TabsContent value="http-api" className="mt-3">
            <HttpApiPanel />
          </TabsContent>

          {cloudSnapshotAvailable ? (
            <TabsContent value="cloud-snapshot" className="mt-3">
              <CloudSnapshotPanel />
            </TabsContent>
          ) : null}

          <TabsContent value="ocr" className="mt-3">
            <OcrPoolPanel />
          </TabsContent>

          <TabsContent value="internal-browser" className="mt-3">
            <InternalBrowserPanel />
          </TabsContent>

          <TabsContent value="browser-runtime" className="mt-3">
            <BrowserRuntimePanel />
          </TabsContent>

          <TabsContent value="developer-tools" className="mt-3">
            <DeveloperToolsPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export default SettingsPage;
