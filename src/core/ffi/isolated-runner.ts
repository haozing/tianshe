import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFIError } from './errors';
import type { FFIIsolatedCallRequest, FFIIsolatedCallRunner } from './types';
import { getUnknownErrorMessage, toError } from '../../utils/error-message';
import { createLogger } from '../logger';

const logger = createLogger('FFIIsolatedRunner');

interface IsolatedWorkerSuccessMessage {
  type: 'result';
  result: unknown;
}

interface IsolatedWorkerErrorMessage {
  type: 'error';
  message: string;
  code?: string;
  stack?: string;
}

type IsolatedWorkerMessage = IsolatedWorkerSuccessMessage | IsolatedWorkerErrorMessage;

export class ChildProcessFFIIsolatedCallRunner implements FFIIsolatedCallRunner {
  constructor(private readonly workerPath = resolveDefaultWorkerPath()) {}

  run(request: FFIIsolatedCallRequest, options: { timeoutMs: number }): Promise<unknown> {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

    return new Promise((resolve, reject) => {
      let child: ChildProcess | null = null;
      let settled = false;
      let stdout = '';
      let stderr = '';

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const killChild = () => {
        if (!child || child.killed) return;
        try {
          child.kill('SIGKILL');
        } catch (error: unknown) {
          logger.warn('Failed to kill isolated FFI child process', {
            errorMessage: getUnknownErrorMessage(error),
          });
        }
      };

      const timeout = setTimeout(() => {
        finish(() => {
          killChild();
          reject(
            new FFIError(
              `FFI isolated call timed out after ${timeoutMs}ms`,
              'CALL_TIMEOUT'
            )
          );
        });
      }, timeoutMs);

      try {
        child = fork(this.workerPath, [], {
          execArgv: [],
          serialization: 'advanced',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      } catch (error: unknown) {
        finish(() => {
          reject(
            new FFIError(
              `Failed to start isolated FFI worker: ${getUnknownErrorMessage(error)}`,
              'ISOLATED_WORKER_START_FAILED',
              toError(error)
            )
          );
        });
        return;
      }

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('message', (message: IsolatedWorkerMessage) => {
        finish(() => {
          if (message?.type === 'result') {
            resolve(message.result);
            return;
          }

          const errorMessage =
            message?.type === 'error'
              ? message.message
              : 'Isolated FFI worker returned an invalid response';
          const error = new FFIError(errorMessage, message?.code || 'CALL_FAILED');
          if (message?.stack) {
            error.stack = message.stack;
          }
          reject(error);
        });
      });

      child.on('error', (error) => {
        finish(() => {
          reject(
            new FFIError(
              `Isolated FFI worker error: ${error.message}`,
              'ISOLATED_WORKER_ERROR',
              error
            )
          );
        });
      });

      child.on('exit', (code, signal) => {
        finish(() => {
          const details = [
            `code=${code ?? 'null'}`,
            `signal=${signal ?? 'null'}`,
            stdout ? `stdout=${stdout.slice(-500)}` : '',
            stderr ? `stderr=${stderr.slice(-500)}` : '',
          ].filter(Boolean);
          reject(
            new FFIError(
              `Isolated FFI worker exited before returning a result (${details.join(', ')})`,
              'ISOLATED_WORKER_EXITED'
            )
          );
        });
      });

      child.send(request, (error) => {
        if (!error) return;
        finish(() => {
          reject(
            new FFIError(
              `Failed to send isolated FFI request: ${error.message}`,
              'ISOLATED_WORKER_SEND_FAILED',
              error
            )
          );
        });
      });
    });
  }
}

function resolveDefaultWorkerPath(): string {
  const candidates: string[] = [];

  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist',
        'core',
        'ffi',
        'isolated-worker.js'
      ),
      path.join(process.resourcesPath, 'app.asar', 'dist', 'core', 'ffi', 'isolated-worker.js')
    );
  }

  candidates.push(path.join(__dirname, 'isolated-worker.js'));

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 5000;
  }
  return Math.max(1, Math.trunc(value));
}
