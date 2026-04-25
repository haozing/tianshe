/**
 * SchedulerPanel - 定时任务管理面板
 *
 * 运维视角展示定时任务列表、统计信息和执行历史
 */

import { useEffect, useState } from 'react';
import {
  Play,
  Pause,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Calendar,
  Trash2,
  History,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  useSchedulerStore,
  type ScheduledTask,
  type TaskExecution,
} from '../../stores/schedulerStore';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import {
  formatDuration,
  formatTimestamp as formatTime,
  getScheduleDescription,
} from '../../../../utils/scheduler-utils';

/**
 * 获取状态徽章
 */
function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
  > = {
    active: { variant: 'default', label: '运行中' },
    paused: { variant: 'secondary', label: '已暂停' },
    disabled: { variant: 'outline', label: '已禁用' },
    running: { variant: 'default', label: '执行中' },
    completed: { variant: 'default', label: '已完成' },
    failed: { variant: 'destructive', label: '失败' },
    cancelled: { variant: 'secondary', label: '已取消' },
  };

  const config = variants[status] || { variant: 'outline' as const, label: status };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}

/**
 * 执行历史对话框
 */
function HistoryDialog({
  task,
  open,
  onOpenChange,
}: {
  task: ScheduledTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { getTaskHistory } = useSchedulerStore();
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !task) return;

    let cancelled = false;

    const loadHistory = async () => {
      setLoading(true);
      try {
        const history = await getTaskHistory(task.id);
        if (!cancelled) {
          setExecutions(history);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [open, task, getTaskHistory]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>执行历史</DialogTitle>
          <DialogDescription>{task?.name}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : executions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">暂无执行记录</div>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {formatTime(exec.startedAt)}
                    </span>
                    <StatusBadge status={exec.status} />
                    <span className="text-sm">
                      {exec.triggerType === 'scheduled'
                        ? '定时'
                        : exec.triggerType === 'manual'
                          ? '手动'
                          : '恢复'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {formatDuration(exec.durationMs)}
                    </span>
                    {exec.error && (
                      <span
                        className="text-sm text-destructive truncate max-w-[200px]"
                        title={exec.error}
                      >
                        {exec.error}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 任务卡片
 */
function TaskCard({
  task,
  onTogglePause,
  onTrigger,
  onShowHistory,
  onDelete,
}: {
  task: ScheduledTask;
  onTogglePause: () => void;
  onTrigger: () => void;
  onShowHistory: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        {/* 任务头部 */}
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium truncate">{task.name}</h4>
              <StatusBadge status={task.status} />
            </div>
            {task.description && (
              <p className="text-sm text-muted-foreground mt-1 truncate">{task.description}</p>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center gap-1 ml-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={task.status === 'paused' ? '恢复' : '暂停'}
              onClick={onTogglePause}
              disabled={task.status === 'disabled'}
            >
              {task.status === 'paused' ? (
                <Play className="w-4 h-4" />
              ) : (
                <Pause className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="手动触发"
              onClick={onTrigger}
              disabled={task.status === 'disabled'}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="执行历史"
              onClick={onShowHistory}
            >
              <History className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="彻底删除" onClick={onDelete}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* 基本信息 */}
        <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="w-4 h-4" />
            {getScheduleDescription(task)}
          </span>
          <span className="flex items-center gap-1">
            {task.lastRunStatus === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-green-600" />
            ) : task.lastRunStatus === 'failed' ? (
              <XCircle className="w-4 h-4 text-red-600" />
            ) : (
              <Clock className="w-4 h-4" />
            )}
            上次: {formatTime(task.lastRunAt)}
          </span>
        </div>

        {/* 展开详情 */}
        {expanded && (
          <div className="mt-4 pt-4 border-t space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">插件 ID</span>
              <span className="font-mono">{task.pluginId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">下次执行</span>
              <span>{formatTime(task.nextRunAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">执行次数</span>
              <span>
                <span className="text-green-600">{task.runCount}</span>
                {' / '}
                <span className="text-red-600">{task.failCount}</span> 失败
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">创建时间</span>
              <span>{formatTime(task.createdAt)}</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export function SchedulerPanel() {
  const {
    tasks,
    stats,
    recentExecutions,
    isLoading,
    error,
    refresh,
    pauseTask,
    resumeTask,
    triggerTask,
    cancelTask,
  } = useSchedulerStore();

  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null);
  const [deleteTask, setDeleteTask] = useState<ScheduledTask | null>(null);

  // 初始加载
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 处理暂停/恢复
  const handleTogglePause = async (task: ScheduledTask) => {
    try {
      if (task.status === 'paused') {
        await resumeTask(task.id);
        toast.success(`任务 "${task.name}" 已恢复`);
      } else {
        await pauseTask(task.id);
        toast.success(`任务 "${task.name}" 已暂停`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  // 处理手动触发
  const handleTrigger = async (task: ScheduledTask) => {
    try {
      await triggerTask(task.id);
      toast.success(`任务 "${task.name}" 已触发执行`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '触发失败');
    }
  };

  // 处理删除
  const handleDelete = async () => {
    if (!deleteTask) return;
    try {
      await cancelTask(deleteTask.id);
      toast.success(`任务 "${deleteTask.name}" 已彻底删除`);
      setDeleteTask(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>总任务数</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>运行中</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.active}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>今日执行</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.todayExecutions}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>今日失败</CardDescription>
            </CardHeader>
            <CardContent>
              <div className={cn('text-2xl font-bold', stats.todayFailed > 0 && 'text-red-600')}>
                {stats.todayFailed}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 任务列表 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>定时任务</CardTitle>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={cn('w-4 h-4 mr-2', isLoading && 'animate-spin')} />
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="flex items-center gap-2 text-destructive mb-4">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          {tasks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>暂无定时任务</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onTogglePause={() => handleTogglePause(task)}
                  onTrigger={() => handleTrigger(task)}
                  onShowHistory={() => setHistoryTask(task)}
                  onDelete={() => setDeleteTask(task)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 最近执行记录 */}
      {recentExecutions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>最近执行</CardTitle>
            <CardDescription>最近 20 条执行记录</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentExecutions.map((exec) => (
                <div
                  key={exec.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {formatTime(exec.startedAt)}
                    </span>
                    <span className="text-sm font-mono">{exec.taskId.substring(0, 8)}...</span>
                    <StatusBadge status={exec.status} />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm">
                      {exec.triggerType === 'scheduled'
                        ? '定时'
                        : exec.triggerType === 'manual'
                          ? '手动'
                          : '恢复'}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {formatDuration(exec.durationMs)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 执行历史对话框 */}
      <HistoryDialog
        task={historyTask}
        open={!!historyTask}
        onOpenChange={(open) => !open && setHistoryTask(null)}
      />

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTask}
        onOpenChange={(open) => !open && setDeleteTask(null)}
        title="确认彻底删除"
        description={`确定要彻底删除任务 "${deleteTask?.name}" 吗？此操作不可撤销，任务的执行历史也会被删除。`}
        confirmText="彻底删除"
        cancelText="取消"
        variant="danger"
        onConfirm={handleDelete}
      />
    </div>
  );
}
