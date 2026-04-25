/**
 * 卸载插件确认对话框
 * 允许用户选择是否同时删除插件创建的数据表
 */

import { useState, useEffect } from 'react';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { AlertTriangle, Table, Loader2, CheckCircle2, Circle } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';

interface PluginTable {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
}

interface UninstallPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginId: string;
  pluginName: string;
  onConfirm: (deleteTables: boolean) => Promise<void>;
}

/**
 * 格式化文件大小
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function UninstallPluginDialog({
  open,
  onOpenChange,
  pluginId,
  pluginName,
  onConfirm,
}: UninstallPluginDialogProps) {
  const [tables, setTables] = useState<PluginTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleteOption, setDeleteOption] = useState<'plugin-only' | 'plugin-and-tables'>(
    'plugin-only'
  );

  // 加载插件创建的表
  useEffect(() => {
    if (open && pluginId) {
      loadPluginTables();
    } else {
      // 对话框关闭时重置状态
      setDeleteOption('plugin-only');
      setTables([]);
    }
  }, [open, pluginId]);

  const loadPluginTables = async () => {
    setLoading(true);
    try {
      if (!window.electronAPI || !window.electronAPI.jsPlugin) {
        throw new Error('electronAPI is not available. Please ensure preload script is loaded.');
      }

      const result = await window.electronAPI.jsPlugin.getTables(pluginId);

      if (result.success && result.tables) {
        setTables(result.tables);
      } else {
        console.error('[UninstallPluginDialog] Failed to load plugin tables:', result.error);
        setTables([]);
      }
    } catch (error) {
      console.error('[UninstallPluginDialog] Failed to load plugin tables:', error);
      setTables([]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const deleteTables = deleteOption === 'plugin-and-tables';
      await onConfirm(deleteTables);
      onOpenChange(false);
    } catch (error) {
      console.error('[UninstallPluginDialog] Failed to uninstall plugin:', error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="确认卸载插件"
      description={`此操作将卸载插件「${pluginName}」`}
      maxWidth="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading || submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                卸载中...
              </>
            ) : (
              '确认卸载'
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            <span className="ml-2 text-sm text-gray-500">正在加载插件信息...</span>
          </div>
        ) : (
          <>
            {tables.length > 0 && (
              <Alert className="bg-blue-50 border-blue-200">
                <Table className="h-4 w-4 text-blue-600" />
                <AlertDescription>
                  <div className="font-medium text-blue-900 mb-2">
                    此插件创建了 {tables.length} 个数据表：
                  </div>
                  <ul className="text-sm text-blue-800 space-y-1 ml-4">
                    {tables.map((table) => (
                      <li key={table.id}>
                        • {table.name} ({table.rowCount} 行, {table.columnCount} 列,{' '}
                        {formatBytes(table.sizeBytes)})
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-3">
              <div className="text-sm font-medium mb-3">请选择卸载方式：</div>
              <div className="space-y-2">
                {/* 选项1：仅删除插件 */}
                <div
                  className={`border rounded-lg p-3 cursor-pointer transition-all ${
                    deleteOption === 'plugin-only'
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => setDeleteOption('plugin-only')}
                >
                  <div className="flex items-start gap-3">
                    {deleteOption === 'plugin-only' ? (
                      <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                    ) : (
                      <Circle className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-sm">仅删除插件（保留数据表）</div>
                      <div className="text-xs text-gray-500 mt-1">
                        数据表将留在原文件夹中（文件夹转为普通文件夹），您可以继续使用这些数据。重新安装插件时不会有冲突。
                      </div>
                    </div>
                  </div>
                </div>

                {/* 选项2：删除插件及数据表 */}
                {tables.length > 0 && (
                  <div
                    className={`border rounded-lg p-3 cursor-pointer transition-all ${
                      deleteOption === 'plugin-and-tables'
                        ? 'border-red-500 bg-red-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setDeleteOption('plugin-and-tables')}
                  >
                    <div className="flex items-start gap-3">
                      {deleteOption === 'plugin-and-tables' ? (
                        <CheckCircle2 className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                      ) : (
                        <Circle className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="font-medium text-sm text-red-600">
                          删除插件及其创建的所有数据表（⚠️ 不可恢复）
                        </div>
                        <div className="text-xs text-red-700 mt-1">
                          将永久删除 {tables.length} 个数据表及其所有数据
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {deleteOption === 'plugin-and-tables' && tables.length > 0 && (
              <Alert variant="destructive" className="bg-red-50 border-red-200">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-red-800">
                  <strong>警告：</strong>删除数据表后，所有数据将永久丢失，无法恢复！
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
