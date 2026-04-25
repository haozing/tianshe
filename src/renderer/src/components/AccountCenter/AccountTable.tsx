import { Eye, EyeOff, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import type { Account, SavedSite } from '../../../../types/profile';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { isAccountReadOnlyForCloudUser, normalizeBoundProfileId } from './accountManagementShared';

interface AccountTableProps {
  accounts: Account[];
  currentCloudUserId?: number | null;
  profileNameById: Map<string, string>;
  platformById: Map<string, SavedSite>;
  revealedPasswords: Record<string, string | null>;
  visiblePasswords: Record<string, boolean>;
  onOpenBrowser: (account: Account) => void;
  onTogglePasswordVisible: (account: Account) => void;
  onEditAccount: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
}

export function AccountTable({
  accounts,
  currentCloudUserId,
  profileNameById,
  platformById,
  revealedPasswords,
  visiblePasswords,
  onOpenBrowser,
  onTogglePasswordVisible,
  onEditAccount,
  onDeleteAccount,
}: AccountTableProps) {
  const resolvePlatform = (account: Account) => {
    return account.platformId ? platformById.get(account.platformId) : undefined;
  };

  return (
    <div className="flex h-full min-h-[360px] flex-col overflow-hidden rounded-[18px] border border-[rgba(214,221,234,0.78)] bg-white/92 shadow-[0_8px_20px_rgba(20,27,45,0.04)]">
      <div className="flex items-center justify-between border-b border-[rgba(214,221,234,0.78)] bg-white/88 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">账号列表</h3>
        </div>
        <div className="shell-field-chip shell-field-chip--ghost px-3 py-1.5 text-xs">
          当前 {accounts.length} 个账号
        </div>
      </div>

      <div className="relative flex-1 overflow-auto">
        <table className="w-full min-w-[1160px] border-separate border-spacing-0 text-sm md:min-w-[1240px]">
          <thead className="sticky top-0 z-20 bg-[rgba(247,250,254,0.96)] backdrop-blur">
            <tr className="text-left">
              <th className="sticky left-0 z-20 w-[72px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.98)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
                序号
              </th>
              <th className="min-w-[160px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                平台
              </th>
              <th className="min-w-[180px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                名称
              </th>
              <th className="min-w-[220px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                登录账号
              </th>
              <th className="min-w-[240px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                登录地址
              </th>
              <th className="min-w-[220px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                浏览器环境
              </th>
              <th className="min-w-[220px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                标签
              </th>
              <th className="min-w-[220px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.96)] px-3 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">
                备注
              </th>
              <th className="sticky right-0 z-30 w-[168px] border-b border-[rgba(214,221,234,0.78)] bg-[rgba(247,250,254,0.98)] px-3 py-3 text-right text-xs font-semibold uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="bg-white/92">
            {accounts.map((account, index) => {
              const platform = resolvePlatform(account);
              const platformName = platform?.name || '平台已删除';
              const accountProfileId = normalizeBoundProfileId(account.profileId);
              const hasAccountProfile =
                accountProfileId.length > 0 && profileNameById.has(accountProfileId);
              const accountSessionLabel = accountProfileId
                ? profileNameById.get(accountProfileId) || '账号环境已删除'
                : '未绑定浏览器环境';
              const canLogin = Boolean(platform && hasAccountProfile);
              const isReadOnly = isAccountReadOnlyForCloudUser(account, currentCloudUserId);
              const canRevealPassword = Boolean(account.hasPassword) && !isReadOnly;
              const accountPassword = revealedPasswords[account.id] || '';
              const isPasswordVisible = Boolean(visiblePasswords[account.id]);
              const passwordSummary = !account.hasPassword
                ? '密码：未保存'
                : isReadOnly
                  ? '密码：当前云账号不可查看'
                  : isPasswordVisible
                    ? `密码：${accountPassword.length > 0 ? accountPassword : '空密码'}`
                    : '密码：••••••';

              return (
                <tr key={account.id} className="hover:bg-slate-50/70">
                  <td className="sticky left-0 z-10 border-b border-[rgba(214,221,234,0.72)] bg-white/96 px-3 py-3 align-top text-muted-foreground backdrop-blur">
                    {index + 1}
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <div className="space-y-1">
                      <div className="font-medium text-slate-900">{platformName}</div>
                      {platform?.url ? (
                        <div
                          className="truncate text-xs text-muted-foreground"
                          title={platform.url}
                        >
                          {platform.url}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <div className="space-y-1">
                      <div
                        className="max-w-[220px] truncate font-medium text-slate-900"
                        title={account.displayName || account.name || '-'}
                      >
                        {account.displayName || account.name || '-'}
                      </div>
                    </div>
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="max-w-[180px] truncate font-medium text-slate-900"
                          title={account.name}
                        >
                          {account.name}
                        </span>
                        {isReadOnly ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                            云端只读
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{passwordSummary}</div>
                    </div>
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <div
                      className="max-w-[280px] truncate text-muted-foreground"
                      title={account.loginUrl}
                    >
                      {account.loginUrl}
                    </div>
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <span
                      title={accountSessionLabel}
                      className={cn(
                        'inline-flex max-w-[220px] truncate rounded-full px-2 py-0.5 text-xs',
                        hasAccountProfile
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      )}
                    >
                      {accountSessionLabel}
                    </span>
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    {(account.tags || []).length > 0 ? (
                      <div className="flex max-w-[240px] flex-wrap gap-1">
                        {(account.tags || []).map((tagValue) => (
                          <span
                            key={tagValue}
                            className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
                          >
                            {tagValue}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="border-b border-[rgba(214,221,234,0.72)] px-3 py-3 align-top">
                    <div className="max-w-[220px] whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {account.notes?.trim() || '-'}
                    </div>
                  </td>
                  <td className="sticky right-0 z-10 border-b border-[rgba(214,221,234,0.72)] bg-white/96 px-3 py-3 align-top shadow-[-12px_0_18px_-18px_rgba(15,23,42,0.38)] backdrop-blur">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenBrowser(account)}
                        disabled={!canLogin}
                        title={canLogin ? '按登录 URL 启动浏览器' : '当前账号无可用浏览器环境'}
                      >
                        <Play className="mr-1 h-3.5 w-3.5" />
                        启动
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="更多操作"
                            aria-label="更多操作"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[150px]">
                          <DropdownMenuItem
                            onClick={() => onTogglePasswordVisible(account)}
                            disabled={!canRevealPassword}
                          >
                            {isPasswordVisible ? (
                              <EyeOff className="mr-2 h-3.5 w-3.5" />
                            ) : (
                              <Eye className="mr-2 h-3.5 w-3.5" />
                            )}
                            {isPasswordVisible ? '隐藏密码' : '显示密码'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onEditAccount(account)}
                            disabled={isReadOnly}
                          >
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            编辑账号
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive hover:text-destructive"
                            onClick={() => onDeleteAccount(account)}
                            disabled={isReadOnly}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            删除账号
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}

            {accounts.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-14 text-center text-sm text-slate-500">
                  暂无账号数据，请先添加账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
