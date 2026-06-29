import type { App } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface StartupDiagnosticLog {
  startupLogPath: string;
  logStartup: (message: string) => void;
}

export function createStartupDiagnosticLog(app: App): StartupDiagnosticLog {
  const startupLogPath = path.join(app.getPath('userData'), 'startup-diagnostic.log');

  const logStartup = (message: string): void => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    try {
      fs.appendFileSync(startupLogPath, line);
    } catch {
      // Ignore startup diagnostics write failures.
    }
  };

  try {
    logStartup(`startupLogPath=${startupLogPath}`);
    logStartup(`isPackaged=${app.isPackaged}`);
    logStartup(`appPath=${app.getAppPath()}`);
    logStartup(`platform=${process.platform} arch=${process.arch} osRelease=${os.release()}`);
    logStartup(
      `node=${process.versions.node} chrome=${process.versions.chrome} electron=${process.versions.electron}`
    );
  } catch {
    // ignore
  }

  return {
    startupLogPath,
    logStartup,
  };
}
