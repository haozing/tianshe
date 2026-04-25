import { execFile, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

export async function killChildProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
    });
    return;
  }

  child.kill('SIGTERM');
  const exited = await Promise.race([
    waitForChildExit(child).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
  }
}

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

export async function findFreeTcpPort(start: number = 9222, end: number = 9322): Promise<number> {
  for (let port = start; port < end; port += 1) {
    const candidate = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (candidate) {
      return port;
    }
  }

  throw new Error(`No free Firefox remote debugging port found in [${start}, ${end})`);
}

async function requestJson(
  url: string,
  timeoutMs: number
): Promise<Record<string, unknown> | unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown> | unknown[];
  } finally {
    clearTimeout(timer);
  }
}

async function probeWebSocketUrl(url: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    try {
      socket = new WebSocket(url);
      socket.addEventListener('open', () => finish(true), { once: true });
      socket.addEventListener('error', () => finish(false), { once: true });
      socket.addEventListener('close', () => finish(false), { once: true });
    } catch {
      finish(false);
    }
  });
}

function extractFirefoxWsUrl(payload: Record<string, unknown> | unknown[]): string | null {
  if (Array.isArray(payload)) {
    const first = payload[0];
    if (first && typeof first === 'object') {
      const url = (first as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
      return typeof url === 'string' && url.trim() ? url.trim() : null;
    }
    return null;
  }

  const url = payload.webSocketDebuggerUrl;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

export async function resolveFirefoxWebSocketUrl(
  host: string,
  port: number,
  timeoutMs: number
): Promise<string> {
  const directWs = `ws://${host}:${port}`;
  const sessionWs = `ws://${host}:${port}/session`;
  const jsonUrl = `http://${host}:${port}/json`;
  const deadline = Date.now() + timeoutMs;

  if (await probeWebSocketUrl(directWs, 1000)) {
    return directWs;
  }

  while (Date.now() < deadline) {
    try {
      const payload = await requestJson(jsonUrl, 1500);
      const discovered = extractFirefoxWsUrl(payload);
      if (discovered) {
        return discovered;
      }
    } catch {
      // keep polling until timeout
    }

    await sleep(250);
  }

  if (await probeWebSocketUrl(sessionWs, 1000)) {
    return sessionWs;
  }
  if (await probeWebSocketUrl(directWs, 1000)) {
    return directWs;
  }

  throw new Error(`Timed out resolving Firefox BiDi WebSocket from ${jsonUrl}`);
}
