import type { ExtensionPackage } from '../../../../types/profile';
import { formatRuntimeInstallReason } from '../PluginMarket/pluginMarketShared';

export type PanelTab = 'repository' | 'binding';

export interface CloudCatalogItem {
  extensionId: string;
  name: string;
  description?: string;
  currentVersion?: string;
  canInstall?: boolean;
  installReason?: string;
}

export interface RunningProfileImpactItem {
  profileId: string;
  profileName: string;
  browserCount: number;
}

export interface RunningProfileImpact {
  affectedProfiles: RunningProfileImpactItem[];
  destroyedBrowsers: number;
}

export interface BatchBindPayload {
  profileIds: string[];
  packages: Array<{
    extensionId: string;
    version?: string | null;
    installMode?: 'required' | 'optional';
    sortOrder?: number;
    enabled?: boolean;
  }>;
  profileCount: number;
  packageCount: number;
}

export interface BatchUnbindPayload {
  profileIds: string[];
  extensionIds: string[];
  removePackageWhenUnused: boolean;
}

export type PendingBatchAction =
  | {
      type: 'bind';
      payload: BatchBindPayload;
      impact: RunningProfileImpact;
    }
  | {
      type: 'unbind';
      payload: BatchUnbindPayload;
      impact: RunningProfileImpact;
    };

export function toPackageKey(
  pkg: Pick<ExtensionPackage, 'extensionId' | 'version'>
): string {
  return `${pkg.extensionId}@@${pkg.version}`;
}

export function formatDateTime(value: unknown): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

export function formatCloudInstallReason(reason?: string): string {
  return formatRuntimeInstallReason(reason)
    .replace('可安装', '可下载')
    .replace('当前账号不在安装授权范围内', '当前用户无权限')
    .replace('当前身份不在安装授权范围内', '当前身份无权限');
}

