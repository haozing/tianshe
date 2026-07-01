/**
 * 数据路径工具函数
 *
 * 🔽 从 src/main/duckdb/utils.ts 提取
 * 原因：被 src/core/js-plugin/plugin-installer.ts 等引用，消除 core→main 反向依赖
 */

import path from 'path';
import fs from 'fs-extra';
import { createRuntimeConfig, resolveUserDataDir } from '../constants/runtime-config';

function getUserDataDir(): string {
  const runtimeConfig = createRuntimeConfig();
  const configuredUserDataDir = resolveUserDataDir('', runtimeConfig);
  if (configuredUserDataDir.trim()) return configuredUserDataDir;

  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } };
    const userData = resolveUserDataDir(
      String(electron.app?.getPath?.('userData') || ''),
      runtimeConfig
    );
    if (userData && String(userData).trim()) return userData;
  } catch {
    // ignore: worker_threads 环境下可能没有 electron 模块
  }

  const fallback = resolveUserDataDir('', runtimeConfig);
  if (fallback.trim()) return fallback;

  throw new Error('Unable to resolve userData directory from runtime config.');
}

export function getDuckDBDataDir(): string {
  return path.join(getUserDataDir(), 'duckdb');
}

export function getImportsDir(): string {
  return path.join(getDuckDBDataDir(), 'imports');
}

export function getTempDir(): string {
  return path.join(getDuckDBDataDir(), 'temp');
}

export function getRuntimeArtifactsDir(): string {
  return path.join(getDuckDBDataDir(), 'runtime-artifacts');
}

export async function ensureDirectories(): Promise<void> {
  await fs.ensureDir(getDuckDBDataDir());
  await fs.ensureDir(getImportsDir());
  await fs.ensureDir(getTempDir());
  await fs.ensureDir(getRuntimeArtifactsDir());
}

export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}
