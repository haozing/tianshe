/**
 * Windows 对话框按键自动化
 *
 * 🔽 从 src/main/profile/ruyi-firefox-launch-helpers.ts 提取
 * 原因：被 src/core/browser-extension/extension-browser.ts 引用，消除 core→main 反向依赖
 */

import { execFile } from 'node:child_process';

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeForWindowsSendKeys(value: string): string {
  return value.replace(/[+^%~()[\]{}]/g, (char) => `{${char}}`);
}

export async function sendWindowsDialogKeys(options: {
  processId?: number | null;
  accept: boolean;
  promptText?: string;
}): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }

  const pid = Number(options.processId);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const steps: string[] = [
    '$wshell = New-Object -ComObject WScript.Shell',
    `$null = $wshell.AppActivate(${pid})`,
    'Start-Sleep -Milliseconds 400',
  ];

  if (typeof options.promptText === 'string' && options.promptText.length > 0) {
    const escapedText = escapeForWindowsSendKeys(options.promptText);
    steps.push(`$wshell.SendKeys('${escapePowerShellSingleQuoted(escapedText)}')`);
    steps.push('Start-Sleep -Milliseconds 150');
  }

  steps.push(`$wshell.SendKeys('${options.accept ? '{ENTER}' : '{ESC}'}')`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', steps.join('; ')],
      { windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });

  return true;
}
