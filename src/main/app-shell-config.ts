import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  APP_SHELL_CONFIG_FILE_NAME,
  DEFAULT_APP_SHELL_CONFIG,
  normalizeAppShellConfig,
  type AppShellConfig,
} from '../shared/app-shell-config';

function uniqueExistingConfigCandidates(): string[] {
  const candidates: string[] = [];

  const addCandidate = (baseDir: string | undefined) => {
    const normalizedBase = String(baseDir || '').trim();
    if (!normalizedBase) return;
    candidates.push(path.join(normalizedBase, APP_SHELL_CONFIG_FILE_NAME));
  };

  addCandidate(path.dirname(process.execPath));
  addCandidate(app.getAppPath());
  addCandidate(process.cwd());
  addCandidate(app.getPath('userData'));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = path.resolve(candidate).toLowerCase();
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

export function getAppShellConfig(): AppShellConfig {
  for (const candidate of uniqueExistingConfigCandidates()) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const rawConfig = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return {
        ...normalizeAppShellConfig(rawConfig),
        source: candidate,
      };
    } catch (error) {
      console.warn(
        `[AppShellConfig] Failed to read ${candidate}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return {
    pages: { ...DEFAULT_APP_SHELL_CONFIG.pages },
  };
}
