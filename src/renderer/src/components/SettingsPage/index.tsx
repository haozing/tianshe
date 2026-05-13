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
import { PageFrameHeader } from '../layout/PageFrameHeader';
import { isCloudSnapshotAvailable } from '../../lib/edition';

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
        </Tabs>
      </div>
    </div>
  );
}

export default SettingsPage;
