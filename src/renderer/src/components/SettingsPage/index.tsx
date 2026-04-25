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
    <div className="shell-content-surface flex h-full flex-col">
      <PageFrameHeader title="系统设置" subtitle={text.subtitle} />

      <div className="shell-content-muted flex-1 overflow-auto p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="h-10 rounded-xl border bg-white/80">
            <TabsTrigger value="scheduler">{text.scheduler}</TabsTrigger>
            <TabsTrigger value="http-api">HTTP API</TabsTrigger>
            {cloudSnapshotAvailable ? (
              <TabsTrigger value="cloud-snapshot">{text.cloudSnapshot}</TabsTrigger>
            ) : null}
            <TabsTrigger value="ocr">OCR</TabsTrigger>
            <TabsTrigger value="internal-browser">内置浏览器</TabsTrigger>
          </TabsList>

          <TabsContent value="scheduler" className="mt-4">
            <SchedulerPanel />
          </TabsContent>

          <TabsContent value="http-api" className="mt-4">
            <HttpApiPanel />
          </TabsContent>

          {cloudSnapshotAvailable ? (
            <TabsContent value="cloud-snapshot" className="mt-4">
              <CloudSnapshotPanel />
            </TabsContent>
          ) : null}

          <TabsContent value="ocr" className="mt-4">
            <OcrPoolPanel />
          </TabsContent>

          <TabsContent value="internal-browser" className="mt-4">
            <InternalBrowserPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export default SettingsPage;
