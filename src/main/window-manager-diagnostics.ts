import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export function appendStartupDiagnostic(message: string): void {
  const line = `[${new Date().toISOString()}] [WindowManager] ${message}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup-diagnostic.log'), line);
  } catch {
    // ignore diagnostic write failures
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error || 'unknown error');
}

export function buildMainWindowErrorHtml(title: string, summary: string, details: string[]): string {
  const detailItems = details
    .filter((item) => item.trim().length > 0)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", "PingFang SC", sans-serif;
        background: linear-gradient(135deg, #f5f7fb 0%, #eef2ff 100%);
        color: #1f2937;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: min(760px, calc(100vw - 48px));
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 20px;
        padding: 28px 32px;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.14);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0 0 16px;
        line-height: 1.6;
      }
      ul {
        margin: 0;
        padding-left: 20px;
        line-height: 1.7;
      }
      code {
        font-family: "Cascadia Code", "SFMono-Regular", monospace;
        background: #eef2ff;
        border-radius: 6px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(summary)}</p>
      <ul>${detailItems}</ul>
    </main>
  </body>
</html>`;
}

// ==================== 类型定义 ====================

/**
 * 弹窗配置
 */
