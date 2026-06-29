import fs from 'node:fs';
import path from 'node:path';
import { app, session } from 'electron';
import { resolveUserDataDir } from '../../constants/runtime-config';
import { createLogger } from '../../core/logger';

const DEFERRED_PARTITION_CLEANUP_FILE = 'profile-partition-cleanup.json';
const PARTITION_DELETE_RETRY_DELAYS_MS = [200, 350, 550, 800, 1200, 1600];
const logger = createLogger('ProfilePartitionCleanupService');

export class ProfilePartitionCleanupService {
  async sweepDeferredPartitionCleanup(): Promise<void> {
    const entries = await this.readDeferredPartitionCleanupEntries();
    if (entries.length === 0) {
      return;
    }

    const remaining: string[] = [];
    for (const storagePath of entries) {
      try {
        const result = await this.removePartitionStoragePath(storagePath);
        if (result === 'deferred') {
          remaining.push(storagePath);
        }
      } catch (error) {
        logger.warn('Failed to sweep deferred partition cleanup', {
          storagePath,
          error,
        });
        remaining.push(storagePath);
      }
    }

    await this.writeDeferredPartitionCleanupEntries(remaining);
  }

  async purgePartitionData(partition: string): Promise<void> {
    try {
      const ses = session.fromPartition(partition);

      try {
        await ses.clearStorageData();
      } catch {
        // ignore
      }
      try {
        await ses.clearCache();
      } catch {
        // ignore
      }
      try {
        ses.flushStorageData();
      } catch {
        // ignore
      }
      try {
        await ses.cookies.flushStore();
      } catch {
        // ignore
      }

      const storagePath = ses.storagePath;
      if (storagePath && fs.existsSync(storagePath)) {
        const result = await this.removePartitionStoragePath(storagePath);
        if (result === 'deferred') {
          await this.enqueueDeferredPartitionCleanup(storagePath);
          logger.info('Deferred partition cleanup until next launch', {
            partition,
            storagePath,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to purge partition data', {
        partition,
        error,
      });
    }
  }

  async purgeExtensionProfileData(profileId: string): Promise<void> {
    const userDataDir = this.getUserDataDir();
    const targets = [
      path.join(userDataDir, 'extension', 'chrome', 'profiles', profileId),
      path.join(userDataDir, 'extension', 'chrome', 'control-runtime', profileId),
    ];

    for (const target of targets) {
      try {
        if (fs.existsSync(target)) {
          await fs.promises.rm(target, { recursive: true, force: true });
        }
      } catch (error) {
        logger.warn('Failed to purge extension profile data', {
          target,
          error,
        });
      }
    }
  }

  async purgeCloakProfileData(profileId: string): Promise<void> {
    const userDataDir = this.getUserDataDir();
    const targets = [
      path.join(userDataDir, 'cloak', 'profiles', profileId),
      path.join(userDataDir, 'cloak', 'downloads', profileId),
    ];

    for (const target of targets) {
      try {
        if (fs.existsSync(target)) {
          await fs.promises.rm(target, { recursive: true, force: true });
        }
      } catch (error) {
        logger.warn('Failed to purge Cloak profile data', {
          target,
          error,
        });
      }
    }
  }

  private getUserDataDir(): string {
    return resolveUserDataDir(app.getPath('userData'));
  }

  private getDeferredPartitionCleanupPath(): string {
    return path.join(this.getUserDataDir(), DEFERRED_PARTITION_CLEANUP_FILE);
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryablePartitionCleanupError(error: unknown): boolean {
    const code =
      typeof error === 'object' && error !== null ? String((error as any).code || '') : '';
    return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
  }

  private async readDeferredPartitionCleanupEntries(): Promise<string[]> {
    try {
      const filePath = this.getDeferredPartitionCleanupPath();
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  private async writeDeferredPartitionCleanupEntries(entries: string[]): Promise<void> {
    const filePath = this.getDeferredPartitionCleanupPath();
    const normalized = Array.from(
      new Set(entries.map((entry) => String(entry || '').trim()).filter(Boolean))
    );

    if (normalized.length === 0) {
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      return;
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  private async enqueueDeferredPartitionCleanup(storagePath: string): Promise<void> {
    const entries = await this.readDeferredPartitionCleanupEntries();
    entries.push(storagePath);
    await this.writeDeferredPartitionCleanupEntries(entries);
  }

  private async removePartitionStoragePath(
    storagePath: string
  ): Promise<'removed' | 'missing' | 'deferred'> {
    if (!storagePath || !fs.existsSync(storagePath)) {
      return 'missing';
    }

    for (let attempt = 0; attempt < PARTITION_DELETE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await fs.promises.rm(storagePath, { recursive: true, force: true });
        return 'removed';
      } catch (error) {
        if (!this.isRetryablePartitionCleanupError(error)) {
          throw error;
        }

        if (attempt === PARTITION_DELETE_RETRY_DELAYS_MS.length - 1) {
          return 'deferred';
        }

        await this.wait(PARTITION_DELETE_RETRY_DELAYS_MS[attempt]);
      }
    }

    return 'deferred';
  }
}
